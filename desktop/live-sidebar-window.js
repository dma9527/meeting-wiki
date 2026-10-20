"use strict";

// A locked-down, display-only window for one live session. It registers no IPC handlers:
// main pushes already-sanitized events on a single channel, and the preload exposes only
// subscribe and unsubscribe. No Node, no navigation, no popups, no network.

const path = require("path");
const { sanitizeLiveEvent } = require("./live-session");

const LIVE_EVENT_CHANNEL = "live:event";
const LIVE_SIDEBAR_PAGE = path.join(__dirname, "renderer", "live-sidebar.html");
const MAX_PENDING = 200;

let sidebarWindow = null;
let ready = false;
let pending = [];
let onClosedCallback = null;

// Re-validates main-side events so only known display fields can reach the renderer.
function rendererEvent(event) {
  if (!event || typeof event !== "object") return null;
  return sanitizeLiveEvent({ type: event.type, payload: event });
}

function publishLiveEvent(event) {
  const safe = rendererEvent(event);
  if (!safe || !sidebarWindow || sidebarWindow.isDestroyed()) return false;
  if (!ready) {
    pending.push(safe);
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    return true;
  }
  sidebarWindow.webContents.send(LIVE_EVENT_CHANNEL, safe);
  return true;
}

function createLiveSidebarWindow(electron, { onClosed } = {}) {
  const { BrowserWindow } = electron;
  onClosedCallback = typeof onClosed === "function" ? onClosed : null;
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.showInactive();
    return sidebarWindow;
  }
  ready = false;
  pending = [];
  const window = new BrowserWindow({
    width: 380,
    height: 640,
    minWidth: 300,
    minHeight: 360,
    show: false,
    alwaysOnTop: true,
    title: "Meeting Wiki Live",
    backgroundColor: "#f4f1ea",
    webPreferences: {
      preload: path.join(__dirname, "live-sidebar-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });
  sidebarWindow = window;
  const denyNavigation = (event) => event.preventDefault();
  window.webContents.on("will-navigate", denyNavigation);
  window.webContents.on("will-redirect", denyNavigation);
  window.webContents.on("will-attach-webview", denyNavigation);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("did-finish-load", () => {
    if (sidebarWindow !== window) return;
    ready = true;
    for (const event of pending) window.webContents.send(LIVE_EVENT_CHANNEL, event);
    pending = [];
  });
  window.once("ready-to-show", () => window.showInactive());
  window.on("closed", () => {
    if (sidebarWindow !== window) return;
    sidebarWindow = null;
    ready = false;
    pending = [];
    const callback = onClosedCallback;
    onClosedCallback = null;
    if (callback) callback();
  });
  window.loadFile(LIVE_SIDEBAR_PAGE);
  return window;
}

module.exports = {
  LIVE_EVENT_CHANNEL,
  LIVE_SIDEBAR_PAGE,
  createLiveSidebarWindow,
  publishLiveEvent,
};
