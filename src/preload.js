"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// فقط یک تابع محدود برای ارسال PDF به چاپگر پیش‌فرض ویندوز در دسترس صفحه است.
contextBridge.exposeInMainWorld("cashKioskDesktop", {
  printPdf: (pdfArrayBuffer) => {
    if (!(pdfArrayBuffer instanceof ArrayBuffer)) {
      return Promise.reject(new TypeError("محتوای PDF معتبر نیست"));
    }
    return ipcRenderer.invoke("cash-kiosk:print-pdf", pdfArrayBuffer);
  },
  getCoordinationIdentity: () =>
    ipcRenderer.invoke("cash-kiosk:coordination-identity"),
  onNumpadInput: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("تابع دریافت ورودی NumPad معتبر نیست");
    }
    const listener = (_event, key) => callback(key);
    ipcRenderer.on("cash-kiosk:numpad-input", listener);
    return () => ipcRenderer.removeListener("cash-kiosk:numpad-input", listener);
  },
  setNumpadReady: (ready) => {
    ipcRenderer.send("cash-kiosk:numpad-ready", ready === true);
  },
  coordination: (action, body = {}) => {
    const allowed = new Set([
      "lock/status",
      "lock/acquire",
      "lock/release",
      "lock/halt",
      "lock/operator-release"
    ]);
    if (!allowed.has(action)) {
      return Promise.reject(new Error("عملیات هماهنگی مجاز نیست"));
    }
    return ipcRenderer.invoke("cash-kiosk:coordination", { action, body });
  }
});
