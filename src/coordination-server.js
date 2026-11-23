"use strict";

// CASH KIOSK - CENTRAL COORDINATION SERVER
// Uses Node.js built-ins only. It never receives SSO cookies or passwords.

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const HOST = "::";
const PORT = Number(process.env.CASH_KIOSK_SERVER_PORT || 5005);
const MAX_BODY_BYTES = 16 * 1024;
const API = "/api/v1";
const DATA_DIR = path.join(process.env.ProgramData || "C:\\ProgramData", "CashKiosk");
const TOKEN_FILE = path.join(DATA_DIR, "server-token");
let TOKEN = String(process.env.CASH_KIOSK_SERVER_TOKEN || "");
try {
  if (!TOKEN && fs.existsSync(TOKEN_FILE)) {
    TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  }
} catch (error) {
  console.error("[Cash Kiosk Server] Cannot read protected token file:", error);
}
const STATE_FILE = path.join(DATA_DIR, "coordination-state.json");
const AUDIT_FILE = path.join(DATA_DIR, "coordination-audit.jsonl");

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("[Cash Kiosk Server] Invalid port.");
  process.exit(1);
}
if (Buffer.byteLength(TOKEN, "utf8") < 32) {
  console.error("[Cash Kiosk Server] Set CASH_KIOSK_SERVER_TOKEN to a random secret of at least 32 characters.");
  process.exit(1);
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!value || typeof value !== "object" || !("lock" in value)) {
      throw new Error("Invalid state structure");
    }
    return value;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("[Cash Kiosk Server] State cannot be read:", error);
      throw new Error("Refusing to start without readable lock state.");
    }
    return { version: 1, lock: null, updatedAt: new Date().toISOString() };
  }
}

let state = loadState();

function saveState() {
  state.updatedAt = new Date().toISOString();
  const temp = STATE_FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: "utf8" });
  fs.renameSync(temp, STATE_FILE);
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function remoteAddress(request) {
  return String(request.socket.remoteAddress || "")
    .replace(/^::ffff:/i, "").split("%")[0].toLowerCase();
}

function isPrivateAddress(address) {
  if (address === "::1" || address === "localhost") return true;
  if (address.includes(":")) {
    return /^(fe[89ab]|fc|fd)/i.test(address);
  }
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = p[0], b = p[1];
  return a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function authorized(request) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ""));
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(TOKEN, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function identityOf(body) {
  const clientId = String(body.clientId || "").trim();
  const deviceName = String(body.deviceName || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientId) || !deviceName || deviceName.length > 80) return null;
  return { clientId, deviceName };
}

function publicLock(lock) {
  if (!lock) return null;
  return {
    lockId: lock.lockId,
    clientId: lock.clientId,
    deviceName: lock.deviceName,
    acquiredAt: lock.acquiredAt,
    status: lock.status,
    reason: lock.reason || null
  };
}

