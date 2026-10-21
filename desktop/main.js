"use strict";

const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, systemPreferences, Tray } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Meeting audio, titles, job payloads and logs are sensitive on shared Macs.
process.umask(0o077);
const { AudioCapture } = require("./capture");
const { createWikiWindow } = require("./wiki-window");
const { createSecretStore } = require("./secret-store");
const { createSetupWindow, needsSetup, readSetupState, resolveProcessEnv } = require("./setup-window");
const { createSettingsWindow } = require("./settings-window");
const { buildRecordContext, closeRecordWindow, createRecordWindow } = require("./record-window");
const { LiveSessionManager } = require("./live-session");
const { createLiveSidebarWindow, publishLiveEvent } = require("./live-sidebar-window");
const { missingRuntimeMessage, resolveRuntimePaths } = require("./runtime-paths");
const { claudeSkillStatus, installClaudeSkill, presentSkillInstall } = require("./skill-installer");
const { formatSelfCheck, runSelfCheck } = require("./self-check");
const { readMaxDurationMinutes } = require("./recording-settings");
const { APPLIES } = require("./setting-metadata");
const { AutoRecordCoordinator, SHORT_DISCARD_NOTICE, SOURCES } = require("./auto-record");
const { readIntegrationSettings } = require("./integration-settings");
const { createIntegrationService } = require("./integration-service");
const { MeetSpoolWatcher, createMeetBridge } = require("./meet-bridge");
const { ZoomMeetingWatcher, sampleZoom } = require("./zoom-detector");
const { atomicWriteFile } = require("./setup-window");
const {
  IngestTracker,
  LIMIT_NOTICE,
  LIMIT_REACHED_LABEL,
  QUIT_NOTICE,
  RecordingSession,
  SAVING_LABEL,
  recordingLabel,
} = require("./recording-session");
const {
  formatQueueLabel,
  trayIconState,
  readQueueStatus,
  retryDeadJobs,
} = require("./status");

const DATA_DIR = process.env.MEETING_WIKI_DATA_DIR || path.join(os.homedir(), ".meeting-wiki");
const RECORDINGS_DIR = path.join(DATA_DIR, "audio");
const CONFIG_PATH = process.env.MEETING_WIKI_CONFIG || path.join(DATA_DIR, "config.toml");
const RUNTIME = resolveRuntimePaths({
  env: process.env,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  dataDir: DATA_DIR,
  existsSync: fs.existsSync,
});
const PYTHON = RUNTIME.python;
const AUDIO_TEE = path.join(__dirname, "node_modules", "audiotee", "bin", "audiotee").replace("app.asar", "app.asar.unpacked");
const TRAY_ICON_PATHS = Object.freeze({
  idle: path.join(__dirname, "assets", "tray-idle@2x.png"),
  recording: path.join(__dirname, "assets", "tray-recording@2x.png"),
  processing: path.join(__dirname, "assets", "tray-processing@2x.png"),
  attention: path.join(__dirname, "assets", "tray-attention@2x.png"),
});
const INSTALL_SKILL_LABEL = "Install Claude skill for meeting memory...";
const INSTALL_SKILL_TOOLTIP = "Adds a data-free skill so Claude can search your meeting memory. Never overwrites files.";

let tray;
let worker;
let shuttingDown = false;
// Quit waits for an active recording to stop and its ingest to finish before exiting.
let quitRequested = false;
let quitPrepared = false;
const QUIT_INGEST_TIMEOUT_MS = 60_000;
let queueSummary = { total: 0, active: 0, action_required: 0 };
let queueStatusReady = false;
let queueStatusError = false;
let queueStatusRefreshing = false;
let currentTrayIconState = null;
let liveIssue = null;

