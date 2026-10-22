"use strict";

// Recording confirmation bridge. Exposes only getContext, start, cancel, and two fixed openers. Channel names
// must match CHANNELS in record-window.js (sandboxed preloads cannot require local modules).

const { contextBridge, ipcRenderer } = require("electron");

const MAX_FORWARDED_TITLE = 1000;

function pickStartRequest(request) {
  const source = request && typeof request === "object" ? request : {};
  return {
    title: typeof source.title === "string" ? source.title.slice(0, MAX_FORWARDED_TITLE) : "",
    private: source.private === true,
  };
}

const PRIVACY_KINDS = new Set(["microphone", "systemAudio"]);

contextBridge.exposeInMainWorld("meetingWikiRecord", {
  getContext: () => ipcRenderer.invoke("record:getContext"),
  start: (request) => ipcRenderer.invoke("record:start", pickStartRequest(request)),
  cancel: () => ipcRenderer.invoke("record:cancel"),
  openSetup: () => ipcRenderer.invoke("record:openSetup"),
  openPrivacySettings: (kind) => ipcRenderer.invoke("record:openPrivacySettings", PRIVACY_KINDS.has(kind) ? kind : ""),
});
