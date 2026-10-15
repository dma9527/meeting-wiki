"use strict";

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, systemPreferences, Tray } = require("electron");
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
const { missingRuntimeMessage, resolveRuntimePaths } = require("./runtime-paths");
const {
  formatQueueLabel,
  readDoctorStatus,
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

let tray;
let worker;
let shuttingDown = false;
let recordingStartedAt;
let nextTitle = "";
let nextPrivate = false;
let queueSummary = { total: 0, active: 0, action_required: 0 };
let queueStatusReady = false;
let queueStatusError = false;
let queueStatusRefreshing = false;

const capture = new AudioCapture({
  recordingsDir: RECORDINGS_DIR,
  audioTeePath: AUDIO_TEE,
  recBin: RUNTIME.rec,
  soxBin: RUNTIME.sox,
  packaged: RUNTIME.packaged,
  onError: (error) => notify("Audio capture error", error.message),
});
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

function icon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect x="6" y="2" width="6" height="10" rx="3" fill="black"/><path d="M4 8a5 5 0 0010 0M9 13v3M6 16h6" fill="none" stroke="black" stroke-width="1.5"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(true);
  return image;
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
  if (queueStatusRefreshing || !pythonAvailable()) return;
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
      onComplete: () => {
        // Pick up the new provider config on the next worker start.
        if (worker) worker.kill("SIGTERM"); else startWorker();
        void refreshQueueStatus();
      },
    },
  );
}

async function showSystemHealth() {
  if (!pythonAvailable()) {
    notifyMissingPython();
    return;
  }
  const env = processingEnv();
  if (!env) return;
  const health = await readDoctorStatus(PYTHON, CONFIG_PATH, execFile, env);
  await dialog.showMessageBox({
    type: health.ok ? "info" : "warning",
    title: "Meeting Wiki health",
    message: health.ok ? "All configured providers are ready." : "Setup needs attention.",
    detail: health.text,
  });
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
  worker = spawn(PYTHON, ["-m", "meeting_wiki.cli", "--config", CONFIG_PATH, "worker"], {
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
  child.once("exit", (code) => {
    notify(code === 0 ? "Meeting queued" : "Meeting queue failed", path.basename(filePath));
    void refreshQueueStatus();
  });
}

async function startRecording() {
  if (capture.active) return;
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
  recordingStartedAt = Date.now();
  updateMenu();
  notify(isPrivate ? "Private recording started" : "Recording started", title);
  capture.active.title = title;
  capture.active.titleExplicit = titleExplicit;
  capture.active.private = isPrivate;
}

async function stopRecording() {
  if (!capture.active) return;
  const title = capture.active.title;
  const titleExplicit = capture.active.titleExplicit;
  const isPrivate = capture.active.private;
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
  recordingStartedAt = null;
  updateMenu();
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
  const items = [];
  if (capture.active) {
    const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
    items.push(
      { label: `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`, enabled: false },
      { label: "Stop and process", accelerator: "CommandOrControl+Shift+0", click: stopRecording },
      { label: "Stop and discard", click: async () => { await capture.discard(); recordingStartedAt = null; updateMenu(); } },
    );
  } else {
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
    { label: "Check system health...", click: showSystemHealth },
    { label: "Open logs", click: () => shell.openPath(path.join(DATA_DIR, "logs")) },
    { type: "separator" },
    { label: "Open Wiki & Corrections", click: openWikiWindow },
    { label: "Open wiki", click: () => shell.openPath(path.join(DATA_DIR, "wiki")) },
    { label: "Open private meetings", click: () => shell.openPath(path.join(DATA_DIR, "private", "meetings")) },
    { label: "Run setup...", click: openSetupWindow },
    { label: "Edit configuration", click: () => shell.openPath(CONFIG_PATH) },
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
  tray = new Tray(icon());
  tray.on("click", () => tray.popUpContextMenu());
  globalShortcut.register("CommandOrControl+Shift+0", () => {
    if (capture.active) void stopRecording(); else void startRecording();
  });
  startWorker();
  if (RUNTIME.packaged && !pythonAvailable()) notifyMissingPython();
  updateMenu();
  void refreshQueueStatus();
  if (needsSetup(fs, DATA_DIR, CONFIG_PATH)) openSetupWindow();
});

setInterval(() => { if (tray && capture.active) updateMenu(); }, 1000).unref();
setInterval(() => { if (tray) void refreshQueueStatus(); }, 5000).unref();

app.on("will-quit", () => {
  shuttingDown = true;
  globalShortcut.unregisterAll();
  if (worker) worker.kill("SIGTERM");
  if (capture.active) void capture.discard();
});

app.on("window-all-closed", (event) => event.preventDefault());
