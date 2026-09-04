"use strict";

const { app, dialog, globalShortcut, Menu, nativeImage, Notification, shell, systemPreferences, Tray } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Meeting audio, titles, job payloads and logs are sensitive on shared Macs.
process.umask(0o077);
const { AudioCapture } = require("./capture");

const DATA_DIR = process.env.MEETING_WIKI_DATA_DIR || path.join(os.homedir(), ".meeting-wiki");
const RECORDINGS_DIR = path.join(DATA_DIR, "audio");
const CONFIG_PATH = process.env.MEETING_WIKI_CONFIG || path.join(DATA_DIR, "config.toml");
const PYTHON = process.env.MEETING_WIKI_PYTHON || path.join(DATA_DIR, "venv", "bin", "python");
const AUDIO_TEE = path.join(__dirname, "node_modules", "audiotee", "bin", "audiotee").replace("app.asar", "app.asar.unpacked");

let tray;
let worker;
let shuttingDown = false;
let recordingStartedAt;
let nextTitle = "";
let nextPrivate = false;

const capture = new AudioCapture({
  recordingsDir: RECORDINGS_DIR,
  audioTeePath: AUDIO_TEE,
  onError: (error) => notify("Audio capture error", error.message),
});

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
  if (!fs.existsSync(PYTHON)) return;
  const logDir = path.join(DATA_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDir, 0o700);
  const logPath = path.join(logDir, "worker.log");
  const log = fs.openSync(logPath, "a", 0o600);
  fs.chmodSync(logPath, 0o600);
  worker = spawn(PYTHON, ["-m", "meeting_wiki.cli", "--config", CONFIG_PATH, "worker"], {
    detached: false,
    stdio: ["ignore", log, log],
  });
  worker.once("exit", () => {
    worker = null;
    if (!shuttingDown) setTimeout(startWorker, 2_000).unref();
  });
}

function enqueue(filePath, title, isPrivate) {
  if (!fs.existsSync(PYTHON)) {
    notify("Meeting Wiki setup required", "Run scripts/setup.sh before processing meetings.");
    return;
  }
  const args = [
    "-m", "meeting_wiki.cli", "--config", CONFIG_PATH, "ingest",
    "--audio", filePath, "--title", title,
  ];
  if (isPrivate) args.push("--private");
  const child = spawn(PYTHON, args, { stdio: "ignore" });
  child.once("exit", (code) => {
    notify(code === 0 ? "Meeting queued" : "Meeting queue failed", path.basename(filePath));
  });
}

async function startRecording() {
  if (capture.active) return;
  const title = nextTitle || `Meeting ${new Date().toLocaleString()}`;
  const isPrivate = nextPrivate;
  nextTitle = "";
  nextPrivate = false;
  capture.start(timestamp());
  recordingStartedAt = Date.now();
  updateMenu();
  notify(isPrivate ? "Private recording started" : "Recording started", title);
  capture.active.title = title;
  capture.active.private = isPrivate;
}

async function stopRecording() {
  if (!capture.active) return;
  const title = capture.active.title;
  const isPrivate = capture.active.private;
  try {
    const file = await capture.stop();
    enqueue(file, title, isPrivate);
    notify("Recording saved", file);
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
  const title = nextTitle || "Imported meeting";
  for (const file of result.filePaths) enqueue(file, title, nextPrivate);
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
  items.push(
    { type: "separator" },
    { label: "Open wiki", click: () => shell.openPath(path.join(DATA_DIR, "wiki")) },
    { label: "Open private meetings", click: () => shell.openPath(path.join(DATA_DIR, "private", "meetings")) },
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
  updateMenu();
});

setInterval(() => { if (tray && capture.active) updateMenu(); }, 1000).unref();

app.on("will-quit", () => {
  shuttingDown = true;
  globalShortcut.unregisterAll();
  if (worker) worker.kill("SIGTERM");
  if (capture.active) void capture.discard();
});

app.on("window-all-closed", (event) => event.preventDefault());
