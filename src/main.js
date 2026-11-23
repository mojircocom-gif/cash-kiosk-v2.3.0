"use strict";
const { app, BrowserWindow, session, Menu, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const COORDINATION_BASE_URL = "http://Jahromi-PC:5005";
const COORDINATION_TIMEOUT_MS = 8000;
const COORDINATION_ACTIONS = new Set([
  "lock/status",
  "lock/acquire",
  "lock/release",
  "lock/halt",
  "lock/operator-release"
]);

const START_URL = "https://sso.itsaman.ir/login";
const KIOSK_URL = "https://itsaman.ir/dashboard/VaarizBardaashtSandogh";
const PARTITION = "persist:cash-kiosk-v2";
const ALLOWED_HOSTS = new Set(["sso.itsaman.ir", "itsaman.ir"]);
const KIOSK_SCRIPT = path.join(__dirname, "cash-kiosk.js");
const PRELOAD_SCRIPT = path.join(__dirname, "preload.js");
const MAX_PRINT_PDF_BYTES = 25 * 1024 * 1024;

let mainWindow;
let injectionInProgress = false;
let injectedDocument = null;
let printWindow = null;
let printInProgress = false;

// ورودی اختصاصی NumPad بی‌سیم؛ فقط دستگاه Genius با VID/PID مشخص پذیرفته می‌شود.
let rawNumpadProcess = null;
let rawNumpadBuffer = "";
let numpadReady = false;
let rawNumpadDeviceAvailable = false;
const rawNumpadPressedKeys = new Set();

app.commandLine.appendSwitch("kiosk-printing");
app.commandLine.appendSwitch("disable-print-preview");

function isAllowed(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function isKioskPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "itsaman.ir" &&
      parsed.pathname.replace(/\/+$/, "") ===
      "/dashboard/VaarizBardaashtSandogh";
  } catch {
    return false;
  }
}

async function injectKiosk() {
  if (!mainWindow || mainWindow.isDestroyed() || injectionInProgress) return;
  const wc = mainWindow.webContents;
  const currentUrl = wc.getURL();
  if (!isKioskPage(currentUrl)) return;

  const documentKey = currentUrl + "|" + wc.getProcessId();
  if (injectedDocument === documentKey) return;

  injectionInProgress = true;
  try {
    const source = fs.readFileSync(KIOSK_SCRIPT, "utf8");
    await wc.executeJavaScript(source, true);
    injectedDocument = documentKey;
    console.log("[Cash Kiosk] Script injected:", currentUrl);
  } catch (error) {
    console.error("[Cash Kiosk] Injection failed:", error);
  } finally {
    injectionInProgress = false;
  }
}


function getCoordinationIdentity() {
  const identityFile = path.join(app.getPath("userData"), "coordination-client.json");
  fs.mkdirSync(path.dirname(identityFile), { recursive: true });

  let identity = null;
  try {
    identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  } catch {}

  if (!identity || typeof identity.clientId !== "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(identity.clientId)) {
    identity = { clientId: crypto.randomUUID() };
    fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }

  return {
    clientId: identity.clientId,
    deviceName: os.hostname()
  };
}

async function coordinationRequest(action, body = {}) {
  if (!COORDINATION_ACTIONS.has(action)) {
    throw new Error("عملیات هماهنگی مجاز نیست");
  }

  const tokenFile = path.join(
    process.env.ProgramData || "C:\\ProgramData",
    "CashKiosk",
    "server-token"
  );
  let token = String(process.env.CASH_KIOSK_SERVER_TOKEN || "");
  try {
    if (!token && fs.existsSync(tokenFile)) {
      token = fs.readFileSync(tokenFile, "utf8").trim();
    }
  } catch (error) {
    console.error("[Cash Kiosk] Cannot read coordination token file:", error);
  }
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("توکن امن سرور هماهنگی روی این ویندوز تنظیم نشده است");
  }

  const identity = getCoordinationIdentity();
  const method = action === "lock/status" ? "GET" : "POST";
  const response = await fetch(
    COORDINATION_BASE_URL + "/api/v1/" + action,
    {
      method,
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: method === "POST"
        ? JSON.stringify({ ...body, ...identity })
        : undefined,
      signal: AbortSignal.timeout(COORDINATION_TIMEOUT_MS),
      cache: "no-store"
    }
  );

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("پاسخ سرور هماهنگی قابل خواندن نیست");
  }

  return {
    httpStatus: response.status,
    ok: response.ok && data?.ok === true,
    data
  };
}

