"use strict";

// A locked-down window for browsing the shared wiki and the correction inbox.
// No remote content, no Node in the renderer, isolated context, sandboxed, and
// a preload that exposes only the semantic operations below.

const path = require("path");
const { WikiStore } = require("./wiki-store");
const { applyCorrection, fetchInbox, planCorrection } = require("./corrections-client");
const { dismissJob, listDeadJobs, listDismissedJobs, restoreJob, retryDeadJobs, retryJob } = require("./status");

let wikiWindow = null;
let handlersRegistered = false;

function clampLimit(value, fallback, max) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function sanitizeActionOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  return {
    owner: typeof source.owner === "string" ? source.owner : "",
    query: typeof source.query === "string" ? source.query : "",
    limit: clampLimit(source.limit, 30, 100),
  };
}

function safeJobId(value) {
  if (!Number.isInteger(value) || value < 1) throw new Error("Invalid job selected");
  return value;
}

async function guard(operation) {
  try {
    return await operation();
  } catch (_) {
    return { error: "This action is unavailable." };
  }
}

function registerHandlers(ipcMain, context) {
  if (handlersRegistered) return;
  handlersRegistered = true;
  const store = new WikiStore(context.dataDir);
  ipcMain.handle("wiki:listRecent", (_event, limit) =>
    guard(async () => store.listRecent(clampLimit(limit, 10, 50))),
  );
  ipcMain.handle("wiki:search", (_event, query, limit) =>
    guard(async () => store.search(String(query || ""), clampLimit(limit, 8, 30))),
  );
  ipcMain.handle("wiki:readPage", (_event, pagePath) =>
    guard(async () => store.readPage(String(pagePath || ""))),
  );
  ipcMain.handle("wiki:actionItems", (_event, options) =>
    guard(async () => store.actionItems(sanitizeActionOptions(options))),
  );
  ipcMain.handle("corrections:inbox", () =>
    guard(() => fetchInbox(context.python, context.configPath)),
  );
  ipcMain.handle("corrections:plan", (_event, meetingKey, mapping) =>
    guard(() => planCorrection(context.python, context.configPath, meetingKey, mapping || {})),
  );
  ipcMain.handle("corrections:apply", (_event, meetingKey, mapping) =>
    guard(() => applyCorrection(context.python, context.configPath, meetingKey, mapping || {})),
  );
  ipcMain.handle("jobs:listDead", () =>
    guard(() => listDeadJobs(context.python, context.configPath)),
  );
  ipcMain.handle("jobs:listDismissed", () =>
    guard(() => listDismissedJobs(context.python, context.configPath)),
  );
  ipcMain.handle("jobs:retry", (_event, jobId) =>
    guard(() => retryJob(context.python, context.configPath, safeJobId(jobId))),
  );
  ipcMain.handle("jobs:retryAllDead", () =>
    guard(() => retryDeadJobs(context.python, context.configPath)),
  );
  ipcMain.handle("jobs:dismiss", (_event, jobId) =>
    guard(() => dismissJob(context.python, context.configPath, safeJobId(jobId))),
  );
  ipcMain.handle("jobs:restore", (_event, jobId) =>
    guard(() => restoreJob(context.python, context.configPath, safeJobId(jobId))),
  );
}

function createWikiWindow(electron, context) {
  const { app, BrowserWindow, ipcMain } = electron;
  registerHandlers(ipcMain, context);
  if (wikiWindow && !wikiWindow.isDestroyed()) {
    wikiWindow.show();
    wikiWindow.focus();
    return wikiWindow;
  }
  if (app.dock) app.dock.show();
  wikiWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Meeting Wiki",
    backgroundColor: "#f4f1ea",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
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
  const denyNavigation = (event) => event.preventDefault();
  wikiWindow.webContents.on("will-navigate", denyNavigation);
  wikiWindow.webContents.on("will-attach-webview", denyNavigation);
  wikiWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  wikiWindow.once("ready-to-show", () => wikiWindow.show());
  wikiWindow.on("closed", () => {
    wikiWindow = null;
    if (app.dock) app.dock.hide();
  });
  wikiWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  return wikiWindow;
}

module.exports = { createWikiWindow, registerHandlers, sanitizeActionOptions, clampLimit };
