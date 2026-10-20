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
const { createSetupWindow, needsSetup, resolveProcessEnv } = require("./setup-window");
const { createSettingsWindow } = require("./settings-window");
const { LiveSessionManager } = require("./live-session");
const { createLiveSidebarWindow, publishLiveEvent } = require("./live-sidebar-window");
const { missingRuntimeMessage, resolveRuntimePaths } = require("./runtime-paths");
const { claudeSkillStatus, installClaudeSkill, presentSkillInstall } = require("./skill-installer");
const { formatSelfCheck, runSelfCheck } = require("./self-check");
const { readMaxDurationMinutes } = require("./recording-settings");
const { APPLIES } = require("./setting-metadata");
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
let nextTitle = "";
let nextPrivate = false;
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

function askTitle() {
  return new Promise((resolve) => {
    const script = 'text returned of (display dialog "Title for the next meeting:" default answer "" with title "Meeting Wiki")';
    execFile("osascript", ["-e", script], (error, stdout) => {
      resolve(error ? "" : stdout.trim());
    });
  });
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

async function startRecording() {
  if (capture.active || !recordingSession.idle || quitRequested) return;
  const maxDurationMinutes = readMaxDurationMinutes(fs, DATA_DIR);
  const titleExplicit = Boolean(nextTitle);
  const title = nextTitle || `Meeting ${new Date().toLocaleString()}`;
  const isPrivate = nextPrivate;
  nextTitle = "";
  nextPrivate = false;
  try {
    capture.start(timestamp());
  } catch (error) {
    notify("Recording failed", error.message);
    return;
  }
  recordingSession.begin(maxDurationMinutes * 60_000);
  updateMenu();
  notify(isPrivate ? "Private recording started" : "Recording started", title);
  capture.active.title = title;
  capture.active.titleExplicit = titleExplicit;
  capture.active.private = isPrivate;
  startLiveSession(capture.active.micPath, isPrivate);
}

// The limit, the user, and quit share one single-flight stop; the batch path is identical for all.
function stopRecording(reason = "user") {
  return recordingSession.end(reason, async () => {
    if (!capture.active) return;
    const title = capture.active.title;
    const titleExplicit = capture.active.titleExplicit;
    const isPrivate = capture.active.private;
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
      );
      notify("Recording saved", files.audioPath);
    } catch (error) {
      notify("Recording failed", error.message);
    }
  }).finally(updateMenu);
}

// Shares the single-flight guard, so a discard never races a limit, user, or quit stop.
function discardRecording() {
  return recordingSession.end("discard", async () => {
    stopLiveSession();
    await capture.discard();
  }).finally(updateMenu);
}

async function importAudio() {
  const result = await dialog.showOpenDialog({
    title: "Import audio",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"] }],
  });
  if (result.canceled) return;
  const titleExplicit = Boolean(nextTitle);
  const title = nextTitle || "Imported meeting";
  for (const file of result.filePaths) enqueue(file, title, nextPrivate, titleExplicit);
  nextTitle = "";
  nextPrivate = false;
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
      { label: "Start recording", accelerator: "CommandOrControl+Shift+0", click: startRecording },
      { label: `${nextPrivate ? "✓" : ""} Mark next recording private`, click: () => { nextPrivate = !nextPrivate; updateMenu(); } },
      { label: `Set next title${nextTitle ? `: ${nextTitle}` : "..."}`, click: async () => { nextTitle = await askTitle(); updateMenu(); } },
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
    else if (recordingSession.idle) void startRecording();
  });
  startWorker();
  if (RUNTIME.packaged && !pythonAvailable()) notifyMissingPython();
  updateMenu();
  void refreshQueueStatus();
  if (needsSetup(fs, DATA_DIR, CONFIG_PATH)) openSetupWindow();
});

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
  globalShortcut.unregisterAll();
  if (worker) worker.kill("SIGTERM");
  stopLiveSession();
  // Recordings are never discarded on quit; before-quit already saved and queued them.
});

app.on("window-all-closed", (event) => event.preventDefault());
