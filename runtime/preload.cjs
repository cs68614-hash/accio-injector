/* eslint-disable */
"use strict";

const { ipcRenderer, contextBridge } = require("electron");

function report(message, extra) {
  const payload = `${message}${extra === undefined ? "" : " " + safeJson(extra)}`;
  try {
    ipcRenderer.send("accio-injector:preload-log", payload);
  } catch {}
  try {
    console.info("[accio-injector]", payload);
  } catch {}
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

report("preload reached", {
  href: location.href,
  readyState: document.readyState,
});

try {
  contextBridge.exposeInMainWorld("__accioInjector", {
    ok: true,
    injectedAt: new Date().toISOString(),
  });
  report("contextBridge exposed __accioInjector");
} catch (error) {
  report("contextBridge expose failed", error && error.message || String(error));
}

queueMicrotask(() => {
  const boot = () => {
    report("dom ready", {
      title: document.title,
      bodyChildren: document.body ? document.body.children.length : null,
    });
    installBadge();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
});

function installBadge() {
  try {
    if (!document.body || document.getElementById("accio-injector-poc-badge")) return;
    const badge = document.createElement("div");
    badge.id = "accio-injector-poc-badge";
    badge.textContent = "Injected";
    badge.title = "Accio Injector PoC preload is running";
    Object.assign(badge.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483647",
      padding: "6px 9px",
      borderRadius: "6px",
      background: "rgba(18, 18, 18, 0.84)",
      color: "#fff",
      font: "12px/1.2 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      letterSpacing: "0",
      boxShadow: "0 6px 18px rgba(0, 0, 0, 0.22)",
      pointerEvents: "none",
    });
    document.body.appendChild(badge);
    report("badge installed");
  } catch (error) {
    report("badge install failed", error && error.message || String(error));
  }
}