async function ensureCoordinationServer() {
  if (process.env.CASH_KIOSK_ROLE !== "server") return;

  const tokenFile = path.join(
    process.env.ProgramData || "C:\\ProgramData",
    "CashKiosk",
    "server-token"
  );
  let token = String(process.env.CASH_KIOSK_SERVER_TOKEN || "");
  try {
    if (!token && fs.existsSync(tokenFile)) {
      token = fs.readFileSync(tokenFile, "utf8").trim();
    }
  } catch {}

  if (Buffer.byteLength(token, "utf8") < 32) {
    console.error("[Cash Kiosk] Server role selected but coordination token is missing.");
    return;
  }

  try {
    const health = await fetch(COORDINATION_BASE_URL + "/health", {
      signal: AbortSignal.timeout(1800),
      cache: "no-store"
    });
    if (health.ok) {
      const data = await health.json();
      if (data?.service === "cash-kiosk-coordination") {
        console.log("[Cash Kiosk] Existing central server is already running.");
        return;
      }
    }
  } catch {}

  const serverScript = app.isPackaged
    ? path.join(process.resourcesPath, "coordination-server.js")
    : path.join(__dirname, "coordination-server.js");

  if (!fs.existsSync(serverScript)) {
    console.error("[Cash Kiosk] Coordination server script not found:", serverScript);
    return;
  }

  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CASH_KIOSK_SERVER_TOKEN: token,
      CASH_KIOSK_SERVER_PORT: "5005"
    }
  });
  child.unref();
  console.log("[Cash Kiosk] Central coordination server launch requested.");
}

function registerCoordinationIpc() {
  ipcMain.handle("cash-kiosk:coordination", async (event, request) => {
    if (!mainWindow || mainWindow.isDestroyed() ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !isKioskPage(event.sender.getURL())) {
      throw new Error("درخواست هماهنگی از پنجره مجاز ارسال نشده است");
    }

    const action = String(request?.action || "");
    const body = request?.body && typeof request.body === "object"
      ? request.body
      : {};
    return coordinationRequest(action, body);
  });

  ipcMain.handle("cash-kiosk:coordination-identity", async event => {
    if (!mainWindow || mainWindow.isDestroyed() ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !isKioskPage(event.sender.getURL())) {
      throw new Error("درخواست هویت دستگاه از پنجره مجاز ارسال نشده است");
    }
    return getCoordinationIdentity();
  });
}

function registerRawNumpadIpc() {
  ipcMain.on("cash-kiosk:numpad-ready", (event, ready) => {
    if (!mainWindow || mainWindow.isDestroyed() ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !isKioskPage(event.sender.getURL())) {
      return;
    }
    numpadReady = ready === true;
    if (!numpadReady) rawNumpadPressedKeys.clear();
  });
}

function handleRawNumpadMessage(message) {
  if (!message || message.deviceId !== "VID_248A&PID_8367") return;

  const vk = Number(message.vk);
  const keyMap = {
    111: "/",   // NumPad Divide: بازگشت
    109: "-",   // NumPad Subtract: حذف رقم آخر
    107: "+",   // NumPad Add: آماده‌سازی
    106: "*"    // NumPad Multiply: پاک کردن رمز
  };
  const key = vk >= 96 && vk <= 105
    ? String(vk - 96)
    : keyMap[vk];
  if (!key) return;

  const keyId = String(vk);
  if (message.phase === "up") {
    rawNumpadPressedKeys.delete(keyId);
    return;
  }
  if (message.phase !== "down" || rawNumpadPressedKeys.has(keyId)) return;

  // جلوگیری از ثبت چندباره یک کلید در اثر auto-repeat یا پیام تکراری.
  rawNumpadPressedKeys.add(keyId);

  if (!mainWindow || mainWindow.isDestroyed() ||
      !numpadReady ||
      !isKioskPage(mainWindow.webContents.getURL())) {
    return;
  }

  // RIDEV_INPUTSINK ورودی NumPad را حتی با فوکوس برنامه‌های مانیتورهای دیگر می‌گیرد.
  // عمداً هیچ شرطی برای mainWindow.isFocused وجود ندارد.
  mainWindow.webContents.send("cash-kiosk:numpad-input", key);
}

