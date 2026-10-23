"use strict";

// Pre-record confirmation window. Same lockdown as setup-window.js. The renderer receives
// only status codes and the user's own provider host; it can send back a title and a
// strict private flag, nothing else. Recording starts only from an explicit Start click.

const path = require("path");
const { pathToFileURL } = require("url");

const { parseManagedConfig } = require("./managed-config");

const CHANNELS = Object.freeze({
  getContext: "record:getContext",
  start: "record:start",
  cancel: "record:cancel",
  openSetup: "record:openSetup",
  openPrivacySettings: "record:openPrivacySettings",
});

// Fixed System Settings panes. Electron cannot read the Core Audio tap permission that
// system audio capture uses, so the panel links to the pane instead of reporting a status.
const PRIVACY_PANES = Object.freeze({
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  systemAudio: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
});
const BLOCKER_MESSAGES = Object.freeze({
  setup_incomplete: "Finish setup before recording.",
  microphone_blocked: "Microphone access is blocked. Allow it in System Settings, then try again.",
});

const LIVE_UNAVAILABLE_MESSAGES = Object.freeze({
  no_adapter: "The selected provider does not support live captions, translation, and summary.",
  engine_missing: "The Meeting Wiki engine is unavailable. Recording continues, but live and processing need the app to be reinstalled.",
  key_unavailable: "The provider key could not be read. Recording continues, but live and processing remain paused until setup is repaired.",
  provider_unavailable: "The configured live provider is unavailable. Recording and batch processing continue normally.",
  audio_unavailable: "Live microphone audio did not become available. Recording and batch processing continue normally.",
  audio_unsupported: "The live provider cannot use this microphone audio. Recording and batch processing continue normally.",
  transcription_error: "Live transcription stopped. Recording and batch processing continue normally.",
  language_error: "Live translation and summary stopped. Recording and batch processing continue normally.",
  startup_failed: "Live captions, translation, and summary could not start. Recording continues normally.",
  connection_lost: "The live connection ended. Recording and batch processing continue normally.",
  provider_session_expired: "The live provider session expired and could not resume. Recording continues normally.",
});
const DEFAULT_LIVE_UNAVAILABLE_MESSAGE = "Live captions, translation, and summary could not start. Recording continues normally.";

function liveUnavailableMessage(issue) {
  return LIVE_UNAVAILABLE_MESSAGES[issue] || DEFAULT_LIVE_UNAVAILABLE_MESSAGE;
}

const TITLE_MAX = 200;
const MEDIA_STATUSES = new Set(["granted", "denied", "restricted", "not-determined"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LIVE_STATUS_BY_PROVIDER = Object.freeze({
  gemini: "ready",
  chunked_mlx_whisper: "ready",
  openai_compatible: "no_adapter",
});

class RecordError extends Error {}

function mediaStatus(value) {
  return MEDIA_STATUSES.has(value) ? value : "unknown";
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return "";
  }
}

// Pure: every field is a code, a number, or the host the user configured.
function buildRecordContext({ setupComplete, configText, pythonAvailable, keyAvailable, maxDurationMinutes, microphone, recording }) {
  const tables = parseManagedConfig(configText);
  const providers = (tables && tables.providers) || {};
  let destination = "manual";
  let host = "";
  if (tables && providers.transcription === "gemini") destination = "gemini";
  else if (tables && providers.transcription === "openai_compatible") {
    destination = "openai_compatible";
    host = hostOf((tables.openai_transcription && tables.openai_transcription.base_url) || "");
  }
  let live;
  if (!pythonAvailable) live = "engine_missing";
  else if (!keyAvailable) live = "key_unavailable";
  else if (!tables) live = "manual";
  else live = LIVE_STATUS_BY_PROVIDER[providers.live_transcription] || "no_adapter";
  const liveProvider = providers.live_transcription;
  const liveHost = hostOf((tables && tables.openai_compatible && tables.openai_compatible.base_url) || "");
  const external = liveProvider === "gemini" || (liveProvider === "openai_compatible" && !LOOPBACK_HOSTS.has(liveHost.replace(/:\d+$/, "")));
  const microphoneStatus = mediaStatus(microphone);
  const blockers = [];
  if (setupComplete !== true) blockers.push("setup_incomplete");
  if (microphoneStatus === "denied" || microphoneStatus === "restricted") blockers.push("microphone_blocked");
  return {
    setupComplete: setupComplete === true,
    blockers,
    maxDurationMinutes,
    microphone: microphoneStatus,
    systemAudio: "not_checkable",
    destination,
    host,
    live,
    // A hand-edited config may still have an adapter; the live child reports if it does not.
    liveStarts: live === "ready" || live === "manual",
    liveScope: !tables ? "unknown" : external ? "external" : "local",
    recording: recording === true,
  };
}

// Only a one-line title and an explicit boolean true for private are accepted.
function validateStartRequest(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawTitle = source.title === undefined ? "" : source.title;
  if (typeof rawTitle !== "string") throw new RecordError("Enter the title as plain text.");
  const title = rawTitle.normalize("NFC").replace(/\s+/gu, " ").trim();
  if ([...title].length > TITLE_MAX) throw new RecordError(`Keep the title to ${TITLE_MAX} characters or fewer.`);
  if (/[\u0000-\u001f\u007f]/.test(title)) throw new RecordError("Remove control characters from the title.");
  const privacyMode = source.privacyMode;
  if (privacyMode !== "private" && privacyMode !== "shared") {
    throw new RecordError("Choose where the notes go before starting.");
  }
  if (source.liveEnabled !== undefined && typeof source.liveEnabled !== "boolean") {
    throw new RecordError("Choose whether live captions, translation, and summary start for this recording.");
  }
  return { title, isPrivate: privacyMode === "private", liveEnabled: source.liveEnabled === true };
}

function createRecordController({ getContext, onStart, onCancel = () => {}, onOpenSetup = () => {}, openExternal = () => {} }) {
  return {
    getContext() {
      return getContext();
    },
    start(raw) {
      const request = validateStartRequest(raw);
      const context = getContext();
      if (context.recording) throw new RecordError("A recording is already running.");
      const blockers = Array.isArray(context.blockers) ? context.blockers : ["setup_incomplete"];
      if (blockers.length > 0) throw new RecordError(BLOCKER_MESSAGES[blockers[0]] || BLOCKER_MESSAGES.setup_incomplete);
      onStart(request);
      return { ok: true };
    },
    cancel() {
      onCancel();
      return { ok: true };
    },
    openSetup() {
      onOpenSetup();
      return { ok: true };
    },
    openPrivacySettings(kind) {
      if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(PRIVACY_PANES, kind)) {
        throw new RecordError("That privacy setting cannot be opened.");
      }
      openExternal(PRIVACY_PANES[kind]);
      return { ok: true };
    },
  };
}