const capture = new AudioCapture({
  recordingsDir: RECORDINGS_DIR,
  audioTeePath: AUDIO_TEE,
  recBin: RUNTIME.rec,
  soxBin: RUNTIME.sox,
  packaged: RUNTIME.packaged,
  onError: (error) => notify("Audio capture error", error.message),
  onSystemAudioUnavailable: () => notify(
    "System audio was not captured",
    "Your microphone recording will continue, but Zoom or Google Meet participants were silent. Check Screen & System Audio Recording permission before the next meeting.",
  ),
});
const liveSession = new LiveSessionManager({
  spawn,
  python: PYTHON,
  configPath: CONFIG_PATH,
  buildEnv: () => processingEnv({ background: true }),
  onEvent: (event) => {
    if (event.type === "state") {
      liveIssue = event.phase === "unavailable" ? event.issue || "unavailable" : null;
      if (tray) updateMenu();
    }
    publishLiveEvent(event);
  },
});
const recordingSession = new RecordingSession({ onLimit: () => { void stopRecording("limit"); } });
const ingests = new IngestTracker();
const secretStore = createSecretStore({ safeStorage, fs, filePath: path.join(DATA_DIR, "secrets.json") });

// Auto-record integrations. Both are off unless enabled in Settings; see docs/integrations.md.
const MEET_EXTENSION_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "browser-extension", "google-meet")
  : path.join(__dirname, "browser-extension", "google-meet");
const meetBridge = createMeetBridge({
  fs,
  dataDir: DATA_DIR,
  homeDir: os.homedir(),
  execPath: process.execPath,
  hostScript: path.join(__dirname, "meet-native-host.js"),
});
const autoRecord = new AutoRecordCoordinator({
  canStart: () => recordingSession.idle && !capture.active && !quitRequested,
  start: (request) => startRecording(request),
  stop: () => stopRecording("integration"),
  discard: async () => {
    await discardRecording();
    notify(SHORT_DISCARD_NOTICE.title, SHORT_DISCARD_NOTICE.body);
  },
  elapsedMs: () => recordingSession.elapsedMs(),
});
const zoomWatcher = new ZoomMeetingWatcher({
  sample: () => sampleZoom({ execFile }),
  onJoin: (info) => { void autoRecord.join(SOURCES.zoom.id, info); },
  onLeave: () => { void autoRecord.leave(SOURCES.zoom.id); },
});
const meetWatcher = new MeetSpoolWatcher({
  fs,
  spoolDir: meetBridge.paths.spoolDir,
  onJoin: (info) => { void autoRecord.join(SOURCES.googleMeet.id, info); },
  onLeave: () => { void autoRecord.leave(SOURCES.googleMeet.id); },
});
const integrations = createIntegrationService({
  fs,
  dataDir: DATA_DIR,
  atomicWriteFile,
  meetBridge,
  extensionDir: MEET_EXTENSION_DIR,
  mediaAccess: (type) => systemPreferences.getMediaAccessStatus(type),
  zoomStatus: () => zoomWatcher.status(),
  meetStatus: () => ({
    state: !meetWatcher.running ? "off" : meetWatcher.tracker.joined ? "in-meeting" : "watching",
    lastSeenAt: meetWatcher.lastSeenAt,
  }),
  revealPath: (target) => shell.showItemInFolder(path.join(target, "manifest.json")),
  onChanged: applyIntegrationSettings,
});

// Starts or stops each watcher to match the saved opt-ins. Turning one off never stops a recording.
function applyIntegrationSettings(values = readIntegrationSettings(fs, DATA_DIR)) {
  if (values.zoomAutoRecord) zoomWatcher.start();
  else {
    zoomWatcher.stop();
    autoRecord.release(SOURCES.zoom.id);
  }
  if (values.googleMeetAutoRecord) meetWatcher.start();
  else {
    meetWatcher.stop();
    autoRecord.release(SOURCES.googleMeet.id);
  }
}

let keyUnavailableNotified = false;

// Per-child env copy; the online key is never written to process.env. Null when the key is unavailable.
// Background polls notify once per outage so the 5s status refresh does not spam.
function processingEnv({ background = false } = {}) {
  const result = resolveProcessEnv({ fs, dataDir: DATA_DIR, secretStore, baseEnv: process.env });
  if (result.error) {
    if (!background || !keyUnavailableNotified) notify("Meeting processing paused", result.error);
    keyUnavailableNotified = true;
    return null;
  }
  keyUnavailableNotified = false;
  return result.env;
}

