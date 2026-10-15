"use strict";

// Setup bridge. Exposes only the named setup actions. No generic invoke, send,
// or listener channel is reachable from the renderer. Channel names must match
// CHANNELS in setup-window.js (sandboxed preloads cannot require local modules).

const { contextBridge, ipcRenderer } = require("electron");

const PROGRESS_STATUSES = new Set(["downloading", "installed", "error"]);

function pickOnlineSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const text = (value) => (typeof value === "string" ? value : "");
  return {
    baseUrl: text(source.baseUrl),
    transcriptionModel: text(source.transcriptionModel),
    languageModel: text(source.languageModel),
    apiKey: text(source.apiKey),
    acknowledgedEgress: source.acknowledgedEgress === true,
  };
}

function sanitizeProgress(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  if (typeof source.id !== "string" || !PROGRESS_STATUSES.has(source.status)) return null;
  const event = { id: source.id, status: source.status };
  if (Number.isFinite(source.receivedBytes)) event.receivedBytes = source.receivedBytes;
  if (Number.isFinite(source.totalBytes)) event.totalBytes = source.totalBytes;
  if (typeof source.error === "string") event.error = source.error;
  return event;
}

contextBridge.exposeInMainWorld("meetingWikiSetup", {
  getSetupState: () => ipcRenderer.invoke("setup:getSetupState"),
  saveOnlineProvider: (settings) => ipcRenderer.invoke("setup:saveOnlineProvider", pickOnlineSettings(settings)),
  testOnlineProvider: () => ipcRenderer.invoke("setup:testOnlineProvider"),
  listLocalModels: () => ipcRenderer.invoke("setup:listLocalModels"),
  downloadLocalModel: (id) => ipcRenderer.invoke("setup:downloadLocalModel", typeof id === "string" ? id : ""),
  onLocalModelProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => {
      const event = sanitizeProgress(payload);
      if (event) callback(event);
    };
    ipcRenderer.on("setup:localModelProgress", listener);
    return () => ipcRenderer.removeListener("setup:localModelProgress", listener);
  },
  completeSetup: (options) =>
    ipcRenderer.invoke("setup:completeSetup", {
      mode: options && typeof options.mode === "string" ? options.mode : "",
    }),
});
