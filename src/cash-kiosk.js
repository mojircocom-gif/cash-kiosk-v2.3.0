
(async () => {
  // ==================================================
  // CASH KIOSK v2.2
  // پرداخت ایمن + چاپ غیرمسدودکننده
  // ==================================================

  window.cashKioskInstance?.cleanup?.();
  document.getElementById("cash-kiosk-root")?.remove();

  const BRANCH = "1";
  const SANDOGH_ID = "5";

  const PAID_OR_BLOCKED_IDS = new Set(["8085", "8087"]);

  const REFRESH_INTERVAL = 600000;
  const REQUEST_LIST_TIMEOUT = 120000;
  const MAX_LIST_AGE = 180000;

  const RETRY_BASE_DELAY = 60000;
  const RETRY_MAX_DELAY = 300000;
  const CONNECTION_INTERVAL = 120000;

  const LEDGER_ATTEMPTS = 10;
  const LEDGER_DELAY = 1500;

  const PAYMENT_SUCCESS_DISPLAY_MS = 2000;
  const PRINT_FRAME_LIFETIME = 180000;

  // ==================================================
  // تاریخ شمسی
  // ==================================================

  function getTodayParts() {
    const parts = new Intl.DateTimeFormat(
      "en-US-u-ca-persian-nu-latn",
      {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(new Date());

    const get = type => parts.find(x => x.type === type)?.value;

    return {
      year: get("year"),
      month: get("month"),
      day: get("day")
    };
  }

  function getTodaySlash() {
    const p = getTodayParts();
    return `${p.year}/${p.month}/${p.day}`;
  }

  function getTodayCompact() {
    const p = getTodayParts();
    return `${p.year}${p.month}${p.day}`;
  }

  const TODAY_DATE = getTodaySlash();

  const FROM_DATE = TODAY_DATE;
  const TO_DATE = TODAY_DATE;

  console.log("CASH KIOSK DATE:", {
    today: TODAY_DATE,
    from: FROM_DATE,
    to: TO_DATE
  });

  // ==================================================
  // بارگذاری API سامانه
  // ==================================================

  const api = await import("/dashboard/assets/index-BDPVFhJN.js");

  if (!api.h?.post || !api.h?.get) {
    throw new Error("API سامانه در دسترس نیست");
  }

  // ==================================================
  // ابزارهای عمومی
  // ==================================================

  function normalizeDigits(value) {
    return String(value || "")
      .replace(/[۰-۹]/g, d =>
        "0123456789"["۰۱۲۳۴۵۶۷۸۹".indexOf(d)]
      )
      .replace(/[٠-٩]/g, d =>
        "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]
      );
  }

  function normalizeDate(value) {
    return normalizeDigits(value).replace(/\D/g, "");
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/ي/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/[\u200c\u200f\u200e]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function getUpdateTime() {
    return new Intl.DateTimeFormat("fa-IR", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date());
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================================================
  // رابط کاربری
  // ==================================================

  const root = document.createElement("div");
  root.id = "cash-kiosk-root";

  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    background: "#050505",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "Tahoma, sans-serif",
    direction: "rtl",
    overflowY: "auto",
    boxSizing: "border-box",
    padding: "12px"
  });

  root.innerHTML = `
    <button id="ck-fullscreen" style="
      position:fixed;top:12px;left:12px;z-index:2147483647;
      padding:11px 17px;background:#245b91;color:white;
      border:1px solid #548bc2;border-radius:9px;font-size:14px;
      font-weight:bold;cursor:pointer;display:none;
    ">⛶ تمام صفحه</button>

    <main class="ck-shell">
      <header class="ck-header">
        <div class="ck-title">کیوسک پرداخت صندوق v2.3</div>
        <div class="ck-subtitle">سامانه دریافت و پرداخت درخواست‌های صندوق</div>
      </header>

      <div class="ck-main">
        <section class="ck-entry">
          <div id="ck-connection" class="ck-connection">
            در حال بررسی اتصال به سامانه...
          </div>

          <div id="ck-status" class="ck-status">
            در حال دریافت درخواست‌های امروز...
          </div>

          <div class="ck-password-title">رمز شش رقمی</div>

          <input
            id="ck-password"
            name="cash_kiosk_code"
            type="text"
            readonly
            inputmode="numeric"
            maxlength="6"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label="رمز شش رقمی"
            class="ck-password"
          >

          <div id="ck-keypad" class="ck-keypad">
            <button data-key="1" class="ck-number">1</button>
            <button data-key="2" class="ck-number">2</button>
            <button data-key="3" class="ck-number">3</button>
            <button data-key="4" class="ck-number">4</button>
            <button data-key="5" class="ck-number">5</button>
            <button data-key="6" class="ck-number">6</button>
            <button data-key="7" class="ck-number">7</button>
            <button data-key="8" class="ck-number">8</button>
            <button data-key="9" class="ck-number">9</button>
            <button data-key="-" class="ck-special">- حذف رقم</button>
            <button data-key="0" class="ck-number">0</button>
            <button data-key="*" class="ck-special">* پاک کردن</button>
            <button data-key="/" class="ck-special">/ بازگشت</button>
            <span class="ck-empty"></span>
            <button id="ck-prepare" data-key="+" class="ck-special ck-prepare">+ آماده‌سازی</button>
          </div>
        </section>

        <aside class="ck-guidance">
          <section class="ck-guide-card">
            <div class="ck-section-title">راهنمای کلیدها</div>
            <div class="ck-guide-row"><b>-</b><span>حذف آخرین رقم</span></div>
            <div class="ck-guide-row"><b>*</b><span>پاک کردن کامل رمز</span></div>
            <div class="ck-guide-row"><b>/</b><span>بازگشت به صفحه آماده دریافت رمز</span></div>
            <div class="ck-guide-row"><b>+</b><span>پاک کردن پیام و آماده‌سازی</span></div>
            <div class="ck-guide-note">با ورود رقم ششم، رمز با فهرست آماده بررسی می‌شود.</div>
          </section>

          <div id="ck-result" class="ck-result" aria-live="polite"></div>

          <div id="ck-count" class="ck-count">
            در حال دریافت درخواست‌های امروز...
          </div>

          <div id="ck-updated" class="ck-updated">
            آخرین دریافت درخواست‌ها: هنوز انجام نشده
          </div>
        </aside>
      </div>

      <footer class="ck-footer">
        پرداخت فقط پس از تطبیق رمز با درخواست معتبر انجام می‌شود.
      </footer>
    </main>

    <style>
      #cash-kiosk-root, #cash-kiosk-root * { box-sizing:border-box; }

      #cash-kiosk-root .ck-shell {
        width:min(1180px,96vw);
        height:min(820px,94vh);
        min-height:570px;
        margin:auto;
        padding:24px 28px 16px;
        display:grid;
        grid-template-rows:auto minmax(0,1fr) auto;
        gap:18px;
        background:#171717;
        border:1px solid #444;
        border-radius:18px;
        box-shadow:0 12px 55px #000;
        text-align:center;
        overflow:auto;
      }

      #cash-kiosk-root .ck-header {
        padding-bottom:14px;
        border-bottom:1px solid #393939;
      }

      #cash-kiosk-root .ck-title {
        font-size:28px;font-weight:800;letter-spacing:.2px;
      }

      #cash-kiosk-root .ck-subtitle {
        margin-top:7px;color:#aaa;font-size:13px;
      }

      #cash-kiosk-root .ck-main {
        min-height:0;
        display:grid;
        grid-template-columns:minmax(0,1fr) minmax(330px,.92fr);
        gap:24px;
        direction:rtl;
      }

      #cash-kiosk-root .ck-entry {
        min-width:0;
        display:flex;
        flex-direction:column;
        justify-content:center;
        padding:8px 12px;
      }

      #cash-kiosk-root .ck-connection {
        padding:11px 14px;margin-bottom:10px;
        background:#252525;border:1px solid #555;border-radius:9px;
        font-size:15px;font-weight:bold;color:#ffcc66;
      }

      #cash-kiosk-root .ck-status {
        min-height:52px;padding:12px 14px;margin-bottom:20px;
        display:flex;align-items:center;justify-content:center;
        background:#252525;border:1px solid #444;border-radius:9px;
        line-height:1.8;font-size:15px;
      }

      #cash-kiosk-root .ck-password-title {
        margin-bottom:10px;font-size:20px;font-weight:bold;
      }

      #cash-kiosk-root .ck-password {
        display:block;width:min(100%,520px);margin:0 auto 17px;
        padding:14px;background:#080808;color:#fff;
        border:2px solid #777;border-radius:10px;
        font-size:34px;text-align:center;letter-spacing:14px;outline:none;
      }

      #cash-kiosk-root .ck-password:focus { border-color:#70a9e8; }

      #cash-kiosk-root .ck-keypad {
        width:min(100%,520px);margin:0 auto;
        display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;
      }

      #cash-kiosk-root .ck-number,
      #cash-kiosk-root .ck-special {
        min-width:0;height:62px;border-radius:9px;
        color:#fff;font-weight:bold;cursor:pointer;
      }

      #cash-kiosk-root .ck-number {
        background:#303d50;border:1px solid #53677f;font-size:27px;
      }

      #cash-kiosk-root .ck-special {
        background:#49352b;border:1px solid #795644;font-size:14px;
      }

      #cash-kiosk-root .ck-prepare {
        background:#245b43;border-color:#397e5c;
      }

      #cash-kiosk-root button:disabled {
        opacity:.55;cursor:not-allowed;
      }

      #cash-kiosk-root .ck-guidance {
        min-width:0;display:flex;flex-direction:column;
        justify-content:center;gap:16px;
      }

      #cash-kiosk-root .ck-guide-card {
        padding:22px;background:#222;border:1px solid #393939;
        border-radius:12px;text-align:right;line-height:2.2;
        color:#ddd;font-size:16px;
      }

      #cash-kiosk-root .ck-section-title {
        margin-bottom:10px;color:#fff;font-size:20px;font-weight:bold;
      }

      #cash-kiosk-root .ck-guide-row {
        display:flex;align-items:flex-start;gap:12px;
        padding:3px 0;border-bottom:1px solid #333;
      }

      #cash-kiosk-root .ck-guide-row b {
        flex:0 0 30px;color:#f0c27a;font-size:18px;text-align:center;
      }

      #cash-kiosk-root .ck-guide-note {
        margin-top:12px;padding-top:10px;
        border-top:1px solid #444;color:#aaa;
      }

      #cash-kiosk-root .ck-result {
        min-height:42px;padding:8px 12px;
        border-radius:9px;line-height:1.9;font-size:14px;
        overflow-wrap:anywhere;
      }

      #cash-kiosk-root .ck-count {
        padding:13px;border-top:1px solid #393939;
        color:#eee;font-size:17px;font-weight:bold;line-height:1.8;
      }

      #cash-kiosk-root .ck-updated {
        color:#999;font-size:12px;
      }

      #cash-kiosk-root .ck-footer {
        padding-top:12px;border-top:1px solid #393939;
        color:#888;font-size:12px;
      }

      @media (max-width:760px) {
        #cash-kiosk-root .ck-shell {
          width:96vw;height:auto;min-height:0;max-height:96vh;
          padding:16px;gap:12px;
        }
        #cash-kiosk-root .ck-main {
          grid-template-columns:1fr;gap:12px;
        }
        #cash-kiosk-root .ck-entry { padding:4px 0; }
        #cash-kiosk-root .ck-guidance { gap:10px; }
        #cash-kiosk-root .ck-title { font-size:22px; }
        #cash-kiosk-root .ck-guide-card {
          padding:14px;font-size:14px;
        }
        #cash-kiosk-root .ck-number,
        #cash-kiosk-root .ck-special { height:52px; }
      }

      @media (max-height:700px) and (min-width:761px) {
        #cash-kiosk-root .ck-shell {
          padding:14px 22px 10px;gap:10px;
        }
        #cash-kiosk-root .ck-main { gap:14px; }
        #cash-kiosk-root .ck-status { margin-bottom:10px; }
        #cash-kiosk-root .ck-number,
        #cash-kiosk-root .ck-special { height:50px; }
        #cash-kiosk-root .ck-guide-card {
          padding:12px 18px;line-height:1.8;
        }
      }
    </style>
  `;

  document.body.appendChild(root);

  const $ = id => root.querySelector("#" + id);
  const passwordInput = $("ck-password");

  // ==================================================
  // متغیرهای عملیاتی
  // ==================================================

  let requests = [];
  let hasLoadedRequests = false;
  let lastSuccessfulFetchAt = 0;

  let busy = false;
  let destroyed = false;
  let paymentHalted = false;
  let currentLockId = null;

  let connectionTimer = null;
  let requestRefreshTimer = null;
  let fullscreenRetryTimer = null;
  let receiptResetTimer = null;
  let lockNoticeTimer = null;
  let unregisterNumpad = null;

  let lastAttemptedPassword = "";
  let operationGeneration = 0;

  let checkingConnection = false;
  let loadingRequests = false;
  let isConnected = false;

  let refreshFailureCount = 0;

  // درخواست‌های پرداخت‌شده یا دارای نتیجه نامشخص
  const paidRequestIds = new Set();
  const uncertainRequestIds = new Set();

  // منابع چاپ در حال اجرا
  const activePrintFrames = new Set();
  const activePrintUrls = new Set();

  // ==================================================
  // وضعیت رابط
  // ==================================================

  function status(message) {
    if (!destroyed) $("ck-status").textContent = message;
  }

  function result(message, color = "#fff") {
    if (destroyed) return;
    $("ck-result").style.color = color;
    $("ck-result").innerHTML = message;
  }

  function updateConnection(connected) {
    isConnected = connected;

    const element = $("ck-connection");

    if (connected) {
      element.textContent = "● اتصال به سامانه برقرار است";
      element.style.color = "#70e090";
      element.style.borderColor = "#39784b";
      element.style.background = "#14251a";
    } else {
      element.textContent = "● ارتباط با سامانه قطع است";
      element.style.color = "#ff7777";
      element.style.borderColor = "#884444";
      element.style.background = "#2a1515";
    }
  }

  function updateCount() {
    $("ck-count").textContent =
      `تعداد درخواست‌های آماده پرداخت: ${requests.length}`;
  }

  function focusPassword() {
    if (!busy && !paymentHalted && !destroyed && !passwordInput.disabled) {
      passwordInput.focus({ preventScroll: true });
    }
  }

  function isRequestListFresh() {
    return (
      hasLoadedRequests &&
      lastSuccessfulFetchAt > 0 &&
      Date.now() - lastSuccessfulFetchAt <= MAX_LIST_AGE
    );
  }

  function isRequestBlocked(id) {
    const key = String(id);

    return (
      PAID_OR_BLOCKED_IDS.has(key) ||
      paidRequestIds.has(key) ||
      uncertainRequestIds.has(key)
    );
  }

  // ==================================================
  // زمان‌بندی دریافت فهرست
  // ==================================================

  function scheduleNextRefresh(delay) {
    if (destroyed) return;

    if (requestRefreshTimer) {
      clearTimeout(requestRefreshTimer);
    }

    requestRefreshTimer = setTimeout(() => {
      requestRefreshTimer = null;

      if (destroyed) return;

      if (busy || loadingRequests) {
        scheduleNextRefresh(30000);
        return;
      }

      refreshRequests(true);
    }, delay);
  }

  // ==================================================
  // بررسی اتصال
  // ==================================================

  async function checkConnection() {
    if (destroyed || checkingConnection) return;

    checkingConnection = true;

    try {
      const url =
        `${api.af}/${BRANCH}/VaarizBardaashtSandogh/get_list_sandogh`;

      const response = await api.h.get(url, { timeout: 20000 });

      if (destroyed) return;

      if (!Array.isArray(response.data)) {
        throw new Error("پاسخ بررسی اتصال معتبر نیست");
      }

      updateConnection(true);

      if (!busy && !paymentHalted && isRequestListFresh()) {
        status("سامانه آماده دریافت رمز است");
      }

    } catch (error) {
      console.error("Connection check error:", error);

      if (!destroyed) {
        updateConnection(false);

        if (!busy && !isRequestListFresh()) {
          status("در انتظار برقراری ارتباط با سامانه...");
        }
      }

    } finally {
      checkingConnection = false;
    }
  }

  // ==================================================
  // دریافت درخواست‌های امروز
  // ==================================================

  async function refreshRequests(silent = false, force = false) {
    if (destroyed || loadingRequests || (busy && !force)) {
      return false;
    }

    loadingRequests = true;
    let succeeded = false;

    if (!hasLoadedRequests && !silent) {
      status(`در حال دریافت درخواست‌های امروز (${TODAY_DATE})...`);
      $("ck-count").textContent = "در حال دریافت درخواست‌ها...";
    }

    try {
      const url =
        `${api.af}/${BRANCH}/VaarizBardaashtSandogh/get_list_wihtdraw_requests`;

      const response = await api.h.post(
        url,
        {
          from_date: FROM_DATE,
          to_date: TO_DATE
        },
        {
          timeout: REQUEST_LIST_TIMEOUT
        }
      );

      if (destroyed) return false;

      if (!Array.isArray(response.data)) {
        throw new Error("ساختار پاسخ فهرست معتبر نیست");
      }

      const candidates = response.data.filter(x =>
        x.is_deleted === false &&
        x.sandogh_transaction_id == null &&
        x.STATUS === "در انتظار پرداخت وجه" &&
        !isRequestBlocked(x.id)
      );

      requests = candidates;

      hasLoadedRequests = true;
      lastSuccessfulFetchAt = Date.now();

      refreshFailureCount = 0;
      succeeded = true;

      updateCount();

      $("ck-updated").textContent =
        `آخرین دریافت درخواست‌ها: ${getUpdateTime()}`;

      updateConnection(true);

      console.log("CASH KIOSK REFRESH SUCCESS:", {
        today: TODAY_DATE,
        total: response.data.length,
        candidates: requests.length,
        expiredIncluded: true,
        expired: requests.filter(x => x.is_expired === true).length,
        notExpired: requests.filter(x => x.is_expired === false).length,
        paidIds: [...paidRequestIds],
        uncertainIds: [...uncertainRequestIds],
        ids: requests.map(x => ({
          id: x.id,
          expired: x.is_expired,
          amount: x.amount,
          description: x.description
        }))
      });

      if (!busy && !paymentHalted) {
        status("سامانه آماده دریافت رمز است");
      }

      return true;

    } catch (error) {
      refreshFailureCount++;

      console.error("Request list refresh failed:", {
        error,
        failureCount: refreshFailureCount,
        today: TODAY_DATE
      });

      if (!hasLoadedRequests) {
        status("دریافت فهرست ناموفق بود؛ تلاش مجدد زمان‌بندی شد");

        $("ck-count").textContent =
          "هنوز فهرست معتبری دریافت نشده است";

      } else if (!busy && !paymentHalted) {
        status("خطای بروزرسانی؛ فهرست قبلی حفظ شده است");
      }

      return false;

    } finally {
      loadingRequests = false;

      if (!destroyed) {
        let nextDelay;

        if (succeeded) {
          nextDelay = REFRESH_INTERVAL;
        } else {
          const exponent = Math.min(refreshFailureCount - 1, 3);

          nextDelay = Math.min(
            RETRY_BASE_DELAY * Math.pow(2, exponent),
            RETRY_MAX_DELAY
          );
        }

        console.log("NEXT REQUEST LIST REFRESH:", {
          delaySeconds: nextDelay / 1000,
          failureCount: refreshFailureCount
        });

        scheduleNextRefresh(nextDelay);
      }
    }
  }

  // ==================================================
  // تمام صفحه
  // ==================================================

  async function enterFullscreen() {
    if (destroyed) return;

    try {
      if (!document.fullscreenElement) {
        await root.requestFullscreen();
      }
    } catch (error) {
      console.warn("Fullscreen request failed:", error);
      $("ck-fullscreen").style.display = "block";
    }
  }

  function updateFullscreenButton() {
    $("ck-fullscreen").style.display =
      document.fullscreenElement === root ? "none" : "block";
  }

  $("ck-fullscreen").addEventListener("click", async () => {
    await enterFullscreen();
    updateFullscreenButton();
  });

  function onFullscreenChange() {
    updateFullscreenButton();

    if (document.fullscreenElement === root) {
      focusPassword();
    }
  }

  document.addEventListener("fullscreenchange", onFullscreenChange);

  // ==================================================
  // ورود رمز
  // ==================================================

  function setPassword(value) {
    if (busy || paymentHalted || destroyed) return;

    value = normalizeDigits(value).replace(/\D/g, "").slice(0, 6);

    passwordInput.value = value;
    lastAttemptedPassword = "";

    focusPassword();

    if (value.length === 6) {
      lastAttemptedPassword = value;
      processPassword(value);
    }
  }

  function addDigit(digit) {
    if (busy || paymentHalted || destroyed) return;

    const current = normalizeDigits(passwordInput.value)
      .replace(/\D/g, "");

    if (current.length >= 6) return;

    setPassword(current + digit);
  }

  // فقط ارقام تأییدشده از Raw Input دانگل Genius به کادر رمز می‌رسند.
  const desktopBridge = window.cashKioskDesktop;
  if (desktopBridge?.onNumpadInput) {
    unregisterNumpad = desktopBridge.onNumpadInput(key => {
      const value = String(key);
      if (/^[0-9]$/.test(value)) {
        addDigit(value);
        return;
      }
      if (value === "-") deleteLastDigit();
      else if (value === "*") clearPassword();
      else if (value === "/") returnToReady();
      else if (value === "+") prepareInput();
    });
    desktopBridge.setNumpadReady?.(true);
  }

  function deleteLastDigit() {
    if (busy || paymentHalted || destroyed) return;

    const current = normalizeDigits(passwordInput.value)
      .replace(/\D/g, "");

    setPassword(current.slice(0, -1));
    result("");
  }

  function clearPassword() {
    if (busy || paymentHalted || destroyed) return;

    passwordInput.value = "";
    lastAttemptedPassword = "";

    result("");

    status(
      isRequestListFresh()
        ? "سامانه آماده دریافت رمز است"
        : "فهرست درخواست‌ها به‌روز نیست؛ در انتظار دریافت مجدد"
    );

    focusPassword();
  }

  function returnToReady() {
    if (busy || paymentHalted || destroyed) return;

    passwordInput.value = "";
    lastAttemptedPassword = "";

    result("");

    status(
      isRequestListFresh()
        ? "سامانه آماده دریافت رمز است"
        : "فهرست درخواست‌ها به‌روز نیست؛ در انتظار دریافت مجدد"
    );

    focusPassword();
  }

  function prepareInput() {
    if (busy || paymentHalted || destroyed) return;

    result("");

    status(
      isRequestListFresh()
        ? "سامانه آماده دریافت رمز است"
        : "فهرست درخواست‌ها به‌روز نیست؛ در انتظار دریافت مجدد"
    );

    focusPassword();
  }

  // ==================================================
  // حفظ آمادگی کادر رمز هنگام کلیک در صفحه کیوسک
  // ==================================================

  root.addEventListener("pointerdown", event => {
    const target = event.target;
    if (target instanceof Element &&
        !target.closest("button, input, textarea, select, a")) {
      focusPassword();
    }
  }, true);

  // ==================================================
  // کلیدهای روی صفحه
  // ==================================================

  $("ck-keypad").addEventListener("click", event => {
    const button = event.target.closest("button[data-key]");

    if (!button || busy || paymentHalted) return;

    const key = button.dataset.key;

    if (/^\d$/.test(key)) addDigit(key);
    else if (key === "-") deleteLastDigit();
    else if (key === "*") clearPassword();
    else if (key === "/") returnToReady();
    else if (key === "+") prepareInput();
  });

  // ==================================================
  // کیبورد فیزیکی
  // ==================================================

  function getPhysicalDigit(e) {
    if (/^[0-9]$/.test(e.key)) return e.key;

    const numpadMatch = /^Numpad([0-9])$/.exec(String(e.code || ""));
    return numpadMatch ? numpadMatch[1] : null;
  }

  // اگر دانگل اختصاصی متصل باشد، Electron ورودی legacy همه کیبوردها را پیش از renderer می‌بندد.
  // در دستگاه فاقد دانگل، مسیر عادی کیبورد برای حالت مدیر حفظ می‌شود.
  function handlePhysicalKeys(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      focusPassword();
      return;
    }

    if (busy || paymentHalted || destroyed) return;

    const digit = getPhysicalDigit(e);
    if (digit !== null) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      addDigit(digit);
      return;
    }


  }

  function isolateKeys(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return false;
    }
  }

  document.addEventListener("keydown", handlePhysicalKeys, true);
  document.addEventListener("keydown", isolateKeys, false);
  document.addEventListener("keyup", isolateKeys, true);

  // ==================================================
  // پاک‌سازی منابع
  // ==================================================

  function cleanup() {
    destroyed = true;
    operationGeneration++;

    if (connectionTimer) clearInterval(connectionTimer);
    if (requestRefreshTimer) clearTimeout(requestRefreshTimer);
    if (fullscreenRetryTimer) clearInterval(fullscreenRetryTimer);
    if (receiptResetTimer) clearTimeout(receiptResetTimer);
    if (lockNoticeTimer) clearTimeout(lockNoticeTimer);

    document.removeEventListener("keydown", handlePhysicalKeys, true);
    document.removeEventListener("keydown", isolateKeys, false);
    document.removeEventListener("keyup", isolateKeys, true);

    try { desktopBridge?.setNumpadReady?.(false); } catch {}
    try { unregisterNumpad?.(); } catch {}
    unregisterNumpad = null;

    document.removeEventListener("fullscreenchange", onFullscreenChange);

    for (const frame of activePrintFrames) {
      try { frame.remove(); } catch {}
    }

    for (const url of activePrintUrls) {
      try { URL.revokeObjectURL(url); } catch {}
    }

    activePrintFrames.clear();
    activePrintUrls.clear();

    root.remove();
  }

  window.cashKioskInstance = { cleanup };

  // ==================================================
  // تشخیص خطای رمز اشتباه
  // ==================================================

  function responseText(error) {
    const data = error?.response?.data;

    if (typeof data === "string") return data;

    if (data instanceof Blob) {
      return error?.message || "پاسخ نامشخص سرور";
    }

    try {
      return JSON.stringify(data || error?.message || "");
    } catch {
      return String(error?.message || "");
    }
  }

  function isWrongPassword(error) {
    const text = normalizeText(responseText(error));

    return (
      text.includes("پسوورد اشتباه است") ||
      text.includes("پسورد اشتباه است") ||
      text.includes("رمز عبور اشتباه است")
    );
  }

  // ==================================================
  // دریافت گردش صندوق
  // ==================================================

  async function getTodayLedger() {
    const today = getTodayCompact();

    const url =
      `${api.af}/${BRANCH}/VaarizBardaashtSandogh/` +
      `get_sandogh_io_list/${SANDOGH_ID}/${today}/${today}`;

    const response = await api.h.get(url, {
      timeout: 60000
    });

    const rows = response.data?.data;

    if (!Array.isArray(rows)) {
      throw new Error("ساختار پاسخ گردش صندوق معتبر نیست");
    }

    return { today, rows };
  }

  function findLedgerRecord(request, rows, paymentResponse) {
    const paymentData = paymentResponse?.data || {};

    const transactionId =
      paymentData.sandogh_transaction_id ??
      paymentData.transaction_id ??
      request.sandogh_transaction_id ??
      null;

    if (transactionId != null) {
      const matchesById = rows.filter(row =>
        String(row.id) === String(transactionId) &&
        row.confirmed === true
      );

      if (matchesById.length === 1) {
        return matchesById[0];
      }

      if (matchesById.length > 1) {
        throw new Error("شناسه تراکنش تکراری در گردش صندوق");
      }
    }

    const amount = Number(request.amount);
    const description = normalizeText(request.description);
    const today = getTodayCompact();

    const matches = rows.filter(row =>
      row.confirmed === true &&
      Number(row.out) === amount &&
      Number(row.out) > 0 &&
      normalizeText(row.description) === description &&
      normalizeDate(row.date) === today
    );

    if (matches.length === 0) return null;

    if (matches.length > 1) {
      throw new Error("چند رکورد مشابه پیدا شد؛ چاپ متوقف شد");
    }

    return matches[0];
  }

  async function waitForLedgerRecord(request, paymentResponse) {
    for (let attempt = 1; attempt <= LEDGER_ATTEMPTS; attempt++) {
      if (destroyed) {
        throw new Error("کیوسک بسته شده است");
      }

      console.log("LEDGER SEARCH:", {
        requestId: request.id,
        attempt,
        maximum: LEDGER_ATTEMPTS
      });

      const ledger = await getTodayLedger();

      const record = findLedgerRecord(
        request,
        ledger.rows,
        paymentResponse
      );

      if (record) return record;

      if (attempt < LEDGER_ATTEMPTS) {
        await sleep(LEDGER_DELAY);
      }
    }

    return null;
  }

  // ==================================================
  // چاپ مستقیم PDF از طریق پردازش اصلی Electron

  async function printReceipt(ledgerId) {
    const url =
      `${api.af}/${BRANCH}/VaarizBardaashtSandogh/` +
      `print_sandogh_io_recored/${ledgerId}`;

    const response = await api.h.get(url, {
      responseType: "blob",
      timeout: 60000
    });

    const blob = response.data;

    if (!(blob instanceof Blob) || blob.size === 0) {
      throw new Error("فایل PDF رسید معتبر نیست");
    }

    if (typeof window.cashKioskDesktop?.printPdf !== "function") {
      throw new Error("سرویس چاپ دسکتاپ در دسترس نیست");
    }

    const pdfArrayBuffer = await blob.arrayBuffer();
    const printResult = await window.cashKioskDesktop.printPdf(pdfArrayBuffer);

    console.log("SILENT PRINT COMPLETED:", {
      ledgerId,
      blobSize: blob.size,
      printer: printResult?.printer || "Windows default printer"
    });

    return {
      commandIssued: true,
      printAccepted: true,
      ledgerId
    };
  }

  // عملیات رسید در پس‌زمینه
  // ==================================================

  async function handleReceiptAfterPayment(request, paymentResponse) {
    try {
      console.log("BACKGROUND RECEIPT PROCESS STARTED:", request.id);

      const ledgerRecord = await waitForLedgerRecord(
        request,
        paymentResponse
      );

      if (!ledgerRecord) {
        throw new Error("رکورد پرداخت در گردش صندوق پیدا نشد");
      }

      console.log("LEDGER RECORD FOUND:", {
        requestId: request.id,
        ledgerId: ledgerRecord.id
      });

      const printResult = await printReceipt(ledgerRecord.id);

      console.log("RECEIPT PRINT COMMAND ISSUED:", {
        requestId: request.id,
        ledgerId: ledgerRecord.id,
        printResult
      });

    } catch (error) {
      console.error("BACKGROUND RECEIPT/PRINT ERROR:", {
        requestId: request.id,
        error
      });

      // خطای چاپ فقط گزارش می‌شود.
      // هرگز پرداخت را تکرار نمی‌کند و وضعیت پرداخت را تغییر نمی‌دهد.
    }
  }

  // ==================================================
  // بازگشت به حالت آماده پس از پرداخت موفق
  // ==================================================

  function scheduleReadyAfterPayment(requestId) {
    if (receiptResetTimer) {
      clearTimeout(receiptResetTimer);
    }

    receiptResetTimer = setTimeout(() => {
      receiptResetTimer = null;

      if (destroyed) return;

      result("");

      passwordInput.value = "";
      lastAttemptedPassword = "";

      busy = false;

      if (paymentHalted) {
        passwordInput.disabled = true;
        status("پرداخت‌ها به دلیل نتیجه نامشخص متوقف شده‌اند");
        return;
      }

      passwordInput.disabled = false;

      status(
        isRequestListFresh()
          ? "سامانه آماده دریافت رمز است"
          : "فهرست درخواست‌ها به‌روز نیست؛ در انتظار دریافت مجدد"
      );

      focusPassword();

      console.log("KIOSK RETURNED TO READY:", {
        requestId,
        delay: PAYMENT_SUCCESS_DISPLAY_MS
      });

      // دریافت مجدد فهرست پس از آزاد شدن کیوسک
      scheduleNextRefresh(500);

    }, PAYMENT_SUCCESS_DISPLAY_MS);
  }

  async function releaseCurrentLock(outcome) {
    if (!currentLockId) return true;
    const lockId = currentLockId;
    const response = await window.cashKioskDesktop.coordination("lock/release", {
      lockId,
      outcome
    });
    if (!response?.ok) {
      throw new Error(response?.data?.error || "آزادسازی قفل مرکزی ناموفق بود");
    }
    currentLockId = null;
    return true;
  }

  async function operatorReleaseSafely(lockId, reason) {
    const release = await window.cashKioskDesktop.coordination("lock/operator-release", {
      lockId,
      reviewed: true,
      reason
    });

    if (release?.ok) return release;

    // A previous release may have succeeded while its HTTP response was lost.
    // Confirm the central state before deciding that recovery failed.
    if (release?.httpStatus === 409) {
      const current = await window.cashKioskDesktop.coordination("lock/status");
      if (current?.ok && current.data?.lock == null) {
        return { ok: true, alreadyReleased: true, data: { released: true } };
      }
    }

    throw new Error(release?.data?.error || "آزادسازی قفل ناموفق بود");
  }

  function showStaleLockRecovery(lock) {
    currentLockId = lock?.lockId || null;
    if (!currentLockId) return;

    // قفل مرکزی را آزاد یا دور نمی‌زنیم؛ فقط نمایش هشدار پس از ۱۰ ثانیه جمع می‌شود.
    // ورودی مجدداً فعال می‌شود، اما هر تلاش پرداخت تا آزادسازی واقعی قفل توسط سرور رد خواهد شد.
    paymentHalted = false;
    passwordInput.disabled = false;
    status("قفل مرکزی فعال است؛ بررسی دستی لازم است");
    result(`
      <div style="color:#ffcc66;font-weight:bold;font-size:18px">قفل پرداخت موجود؛ بررسی دستی لازم است</div>
      <div>دستگاه ثبت‌شده: ${escapeHTML(lock.deviceName || "نامشخص")}</div>
      <div>وضعیت قفل: ${escapeHTML(lock.status || "نامشخص")}</div>
      <div>زمان اخذ قفل: ${escapeHTML(lock.acquiredAt || "نامشخص")}</div>
      <div style="margin-top:10px">ابتدا در سامان، درخواست‌ها و گردش صندوق را بررسی کنید. آزادسازی قفل هیچ پرداختی انجام نمی‌دهد.</div>
      <button id="ck-recovery-stale" style="margin:8px;padding:10px;background:#70452c;color:#fff;border:0;border-radius:6px">پس از بررسی، آزادسازی قفل</button>
    `, "#ffcc66");

    if (lockNoticeTimer) clearTimeout(lockNoticeTimer);
    lockNoticeTimer = setTimeout(() => {
      lockNoticeTimer = null;
      if (destroyed || currentLockId !== lock?.lockId) return;
      result("");
      status("سامانه آماده دریافت رمز است؛ قفل مرکزی هنوز فعال است");
      passwordInput.value = "";
      lastAttemptedPassword = "";
      passwordInput.disabled = false;
      focusPassword();
    }, 10000);

    $("ck-recovery-stale")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      if (button) button.disabled = true;
      if (!window.confirm("آیا دستگاه مالک قفل دیگر در حال اجرای پرداخت نیست و وضعیت درخواست‌ها و گردش صندوق را در سامان بررسی کرده‌اید؟")) {
        if (button) button.disabled = false;
        return;
      }
      const reason = window.prompt("شرح بررسی دستی را وارد کنید (حداقل ۵ نویسه):");
      if (!reason || reason.trim().length < 5) {
        window.alert("شرح بررسی معتبر نیست؛ قفل آزاد نشد.");
        if (button) button.disabled = false;
        return;
      }
      try {
        await operatorReleaseSafely(
          currentLockId,
          `stale-lock-recovery; ${reason.trim()}`
        );
        currentLockId = null;
        if (lockNoticeTimer) clearTimeout(lockNoticeTimer);
        lockNoticeTimer = null;
        paymentHalted = false;
        passwordInput.disabled = false;
        passwordInput.value = "";
        lastAttemptedPassword = "";
        status("قفل قدیمی آزاد شد؛ فهرست تازه دریافت می‌شود");
        result("فقط قفل آزاد شد؛ هیچ پرداختی ارسال یا تکرار نشد.", "#70e090");
        await refreshRequests(false);
        focusPassword();
      } catch (error) {
        console.error("Stale lock operator release failed:", error);
        if (button) button.disabled = false;
        status("آزادسازی قفل انجام نشد؛ قفل مرکزی همچنان فعال است");
        result(escapeHTML(error?.message || String(error)), "#ff7777");
      }
    });
  }

  function showOperatorRecovery(requestId, detail, knownPaid = false) {
    result(`
      <div style="color:#ffcc66;font-weight:bold;font-size:18px">نیاز به بررسی دستی</div>
      <div>شناسه درخواست: ${escapeHTML(requestId)}</div>
      <div>${escapeHTML(String(detail || "").slice(0, 350))}</div>
      <div style="margin-top:10px;color:#fff">ابتدا وضعیت همین درخواست را در سامانه سامان بررسی کنید.</div>
      <button id="ck-recovery-paid" style="margin:8px;padding:10px;background:#245b43;color:#fff;border:0;border-radius:6px">پرداخت انجام شده</button>
      ${knownPaid ? "" : '<button id="ck-recovery-unpaid" style="margin:8px;padding:10px;background:#70452c;color:#fff;border:0;border-radius:6px">پرداخت انجام نشده</button>'}
    `, "#ffcc66");

    const recover = async outcome => {
      if (!window.confirm("آیا وضعیت این درخواست را مستقیماً در سامانه سامان بررسی کرده‌اید؟")) return;
      const reason = window.prompt("شرح بررسی و نتیجه را وارد کنید (حداقل ۵ نویسه):");
      if (!reason || reason.trim().length < 5) {
        window.alert("شرح بررسی معتبر نیست؛ قفل آزاد نشد.");
        return;
      }

      try {
        await operatorReleaseSafely(
          currentLockId,
          `request=${requestId}; outcome=${outcome}; ${reason.trim()}`
        );

        if (outcome === "paid") {
          paidRequestIds.add(String(requestId));
        } else {
          uncertainRequestIds.delete(String(requestId));
        }

        currentLockId = null;
        paymentHalted = false;
        busy = false;
        passwordInput.value = "";
        lastAttemptedPassword = "";
        passwordInput.disabled = false;

        status(outcome === "paid"
          ? "پرداخت انجام‌شده تأیید شد؛ قفل آزاد شد"
          : "عدم انجام پرداخت تأیید شد؛ قفل آزاد شد. برای پرداخت، رمز جدید وارد کنید");
        result("قفل فقط آزاد شد؛ هیچ درخواست پرداختی مجدداً ارسال نشد.", "#70e090");
        await refreshRequests(false);
        focusPassword();
      } catch (error) {
        console.error("Operator recovery failed:", error);
        status("آزادسازی قفل انجام نشد");
        result(escapeHTML(error?.message || String(error)), "#ff7777");
      }
    };

    $("ck-recovery-paid")?.addEventListener("click", () => recover("paid"), { once: true });
    if (!knownPaid) {
      $("ck-recovery-unpaid")?.addEventListener("click", () => recover("unpaid"), { once: true });
    }
  }

  // ==================================================
  // عملیات پرداخت
  // ==================================================

  async function processPassword(password) {
    if (busy || paymentHalted || destroyed) return;
    if (!/^\d{6}$/.test(password)) return;

    const passwordProcessStartedAt = performance.now();
    busy = true;

    const generation = ++operationGeneration;

    passwordInput.disabled = true;

    result("");

    let paymentSucceeded = false;
    let paymentLockReleaseFailed = false;
    let shouldKeepLocked = false;

    try {
      if (!hasLoadedRequests) {
        status("فهرست درخواست‌ها هنوز دریافت نشده است");

        result(
          "هنوز فهرست معتبری از سرور دریافت نشده است.",
          "#ffbb66"
        );

        return;
      }

      status("در حال دریافت مجوز پرداخت از سرور مرکزی...");

      const acquireResult = await window.cashKioskDesktop.coordination("lock/acquire");
      if (!acquireResult?.ok) {
        const lock = acquireResult?.data?.lock;
        status("پرداخت در این دستگاه مجاز نیست");
        if (lock) {
          showStaleLockRecovery(lock);
        } else {
          result(
            lock
              ? `قفل پرداخت در اختیار دستگاه ${escapeHTML(lock.deviceName || "دیگر")} است. وضعیت: ${escapeHTML(lock.status || "نامشخص")}`
              : escapeHTML(acquireResult?.data?.error || "ارتباط با سرور مرکزی برقرار نشد"),
            "#ffbb66"
          );
        }
        return;
      }

      currentLockId = acquireResult.data?.lock?.lockId || null;
      if (!currentLockId) {
        paymentHalted = true;
        status("شناسه قفل معتبر دریافت نشد؛ پرداخت متوقف شد");
        result("برای جلوگیری از پرداخت بدون قفل مرکزی، عملیات انجام نشد.", "#ff7777");
        return;
      }

      status("قفل مرکزی دریافت شد؛ در حال دریافت فهرست تازه از سامان...");
      const freshListLoaded = await refreshRequests(false, true);
      if (!freshListLoaded) {
        await releaseCurrentLock("cancelled-before-payment");
        status("دریافت فهرست تازه ناموفق بود؛ پرداخت انجام نشد");
        result("هیچ پرداختی ارسال نشد. پس از برقراری ارتباط دوباره تلاش کنید.", "#ffbb66");
        return;
      }

      const currentRequests = [...requests];
      updateCount();

      if (!currentRequests.length) {
        await releaseCurrentLock("no-match");
        status("درخواستی برای پرداخت وجود ندارد");

        result(
          "در حال حاضر درخواست آماده پرداختی موجود نیست",
          "#ffbb66"
        );

        return;
      }

      status(
        `تعداد ${currentRequests.length} درخواست آماده است؛ در حال بررسی رمز...`
      );

      let wrongPasswordCount = 0;
      const passwordScanStartedAt = performance.now();

      for (let i = 0; i < currentRequests.length; i++) {
        if (
          destroyed ||
          generation !== operationGeneration ||
          paymentHalted
        ) {
          return;
        }

        const request = currentRequests[i];

        if (isRequestBlocked(request.id)) {
          console.warn("BLOCKED REQUEST SKIPPED:", request.id);
          continue;
        }

        // کاهش به‌روزرسانی‌های غیرضروری رابط در اسکن طولانی؛
        // فراخوانی‌های پرداخت همچنان ترتیبی و ایمن باقی می‌مانند.
        if (i === 0 || (i + 1) % 5 === 0 || i === currentRequests.length - 1) {
          status(
            `در حال بررسی رمز برای درخواست ${i + 1} از ${currentRequests.length}`
          );
        }

        const requestCheckStartedAt = performance.now();
        let response;

        // --------------------------------------------------
        // بخش اول: فقط فراخوانی API پرداخت
        // خطای چاپ یا گردش صندوق در این try قرار ندارد.
        // --------------------------------------------------

        try {
          response = await api.h.post(
            `${api.af}/${BRANCH}/VaarizBardaashtSandogh/confirm_wihtdraw_requests`,
            {
              id: request.id,
              passwd: password
            }
          );

        } catch (paymentError) {
          if (isWrongPassword(paymentError)) {
            wrongPasswordCount++;

            console.log("EXPLICIT WRONG PASSWORD:", {
              requestId: request.id,
              wrongPasswordCount,
              responseTimeMs: Math.round(performance.now() - requestCheckStartedAt)
            });

            // تنها در این حالت مجاز به بررسی درخواست بعدی هستیم
            continue;
          }

          // --------------------------------------------------
          // خطای مبهم پرداخت: توقف کامل
          // --------------------------------------------------

          paymentHalted = true;
          shouldKeepLocked = true;

          uncertainRequestIds.add(String(request.id));

          try {
            await window.cashKioskDesktop.coordination("lock/halt", {
              lockId: currentLockId,
              reason: `Uncertain payment result for request ${request.id}`
            });
          } catch (haltError) {
            console.error("CENTRAL LOCK HALT FAILED; active lock remains fail-safe:", haltError);
          }

          requests = requests.filter(
            x => String(x.id) !== String(request.id)
          );

          updateCount();

          console.error("PAYMENT RESULT UNCERTAIN:", {
            requestId: request.id,
            error: paymentError,
            response: responseText(paymentError)
          });

          status("نتیجه عملیات نامشخص است؛ پرداخت‌ها متوقف شدند");

          result(`
            <div style="color:#ff7777;font-weight:bold;font-size:19px">
              عملیات متوقف شد
            </div>
            <div>شناسه درخواست: ${escapeHTML(request.id)}</div>
            <div>پاسخ سرور: ${escapeHTML(responseText(paymentError).slice(0, 500))}</div>
            <div style="color:#ffcc66">
              تا بررسی وضعیت این درخواست، رمز را مجدداً وارد نکنید.
            </div>
          `);

          passwordInput.disabled = true;
          showOperatorRecovery(request.id, responseText(paymentError));

          // هیچ درخواست دیگری بررسی نمی‌شود
          return;
        }

        // --------------------------------------------------
        // بخش دوم: پرداخت موفق و قطعی
        // --------------------------------------------------

        paymentSucceeded = true;

        const requestId = String(request.id);

        try {
          const releaseResult = await window.cashKioskDesktop.coordination("lock/release", {
            lockId: currentLockId,
            outcome: "payment-success"
          });
          if (!releaseResult?.ok) {
            throw new Error(releaseResult?.data?.error || "Central lock release failed");
          }
          currentLockId = null;
        } catch (releaseError) {
          // Payment already succeeded. Never submit it again because lock release failed.
          paymentHalted = true;
          shouldKeepLocked = true;
          paymentLockReleaseFailed = true;
          console.error("PAYMENT SUCCEEDED BUT CENTRAL LOCK RELEASE FAILED:", releaseError);
        }

        paidRequestIds.add(requestId);

        console.log("PAYMENT SUCCESS:", {
          requestId,
          response: response?.data
        });

        // حذف فوری درخواست از فهرست محلی
        requests = requests.filter(
          x => String(x.id) !== requestId
        );

        updateCount();

        passwordInput.value = "";

        status("پرداخت با موفقیت ثبت شد");

        result(`
          <div style="color:#70e090;font-weight:bold;font-size:20px">
            پرداخت با موفقیت ثبت شد
          </div>
          <div>شناسه درخواست: ${escapeHTML(request.id)}</div>
          <div>مبلغ: ${Number(request.amount).toLocaleString("fa-IR")} ریال</div>
          <div>در حال دریافت رسید...</div>
        `);

        // اگر آزادسازی قفل شکست خورد، رابط بازیابی باید باقی بماند.
        // در غیر این صورت کیوسک پس از نمایش کوتاه به حالت آماده برمی‌گردد.
        if (paymentLockReleaseFailed) {
          status("پرداخت ثبت شد؛ قفل مرکزی نیازمند بررسی و آزادسازی دستی است");
          showOperatorRecovery(requestId, "Payment succeeded; central lock release failed", true);
        } else {
          scheduleReadyAfterPayment(requestId);
        }

        // جست‌وجوی گردش صندوق و چاپ در پس‌زمینه
        // این تابع به نتیجه عملیات پرداخت دست نمی‌زند.
        void handleReceiptAfterPayment(request, response);

        // بعد از اولین پرداخت موفق، مطلقاً ادامه نمی‌دهیم
        return;
      }

      // تمام درخواست‌ها با پاسخ صریح رمز اشتباه رد شده‌اند
      if (!paymentSucceeded && !paymentHalted) {
        if (currentLockId) {
          await releaseCurrentLock("cancelled-before-payment");
        }
        status("رمز واردشده با درخواست‌ها مطابقت نداشت");

        result(
          "رمز اشتباه است؛ مجدداً رمز شش رقمی را وارد کنید",
          "#ff7777"
        );

        console.log("PASSWORD CHECK COMPLETED:", {
          checkedRequests: currentRequests.length,
          explicitWrongPasswordCount: wrongPasswordCount,
          scanElapsedMs: Math.round(performance.now() - passwordScanStartedAt),
          totalElapsedMs: Math.round(performance.now() - passwordProcessStartedAt)
        });
      }

    } catch (error) {
      console.error("Password processing error:", error);

      // Only release when no payment call could have been submitted.
      // Ambiguous payment failures are handled above and keep the lock.
      if (currentLockId && !paymentSucceeded && !paymentHalted) {
        try { await releaseCurrentLock("cancelled-before-payment"); }
        catch (releaseError) {
          console.error("Could not release pre-payment lock:", releaseError);
        }
      }

      status("خطا در عملیات");

      result(`
        <div style="color:#ff7777;font-weight:bold">
          خطا در بررسی رمز
        </div>
        <div>${escapeHTML(error?.message || String(error))}</div>
      `);

    } finally {
      if (!destroyed) {
        if (paymentSucceeded) {
          // تایمر مستقل، کیوسک را پس از ۲ ثانیه آزاد می‌کند.
          // این بخش نباید busy را تغییر دهد.
        } else if (shouldKeepLocked || paymentHalted) {
          busy = false;
          passwordInput.disabled = true;

        } else {
          busy = false;
          passwordInput.disabled = false;
          passwordInput.value = "";
          lastAttemptedPassword = "";
          focusPassword();
        }
      } else {
        busy = false;
      }
    }
  }

  // ==================================================
  // راه‌اندازی
  // ==================================================

  passwordInput.value = "";
  passwordInput.disabled = false;
  passwordInput.readOnly = true;

  status(`در حال دریافت اولیه درخواست‌های امروز (${TODAY_DATE})...`);

  checkConnection();
  refreshRequests(false);

  await enterFullscreen();

  updateFullscreenButton();

  if (destroyed) return;

  fullscreenRetryTimer = setInterval(() => {
    if (!destroyed && document.fullscreenElement !== root) {
      $("ck-fullscreen").style.display = "block";
    }
  }, 1000);

  focusPassword();

  connectionTimer = setInterval(() => {
    if (!busy && !destroyed && !checkingConnection) {
      checkConnection();
    }
  }, CONNECTION_INTERVAL);

  console.log("CASH KIOSK v2.2 READY:", {
    today: TODAY_DATE,
    fromDate: FROM_DATE,
    toDate: TO_DATE,

    requestListFetchedAtStartup: true,
    centralExclusivePaymentLock: true,
    freshSamanListAfterLockAcquire: true,
    centralLockNeverAutoExpires: true,
    requestListRefreshInterval: REFRESH_INTERVAL,
    requestListTimeout: REQUEST_LIST_TIMEOUT,
    maxListAge: MAX_LIST_AGE,

    expiredRequestsIncluded: true,
    blockedIdsExcluded: [...PAID_OR_BLOCKED_IDS],

    stopAfterFirstSuccessfulPayment: true,
    uncertainPaymentHaltsAllPayments: true,
    paidRequestsExcludedFromFutureLists: true,

    paymentSuccessDisplayMs: PAYMENT_SUCCESS_DISPLAY_MS,
    receiptProcessingRunsInBackground: true,
    printDoesNotWaitForAfterPrint: true,
    printFrameLifetime: PRINT_FRAME_LIFETIME,

    silentPrintingUsesElectronMainProcess: true,
    autoFullscreen: document.fullscreenElement === root
  });

})();