function icon(state) {
  const image = nativeImage.createFromPath(TRAY_ICON_PATHS[state] || TRAY_ICON_PATHS.idle);
  if (image.isEmpty()) {
    throw new Error(`Tray icon asset is unavailable for state: ${state}`);
  }
  image.setTemplateImage(true);
  return image;
}

function updateTrayIcon() {
  if (!tray) return;
  const state = trayIconState({
    isRecording: !recordingSession.idle,
    queueStatusError,
    queueSummary,
  });
  if (state === currentTrayIconState) return;
  tray.setImage(icon(state));
  currentTrayIconState = state;
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function pythonAvailable() {
  return Boolean(PYTHON) && fs.existsSync(PYTHON);
}

function notifyMissingPython() {
  const message = missingRuntimeMessage("python", { packaged: RUNTIME.packaged, resolvedPath: PYTHON });
  notify(message.title, message.body);
}

async function refreshQueueStatus() {
  if (queueStatusRefreshing) return;
  if (!pythonAvailable()) {
    queueStatusError = true;
    queueStatusReady = true;
    if (tray) updateMenu();
    return;
  }
  const env = processingEnv({ background: true });
  if (!env) {
    queueStatusError = true;
    queueStatusReady = true;
    if (tray) updateMenu();
    return;
  }
  queueStatusRefreshing = true;
  try {
    queueSummary = await readQueueStatus(PYTHON, CONFIG_PATH, execFile, env);
    queueStatusError = false;
  } catch (_) {
    queueStatusError = true;
  } finally {
    queueStatusReady = true;
    queueStatusRefreshing = false;
    if (tray) updateMenu();
  }
}

function openWikiWindow() {
  createWikiWindow(
    { app, BrowserWindow, ipcMain },
    { dataDir: DATA_DIR, python: PYTHON, configPath: CONFIG_PATH },
  );
}

function openSetupWindow() {
  createSetupWindow(
    { app, BrowserWindow, ipcMain },
    {
      fs,
      secretStore,
      dataDir: DATA_DIR,
      configPath: CONFIG_PATH,
      python: PYTHON,
      spawnFn: spawn,
      // Read only on an explicit Paste click; validated in setup-window.js and never stored.
      readClipboard: () => clipboard.readText(),
      onComplete: restartProcessing,
    },
  );
}

// Provider config is read at worker start, so a config change restarts the worker.
function restartProcessing() {
  if (worker) worker.kill("SIGTERM"); else startWorker();
  void refreshQueueStatus();
}

function openSettingsWindow() {
  createSettingsWindow(
    { app, BrowserWindow, ipcMain },
    {
      fs,
      dataDir: DATA_DIR,
      configPath: CONFIG_PATH,
      onSaved: restartProcessing,
      onRerunSetup: openSetupWindow,
      integrations,
    },
  );
}

// Fixed-text capability report; see self-check.js for the allowlisted codes.
let selfCheckRunning = false;
async function showSelfCheck() {
  if (selfCheckRunning) return;
  selfCheckRunning = true;
  try {
    const available = pythonAvailable();
    const env = available ? processingEnv() : null;
    const report = await runSelfCheck({
      python: PYTHON,
      configPath: CONFIG_PATH,
      pythonAvailable: available,
      env,
      mediaAccess: (type) => systemPreferences.getMediaAccessStatus(type),
      skillStatus: () => claudeSkillStatus(),
      execFileFn: execFile,
    });
    app.focus({ steal: true });
    await dialog.showMessageBox(formatSelfCheck(report));
  } catch (_) {
    notify("Self-check did not finish", "Open logs or try again.");
  } finally {
    selfCheckRunning = false;
  }
}

async function retryFailedJobs() {
  const env = processingEnv();
  if (!env) return;
  try {
    const count = await retryDeadJobs(PYTHON, CONFIG_PATH, execFile, env);
    notify("Meeting processing resumed", `${count} failed job${count === 1 ? "" : "s"} queued.`);
  } catch (error) {
    notify("Retry failed", error.message);
  }
  await refreshQueueStatus();
}

// Writes only the bundled template; the result dialog never includes user data.
let skillInstallRunning = false;
async function installSkillFromMenu() {
  if (skillInstallRunning) return;
  skillInstallRunning = true;
  try {
    await presentSkillInstall({
      install: installClaudeSkill,
      focus: () => app.focus({ steal: true }),
      showDialog: (options) => dialog.showMessageBox(options),
      notify,
    });
  } finally {
    skillInstallRunning = false;
  }
}

function startWorker() {
  if (worker || shuttingDown) return;
  if (!pythonAvailable()) return;
  const env = processingEnv();
  if (!env) return;
  const logDir = path.join(DATA_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDir, 0o700);
  const logPath = path.join(logDir, "worker.log");
  const log = fs.openSync(logPath, "a", 0o600);
  fs.chmodSync(logPath, 0o600);
  // -u: worker.log is a file, so unbuffered stdout keeps job events from sitting in a buffer.
  worker = spawn(PYTHON, ["-u", "-m", "meeting_wiki.cli", "--config", CONFIG_PATH, "worker"], {
    detached: false,
    env,
    stdio: ["ignore", log, log],
  });
  worker.once("exit", () => {
    worker = null;
    if (!shuttingDown) setTimeout(startWorker, 2_000).unref();
  });
}

function enqueue(
  filePath,
  title,
  isPrivate,
  titleExplicit,
  micAudioPath = null,
  systemAudioPath = null,
  occurredAt = null,
) {
  if (!pythonAvailable()) {
    notifyMissingPython();
    return;
  }
  const args = [
    "-m", "meeting_wiki.cli", "--config", CONFIG_PATH, "ingest",
    "--audio", filePath, "--title", title,
  ];
  if (micAudioPath) args.push("--mic-audio", micAudioPath);
  if (systemAudioPath) args.push("--system-audio", systemAudioPath);
  if (occurredAt) args.push("--occurred-at", occurredAt);
  if (!titleExplicit) args.push("--title-auto");
  if (isPrivate) args.push("--private");
  const env = processingEnv();
  if (!env) return;
  const child = spawn(PYTHON, args, { env, stdio: "ignore" });
  ingests.track(child);
  child.once("exit", (code) => {
    notify(code === 0 ? "Meeting queued" : "Meeting queue failed", path.basename(filePath));
    void refreshQueueStatus();
  });
}

// Live view is display-only: any failure here leaves capture and batch ingest untouched.
function startLiveSession(micPath, isPrivate) {
  if (!pythonAvailable() || !micPath) return;
  try {
    createLiveSidebarWindow({ BrowserWindow }, { onClosed: () => { void liveSession.stop(); } });
    liveSession.start({ micPath, isPrivate });
  } catch (_) {}
}

function stopLiveSession() {
  liveSession.stop().catch(() => {});
}

function readConfigText() {
  try {
    return fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (_) {
    return null;
  }
}

// Codes and the configured host only; the panel renders its own fixed copy.
function recordContext() {
  const available = pythonAvailable();
  return buildRecordContext({
    setupState: readSetupState(fs, DATA_DIR),
    configText: readConfigText(),
    pythonAvailable: available,
    keyAvailable: available && Boolean(processingEnv({ background: true })),
    maxDurationMinutes: readMaxDurationMinutes(fs, DATA_DIR),
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
    systemAudio: systemPreferences.getMediaAccessStatus("screen"),
    recording: !recordingSession.idle,
  });
}

// Every start goes through this explicit confirmation of title, privacy, capture, length, and live view.
function openRecordPanel() {
  if (!recordingSession.idle || quitRequested) return;
  createRecordWindow(
    { app, BrowserWindow, ipcMain },
    { getContext: recordContext, onStart: (request) => { void startRecording(request); } },
  );
}

// Manual starts come from the record panel; integration starts pass source and the join time.
// Both run the same capture, limit, live view, and notification. Returns true when recording began.
async function startRecording({ title: requestedTitle = "", isPrivate = false, source = null, occurredAt = null } = {}) {
  if (capture.active || !recordingSession.idle || quitRequested) return false;
  const maxDurationMinutes = readMaxDurationMinutes(fs, DATA_DIR);
  // Integration titles are placeholders, so processing still names the meeting from its content.
  const titleExplicit = Boolean(requestedTitle) && !source;
  const title = requestedTitle || `Meeting ${new Date().toLocaleString()}`;
  try {
    capture.start(timestamp());
  } catch (error) {
    notify("Recording failed", error.message);
    return false;
  }
  if (source) closeRecordWindow();
  recordingSession.begin(maxDurationMinutes * 60_000);
  updateMenu();
  notify(isPrivate ? "Private recording started" : "Recording started", title);
  capture.active.title = title;
  capture.active.titleExplicit = titleExplicit;
  capture.active.private = isPrivate;
  capture.active.occurredAt = occurredAt;
  startLiveSession(capture.active.micPath, isPrivate);
  return true;
}

// The limit, the user, and quit share one single-flight stop; the batch path is identical for all.
function stopRecording(reason = "user") {
  return recordingSession.end(reason, async () => {
    if (!capture.active) return;
    const title = capture.active.title;
    const titleExplicit = capture.active.titleExplicit;
    const isPrivate = capture.active.private;
    const occurredAt = capture.active.occurredAt || null;
    if (reason === "limit") notify(LIMIT_NOTICE.title, LIMIT_NOTICE.body);
    stopLiveSession();
    updateMenu();
    try {
      const files = await capture.stop();
      enqueue(
        files.audioPath,
        title,
        isPrivate,
        titleExplicit,
        files.micAudioPath,
        files.systemAudioPath,
        occurredAt,
      );
      notify("Recording saved", files.audioPath);
    } catch (error) {
      notify("Recording failed", error.message);
    }
  }).finally(() => {
    autoRecord.release();
    updateMenu();
  });
}

// Shares the single-flight guard, so a discard never races a limit, user, or quit stop.
function discardRecording() {
  return recordingSession.end("discard", async () => {
    stopLiveSession();
    await capture.discard();
  }).finally(() => {
    autoRecord.release();
    updateMenu();
  });
}

// Privacy is chosen per import; nothing carries over from an earlier action.
function importConfirmation(count) {
  return {
    type: "question",
    title: "Meeting Wiki",
    message: `Import ${count} audio file${count === 1 ? "" : "s"}?`,
    detail: "Each file is processed like a recording and named from what was discussed.",
    checkboxLabel: "Keep private: notes stay only in the private folder on this Mac",
    checkboxChecked: false,
    buttons: ["Import", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

async function importAudio() {
  const result = await dialog.showOpenDialog({
    title: "Import audio",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const choice = await dialog.showMessageBox(importConfirmation(result.filePaths.length));
  if (choice.response !== 0) return;
  for (const file of result.filePaths) enqueue(file, "Imported meeting", choice.checkboxChecked === true, false);
  updateMenu();
}

function updateMenu() {
  updateTrayIcon();
  const items = [];
  if (recordingSession.recording) {
    items.push(
      { label: recordingLabel(recordingSession), enabled: false },
      ...(liveIssue ? [{ label: "Live captions unavailable. Recording continues.", enabled: false }] : []),
      { label: "Stop and process", accelerator: "CommandOrControl+Shift+0", click: () => { void stopRecording("user"); } },
      { label: "Stop and discard", click: () => { void discardRecording(); } },
    );
  } else if (recordingSession.stopping) {
    items.push({ label: SAVING_LABEL, enabled: false });
  } else {
    if (recordingSession.lastStopReason === "limit") items.push({ label: LIMIT_REACHED_LABEL, enabled: false });
    items.push(
      { label: "Start recording...", accelerator: "CommandOrControl+Shift+0", click: openRecordPanel },
      { label: "Import audio...", click: importAudio },
    );
  }
  const processingLabel = queueStatusError
    ? "Processing status unavailable"
    : queueStatusReady
      ? formatQueueLabel(queueSummary)
      : "Checking processing status...";
  items.push(
    { type: "separator" },
    { label: processingLabel, enabled: false },
  );
  if (queueSummary.action_required > 0) {
    items.push({ label: "Retry failed processing", click: retryFailedJobs });
  }
  items.push(
    { label: "Run self-check...", click: () => { void showSelfCheck(); } },
    { label: "Open logs", click: () => shell.openPath(path.join(DATA_DIR, "logs")) },
    { type: "separator" },
    { label: "Open Wiki & Corrections", click: openWikiWindow },
    { label: INSTALL_SKILL_LABEL, toolTip: INSTALL_SKILL_TOOLTIP, click: () => { void installSkillFromMenu(); } },
    { label: "Open wiki", click: () => shell.openPath(path.join(DATA_DIR, "wiki")) },
    { label: "Open private meetings", click: () => shell.openPath(path.join(DATA_DIR, "private", "meetings")) },
    { type: "separator" },
    { label: "Settings...", click: openSettingsWindow },
    { label: "Run setup...", click: openSetupWindow },
    { label: "Edit configuration", toolTip: APPLIES.manualEdit, click: () => shell.openPath(CONFIG_PATH) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

app.whenReady().then(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DATA_DIR, 0o700);
  fs.chmodSync(RECORDINGS_DIR, 0o700);
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status !== "granted") {
    app.dock.show();
    await systemPreferences.askForMediaAccess("microphone");
  }
  app.dock.hide();
  tray = new Tray(icon("idle"));
  tray.on("click", () => tray.popUpContextMenu());
  globalShortcut.register("CommandOrControl+Shift+0", () => {
    if (recordingSession.recording) void stopRecording("user");
    else if (recordingSession.idle) openRecordPanel();
  });
  startWorker();
  if (RUNTIME.packaged && !pythonAvailable()) notifyMissingPython();
  updateMenu();
  void refreshQueueStatus();
  startIntegrations();
  if (needsSetup(fs, DATA_DIR, CONFIG_PATH)) openSetupWindow();
});

// Re-pairs Meet so a moved or updated app keeps a valid host path, then starts enabled watchers.
function startIntegrations() {
  const values = readIntegrationSettings(fs, DATA_DIR);
  if (values.googleMeetAutoRecord) {
    try {
      meetBridge.pair();
    } catch (_) {
      notify("Google Meet automatic recording needs attention", "Open Settings to check the browser connection.");
    }
  }
  applyIntegrationSettings(values);
}

setInterval(() => {
  if (!tray || recordingSession.idle) return;
  recordingSession.checkDeadline();
  updateMenu();
}, 1000).unref();
setInterval(() => { if (tray) void refreshQueueStatus(); }, 5000).unref();

async function prepareQuit() {
  try {
    await stopRecording("quit");
  } catch (_) {}
  await ingests.drain(QUIT_INGEST_TIMEOUT_MS);
  quitPrepared = true;
  app.quit();
}

app.on("before-quit", (event) => {
  if (quitPrepared || (recordingSession.idle && ingests.size === 0)) return;
  event.preventDefault();
  if (quitRequested) return;
  quitRequested = true;
  if (!recordingSession.idle) notify(QUIT_NOTICE.title, QUIT_NOTICE.body);
  void prepareQuit();
});

app.on("will-quit", () => {
  shuttingDown = true;
  zoomWatcher.stop();
  meetWatcher.stop();
  globalShortcut.unregisterAll();
  closeRecordWindow();
  if (worker) worker.kill("SIGTERM");
  stopLiveSession();
  // Recordings are never discarded on quit; before-quit already saved and queued them.
});

app.on("window-all-closed", (event) => event.preventDefault());