function startRawNumpadBridge() {
  if (process.platform !== "win32") return;

  const helperPath = app.isPackaged
    ? path.join(process.resourcesPath, "raw-numpad-helper.ps1")
    : path.join(__dirname, "raw-numpad-helper.ps1");
  if (!fs.existsSync(helperPath)) {
    console.error("[Cash Kiosk] Raw NumPad helper not found:", helperPath);
    if (process.env.CASH_KIOSK_ROLE === "client") {
      console.error("[Cash Kiosk] NumPad is required on this client; keyboard digits remain blocked.");
    }
    return;
  }

  const powershellPath = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
  );
  const child = spawn(
    fs.existsSync(powershellPath) ? powershellPath : "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy", "Bypass",
      "-File", helperPath
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  rawNumpadProcess = child;
  rawNumpadBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    rawNumpadBuffer += chunk;
    let newlineIndex;

    while ((newlineIndex = rawNumpadBuffer.indexOf("\n")) >= 0) {
      const line = rawNumpadBuffer.slice(0, newlineIndex).trim();
      rawNumpadBuffer = rawNumpadBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        const message = JSON.parse(line);
        if (message.type === "ready" || message.type === "device") {
          rawNumpadDeviceAvailable = message.deviceFound === true;
          if (!rawNumpadDeviceAvailable) rawNumpadPressedKeys.clear();
          console.log("[Cash Kiosk] Genius NumPad detected:", rawNumpadDeviceAvailable);
          if (!rawNumpadDeviceAvailable &&
              process.env.CASH_KIOSK_ROLE === "client") {
            console.warn("[Cash Kiosk] Required Genius NumPad is not detected; keyboard digits remain blocked.");
          }
        } else {
          handleRawNumpadMessage(message);
        }
      } catch (error) {
        console.warn("[Cash Kiosk] Ignored invalid Raw Input message:", error.message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    const detail = String(chunk).trim();
    if (detail) console.error("[Cash Kiosk] Raw NumPad helper:", detail);
  });

  child.on("error", error => {
    console.error("[Cash Kiosk] Cannot start Raw NumPad helper:", error);
    if (process.env.CASH_KIOSK_ROLE === "client") {
      console.error("[Cash Kiosk] NumPad is required on this client; keyboard digits remain blocked.");
    }
    if (rawNumpadProcess === child) rawNumpadProcess = null;
    rawNumpadDeviceAvailable = false;
  });

  child.on("exit", (code, signal) => {
    console.warn("[Cash Kiosk] Raw NumPad helper exited:", { code, signal });
    if (process.env.CASH_KIOSK_ROLE === "client") {
      console.error("[Cash Kiosk] NumPad helper stopped; keyboard digits remain blocked.");
    }
    if (rawNumpadProcess === child) rawNumpadProcess = null;
    rawNumpadDeviceAvailable = false;
    numpadReady = false;
    rawNumpadPressedKeys.clear();
  });
}

function registerSilentPdfPrinting() {
  ipcMain.handle("cash-kiosk:print-pdf", async (event, pdfBytes) => {
    if (!mainWindow || mainWindow.isDestroyed() ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !isKioskPage(event.sender.getURL())) {
      throw new Error("درخواست چاپ از پنجره مجاز ارسال نشده است");
    }

    if (printInProgress) {
      throw new Error("چاپ رسید دیگری در حال انجام است");
    }

    if (!(pdfBytes instanceof ArrayBuffer) ||
        pdfBytes.byteLength < 5 ||
        pdfBytes.byteLength > MAX_PRINT_PDF_BYTES) {
      throw new Error("اندازه یا قالب فایل PDF معتبر نیست");
    }

    const pdfBuffer = Buffer.from(pdfBytes);
    if (pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("محتوای ارسالی فایل PDF معتبر نیست");
    }

    printInProgress = true;
    let worker = null;

    try {
      const pdfDataUrl = "data:application/pdf;base64," +
        pdfBuffer.toString("base64");

      worker = new BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        autoHideMenuBar: true,
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          plugins: true
        }
      });
      printWindow = worker;

      await worker.loadURL(pdfDataUrl);
      await new Promise(resolve => setTimeout(resolve, 1200));

      if (worker.isDestroyed()) {
        throw new Error("پنجره آماده‌سازی رسید بسته شده است");
      }

      const printResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("پاسخ چاپگر در زمان مقرر دریافت نشد"));
        }, 45000);

        worker.webContents.print({
          silent: true,
          printBackground: true,
          // اندازه کاغذ رسید را صریحاً A6 تعیین می‌کنیم تا PDF روی A4 چیده نشود.
          pageSize: "A6"
        }, (success, failureReason) => {
          clearTimeout(timeout);
          if (success) {
            resolve({ success: true, printer: "Windows default printer" });
          } else {
            reject(new Error(failureReason || "ارسال رسید به چاپگر ناموفق بود"));
          }
        });
      });

      return printResult;
    } catch (error) {
      console.error("[Cash Kiosk] Silent PDF print failed:", error);
      throw error;
    } finally {
      if (worker && !worker.isDestroyed()) worker.close();
      if (printWindow === worker) printWindow = null;
      printInProgress = false;
    }
  });
}

