"use strict";

// Live sidebar bridge. Exposes only subscribe and unsubscribe for display events. The
// channel must match LIVE_EVENT_CHANNEL in live-sidebar-window.js (sandboxed preloads
// cannot require local modules). Fields are re-picked so nothing else reaches the page.

const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "live:event";
const PHASES = ["starting", "listening", "stopped", "unavailable"];
const SCOPES = ["local", "external"];
let listener = null;

function text(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function pickLiveEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "state") {
    if (!PHASES.includes(event.phase)) return null;
    return {
      type: "state",
      phase: event.phase,
      private: event.private === true,
      scope: SCOPES.includes(event.scope) ? event.scope : "",
      issue: text(event.issue, 40),
    };
  }
  if (!Number.isSafeInteger(event.sequence)) return null;
  if (event.type === "transcript" || event.type === "translation") {
    return { type: event.type, sequence: event.sequence, text: text(event.text, 2000) };
  }
  if (event.type === "summary" && Array.isArray(event.points)) {
    return {
      type: "summary",
      sequence: event.sequence,
      points: event.points.slice(0, 5).map((point) => text(point, 400)),
    };
  }
  return null;
}

function unsubscribe() {
  if (listener) ipcRenderer.removeListener(CHANNEL, listener);
  listener = null;
}

function subscribe(callback) {
  if (typeof callback !== "function") return false;
  unsubscribe();
  listener = (_event, payload) => {
    const safe = pickLiveEvent(payload);
    if (safe) callback(safe);
  };
  ipcRenderer.on(CHANNEL, listener);
  return true;
}

contextBridge.exposeInMainWorld("meetingWikiLive", { subscribe, unsubscribe });
