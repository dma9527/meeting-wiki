"use strict";

// A locked-down, display-only window for one live session. It registers no IPC handlers:
// main pushes already-sanitized events on a single channel, and the preload exposes only
// subscribe and unsubscribe. No Node, no navigation, no popups, no network.
// A user close only hides the window; main destroys it when the recording ends.

const path = require("path");
const { sanitizeLiveEvent } = require("./live-session");
const { windowBackground } = require("./window-background");

const LIVE_EVENT_CHANNEL = "live:event";
const LIVE_SIDEBAR_PAGE = path.join(__dirname, "renderer", "live-sidebar.html");
const MAX_PENDING = 200;

const LOCALES = new Set(["system", "en", "zh-CN"]);

let sidebarWindow = null;
let ready = false;
let pending = [];
let lastState = null;
let allowClose = false;

// Re-validates main-side events so only known display fields can reach the renderer.
function rendererEvent(event) {
  if (!event || typeof event !== "object") return null;
  return sanitizeLiveEvent({ type: event.type, payload: event });
}

function publishLiveEvent(event) {
  const safe = rendererEvent(event);
  if (!safe || !sidebarWindow || sidebarWindow.isDestroyed()) return false;
  if (safe.type === "state") lastState = safe;
  if (!ready) {
    pending.push(safe);
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    return true;
  }
  sidebarWindow.webContents.send(LIVE_EVENT_CHANNEL, safe);
  return true;
}

function createLiveSidebarWindow(electron, { uiLanguage = "system" } = {}) {
  const { BrowserWindow } = electron;
  const locale = { type: "locale", uiLanguage: LOCALES.has(uiLanguage) ? uiLanguage : "system" };
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.showInactive();
    return sidebarWindow;
  }
  ready = false;
  pending = [];
  lastState = null;
  allowClose = false;
  const window = new BrowserWindow({
    width: 380,
    height: 640,
    minWidth: 300,
    minHeight: 360,
    show: false,
    alwaysOnTop: true,
    title: "Meeting Wiki Live",
    backgroundColor: windowBackground(),
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
  // A reload buffers events again and replays the locale and the last state first.
  window.webContents.on("did-start-loading", () => {
    if (sidebarWindow === window) ready = false;
  });
  window.webContents.on("did-finish-load", () => {
    if (sidebarWindow !== window) return;
    ready = true;
    window.webContents.send(LIVE_EVENT_CHANNEL, locale);
    if (lastState && !pending.some((event) => event.type === "state")) window.webContents.send(LIVE_EVENT_CHANNEL, lastState);
    for (const event of pending) window.webContents.send(LIVE_EVENT_CHANNEL, event);
    pending = [];
  });
  window.once("ready-to-show", () => window.showInactive());
  window.on("close", (event) => {
    if (allowClose || sidebarWindow !== window) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    if (sidebarWindow !== window) return;
    sidebarWindow = null;
    ready = false;
    pending = [];
    lastState = null;
  });
  window.loadFile(LIVE_SIDEBAR_PAGE);
  return window;
}

function liveSidebarAvailable() {
  return Boolean(sidebarWindow && !sidebarWindow.isDestroyed());
}

// User-triggered from the menu, so it may take focus.
function showLiveSidebar() {
  if (!liveSidebarAvailable()) return false;
  sidebarWindow.show();
  sidebarWindow.focus();
  return true;
}

function destroyLiveSidebar() {
  if (!liveSidebarAvailable()) return;
  allowClose = true;
  sidebarWindow.close();
}

module.exports = {
  LIVE_EVENT_CHANNEL,
  LIVE_SIDEBAR_PAGE,
  createLiveSidebarWindow,
  destroyLiveSidebar,
  liveSidebarAvailable,
  publishLiveEvent,
  showLiveSidebar,
};