function createWindow() {
  const kioskSession = session.fromPartition(PARTITION);
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: "#050505",
    fullscreen: true,
    kiosk: true,
    webPreferences: {
      partition: PARTITION,
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);

  // در نقش client یا هنگام شناسایی دانگل، رویدادهای legacy ارقام مسدود می‌شوند.
  // ارقام مجاز فقط از پل Raw Input و دستگاه Genius وارد renderer می‌شوند.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const numpadOnlyMode =
      process.env.CASH_KIOSK_ROLE === "client" || rawNumpadDeviceAvailable;

    if (!numpadOnlyMode ||
        !isKioskPage(mainWindow?.webContents.getURL() || "")) return;

    const key = String(input.key || "");
    const code = String(input.code || "");
    if (/^[0-9]$/.test(key) ||
        /^(Digit|Numpad)[0-9]$/.test(code) ||
        /^Numpad(?:Divide|Subtract|Add|Multiply)$/.test(code)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) {
      // SSO ممکن است پنجره جدید بخواهد؛ آن را در همان پنجره باز می‌کنیم.
      setImmediate(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url);
      });
    } else {
      console.warn("[Cash Kiosk] Blocked popup:", url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      console.warn("[Cash Kiosk] Blocked navigation:", url);
    }
  });

  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      console.warn("[Cash Kiosk] Blocked redirect:", url);
    }
  });

  const checkAndInject = () => {
    if (isKioskPage(mainWindow?.webContents.getURL() || "")) {
      // کمی مکث برای آماده شدن ماژول‌های SPA و DOM
      setTimeout(injectKiosk, 700);
    } else {
      injectedDocument = null;
    }
  };

  mainWindow.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      injectedDocument = null;
      numpadReady = false;
      rawNumpadPressedKeys.clear();
    }
  });

  mainWindow.webContents.on("did-finish-load", checkAndInject);
  mainWindow.webContents.on("did-navigate", checkAndInject);
  mainWindow.webContents.on("did-navigate-in-page", checkAndInject);

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      console.error("[Cash Kiosk] Page load failed:", { code, description, url });
    }
  });

  mainWindow.webContents.on("dom-ready", checkAndInject);

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    injectedDocument = null;
    numpadReady = false;
    rawNumpadPressedKeys.clear();
    console.error("[Cash Kiosk] Renderer exited:", details);
  });

  mainWindow.webContents.on("did-create-window", child => {
    child.close();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    injectedDocument = null;
    numpadReady = false;
    rawNumpadPressedKeys.clear();
  });

  kioskSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "fullscreen");
  });

  mainWindow.loadURL(START_URL);

  // ثبت فهرست چاپگرهای ویندوز برای عیب‌یابی.
  mainWindow.webContents.once("did-finish-load", async () => {
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      console.log("[Cash Kiosk] Windows printers:", printers.map(p => ({
        name: p.name, isDefault: p.isDefault, status: p.status
      })));
    } catch (error) {
      console.error("[Cash Kiosk] Printer enumeration failed:", error);
    }
  });
}

const hasSingleInstance = app.requestSingleInstanceLock();

if (!hasSingleInstance) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    await ensureCoordinationServer();
    registerSilentPdfPrinting();
    registerCoordinationIpc();
    registerRawNumpadIpc();
    createWindow();
    startRawNumpadBridge();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  numpadReady = false;
  rawNumpadPressedKeys.clear();

  if (rawNumpadProcess && !rawNumpadProcess.killed) {
    try { rawNumpadProcess.kill(); } catch {}
    rawNumpadProcess = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.stop();
  }
});