async function handleApi(request, response, pathname) {
  if (!authorized(request)) {
    send(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  if (request.method === "GET" && pathname === API + "/lock/status") {
    send(response, 200, { ok: true, lock: publicLock(state.lock) });
    return;
  }

  if (request.method !== "POST") {
    send(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    send(response, error.statusCode || 400, { ok: false, error: error.message });
    return;
  }

  if (pathname === API + "/lock/acquire") {
    const identity = identityOf(body);
    if (!identity) {
      send(response, 400, { ok: false, error: "Invalid client identity" });
      return;
    }

    if (state.lock && state.lock.status === "halted") {
      send(response, 423, {
        ok: false,
        error: "Payment lock is halted and requires manual verification",
        sameClient: state.lock.clientId === identity.clientId,
        lock: publicLock(state.lock)
      });
      return;
    }

    // Any pre-existing lock blocks a new acquisition, including one from
    // the same installation. This is deliberate: after an app/PC restart,
    // the client must never silently reuse a stale lock and retry a payment.
    // A stale or uncertain lock requires explicit operator verification.
    if (state.lock) {
      send(response, 409, {
        ok: false,
        error: state.lock.status === "halted"
          ? "Payment lock is halted and requires manual verification"
          : "A payment lock already exists; manual verification is required before release",
        sameClient: state.lock.clientId === identity.clientId,
        lock: publicLock(state.lock)
      });
      return;
    }

    state.lock = {
      lockId: crypto.randomUUID(),
      clientId: identity.clientId,
      deviceName: identity.deviceName,
      acquiredAt: new Date().toISOString(),
      status: "active",
      reason: null
    };

    try {
      saveState();
    } catch (error) {
      state.lock = null;
      console.error("[Cash Kiosk Server] Could not persist lock:", error);
      send(response, 500, { ok: false, error: "Could not persist lock; payment is not authorized" });
      return;
    }

    console.log("[LOCK ACQUIRED]", identity.deviceName, identity.clientId);
    send(response, 200, { ok: true, acquired: true, existing: false, lock: publicLock(state.lock) });
    return;
  }

  if (pathname === API + "/lock/release") {
    const identity = identityOf(body);
    const lockId = String(body.lockId || "");
    const outcome = String(body.outcome || "");
    if (!identity || !lockId ||
        !["no-match", "payment-success", "cancelled-before-payment"].includes(outcome)) {
      send(response, 400, { ok: false, error: "Invalid release request or outcome" });
      return;
    }

    if (!state.lock || state.lock.clientId !== identity.clientId || state.lock.lockId !== lockId) {
      send(response, 409, { ok: false, error: "Lock ownership mismatch", lock: publicLock(state.lock) });
      return;
    }
    if (state.lock.status === "halted") {
      send(response, 423, { ok: false, error: "Halted lock cannot be released by a kiosk" });
      return;
    }

    const previous = state.lock;
    state.lock = null;
    try {
      saveState();
    } catch (error) {
      state.lock = previous;
      console.error("[Cash Kiosk Server] Could not persist lock release:", error);
      send(response, 500, { ok: false, error: "Could not persist lock release" });
      return;
    }

    console.log("[LOCK RELEASED]", identity.deviceName, outcome);
    send(response, 200, { ok: true, released: true });
    return;
  }

  if (pathname === API + "/lock/operator-release") {
    const identity = identityOf(body);
    const lockId = String(body.lockId || "");
    const reason = String(body.reason || "").trim().slice(0, 500);
    const reviewed = body.reviewed === true;

    if (!identity || !lockId || !reviewed || reason.length < 5) {
      send(response, 400, {
        ok: false,
        error: "Operator release requires device identity, lockId, reviewed=true and a reason"
      });
      return;
    }

    if (!state.lock || state.lock.lockId !== lockId) {
      send(response, 409, {
        ok: false,
        error: "Lock identity mismatch; no lock was released",
        lock: publicLock(state.lock)
      });
      return;
    }

    const previous = state.lock;
    const auditEntry = {
      at: new Date().toISOString(),
      action: "operator-release",
      deviceName: identity.deviceName,
      clientId: identity.clientId,
      lockId: previous.lockId,
      previousStatus: previous.status,
      previousReason: previous.reason || null,
      operatorReason: reason,
      reviewed: true
    };

    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      state.lock = null;
      saveState();
      fs.appendFileSync(AUDIT_FILE, JSON.stringify(auditEntry) + "\n", { encoding: "utf8" });
    } catch (error) {
      state.lock = previous;
      try { saveState(); } catch (restoreError) {
        console.error("[Cash Kiosk Server] CRITICAL: failed to restore lock state:", restoreError);
      }
      console.error("[Cash Kiosk Server] Operator release could not be persisted:", error);
      send(response, 500, {
        ok: false,
        error: "Operator release could not be safely recorded; lock remains active"
      });
      return;
    }

    console.warn("[LOCK OPERATOR-RELEASED]", auditEntry);
    send(response, 200, {
      ok: true,
      released: true,
      paymentRetried: false,
      message: "Lock released only. No payment request was sent."
    });
    return;
  }

  if (pathname === API + "/lock/halt") {
    const identity = identityOf(body);
    const lockId = String(body.lockId || "");
    if (!identity || !lockId) {
      send(response, 400, { ok: false, error: "Invalid halt request" });
      return;
    }
    if (!state.lock || state.lock.clientId !== identity.clientId || state.lock.lockId !== lockId) {
      send(response, 409, { ok: false, error: "Lock ownership mismatch", lock: publicLock(state.lock) });
      return;
    }

    state.lock.status = "halted";
    state.lock.reason = String(body.reason || "Uncertain payment result").slice(0, 300);
    state.lock.haltedAt = new Date().toISOString();
    try {
      saveState();
    } catch (error) {
      console.error("[Cash Kiosk Server] Could not persist halted lock:", error);
      send(response, 500, { ok: false, error: "Could not persist halted lock" });
      return;
    }

    console.error("[LOCK HALTED]", identity.deviceName, state.lock.reason);
    send(response, 200, { ok: true, halted: true, lock: publicLock(state.lock) });
    return;
  }

  send(response, 404, { ok: false, error: "Not found" });
}

const server = http.createServer(async (request, response) => {
  if (!isPrivateAddress(remoteAddress(request))) {
    send(response, 403, { ok: false, error: "Private network access only" });
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    send(response, 400, { ok: false, error: "Invalid URL" });
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    send(response, 200, {
      ok: true,
      service: "cash-kiosk-coordination",
      version: 1,
      host: os.hostname(),
      port: PORT
    });
    return;
  }

  if (!pathname.startsWith(API + "/")) {
    send(response, 404, { ok: false, error: "Not found" });
    return;
  }

  try {
    await handleApi(request, response, pathname);
  } catch (error) {
    console.error("[Cash Kiosk Server] Request failed:", error);
    if (!response.headersSent) send(response, 500, { ok: false, error: "Internal server error" });
  }
});

server.on("error", error => {
  console.error("[Cash Kiosk Server] Server error:", error);
  process.exitCode = 1;
});

server.listen({ port: PORT, host: HOST, ipv6Only: false }, () => {
  console.log("==================================================");
  console.log("CASH KIOSK CENTRAL COORDINATION SERVER");
  console.log("Host:", os.hostname());
  console.log("Listening on IPv6 dual-stack port:", PORT);
  console.log("Health URL: http://" + os.hostname() + ":" + PORT + "/health");
  console.log("State file:", STATE_FILE);
  console.log("Audit file:", AUDIT_FILE);
  console.log("Current lock:", publicLock(state.lock));
  console.log("Automatic lock expiry: DISABLED (fail-safe)");
  console.log("==================================================");
});

function shutdown(signal) {
  console.log("[Cash Kiosk Server] Shutdown:", signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