async function guard(operation) {
  try {
    const result = await operation();
    return result === undefined ? { ok: true } : result;
  } catch (error) {
    return { error: error instanceof RecordError ? error.message : "The recording could not start. Try again." };
  }
}

function registerRecordHandlers(ipcMain, getController, isTrustedSender) {
  const handle = (channel, run) =>
    ipcMain.handle(channel, (event, ...args) =>
      guard(async () => {
        if (!isTrustedSender(event)) throw new RecordError("This request did not come from the recording window.");
        return run(getController(), ...args);
      }),
    );
  handle(CHANNELS.getContext, (controller) => controller.getContext());
  handle(CHANNELS.start, (controller, request) => controller.start(request));
  handle(CHANNELS.cancel, (controller) => controller.cancel());
  handle(CHANNELS.openSetup, (controller) => controller.openSetup());
  handle(CHANNELS.openPrivacySettings, (controller, kind) => controller.openPrivacySettings(kind));
}

let recordWindow = null;
let recordController = null;
let handlersRegistered = false;
const RECORD_PAGE = path.join(__dirname, "renderer", "record.html");

function isRecordSender(event) {
  if (!recordWindow || recordWindow.isDestroyed()) return false;
  if (!event || event.sender !== recordWindow.webContents) return false;
  const frame = event.senderFrame;
  return Boolean(frame) && frame.url === pathToFileURL(RECORD_PAGE).href;
}

function closeRecordWindow() {
  if (recordWindow && !recordWindow.isDestroyed()) recordWindow.close();
}

function createRecordWindow(electron, context) {
  const { app, BrowserWindow, ipcMain } = electron;
  if (recordWindow && !recordWindow.isDestroyed()) {
    recordWindow.show();
    recordWindow.focus();
    return recordWindow;
  }
  // The window closes before capture starts, so the start never races window focus.
  recordController = createRecordController({
    getContext: context.getContext,
    onStart: (request) => {
      closeRecordWindow();
      context.onStart(request);
    },
    onCancel: closeRecordWindow,
    onOpenSetup: () => {
      closeRecordWindow();
      if (context.onOpenSetup) context.onOpenSetup();
    },
    openExternal: (url) => {
      if (context.openExternal) context.openExternal(url);
    },
  });
  if (!handlersRegistered) {
    handlersRegistered = true;
    registerRecordHandlers(ipcMain, () => recordController, isRecordSender);
  }
  if (app.focus) app.focus({ steal: true });
  recordWindow = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 460,
    minHeight: 520,
    show: false,
    title: "Start a recording",
    backgroundColor: "#f4f1ea",
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "record-preload.js"),
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
  recordWindow.webContents.on("will-navigate", denyNavigation);
  recordWindow.webContents.on("will-attach-webview", denyNavigation);
  recordWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  recordWindow.once("ready-to-show", () => recordWindow.show());
  recordWindow.on("closed", () => {
    recordWindow = null;
  });
  recordWindow.loadFile(RECORD_PAGE);
  return recordWindow;
}

module.exports = {
  BLOCKER_MESSAGES,
  CHANNELS,
  LIVE_UNAVAILABLE_MESSAGES,
  PRIVACY_PANES,
  RecordError,
  TITLE_MAX,
  buildRecordContext,
  closeRecordWindow,
  createRecordController,
  createRecordWindow,
  guard,
  liveUnavailableMessage,
  registerRecordHandlers,
  validateStartRequest,
};
