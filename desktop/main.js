"use strict";

const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, systemPreferences, Tray } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Meeting audio, titles, job payloads and logs are sensitive on shared Macs.
process.umask(0o077);
const { AudioCapture, buildCaptureManifest, captureManifestPath } = require("./capture");
const { createWikiWindow } = require("./wiki-window");
const { createSecretStore } = require("./secret-store");
const { createSetupWindow, credentialFreeEnv, needsSetup, resolveProcessEnv } = require("./setup-window");
const { createSettingsWindow } = require("./settings-window");
const { buildRecordContext, closeRecordWindow, createRecordWindow } = require("./record-window");
const { LiveSessionManager } = require("./live-session");
const { createLiveSidebarWindow, destroyLiveSidebar, liveSidebarAvailable, publishLiveEvent, showLiveSidebar } = require("./live-sidebar-window");
const { missingRuntimeMessage, resolveRuntimePaths } = require("./runtime-paths");
const { claudeSkillStatus, installClaudeSkill, presentSkillInstall } = require("./skill-installer");
const { formatSelfCheck, runSelfCheck } = require("./self-check");
const { presentShimInstall } = require("./cli-installer");
const { readMaxDurationMinutes } = require("./recording-settings");
const { APPLIES } = require("./setting-metadata");
const { AutoRecordCoordinator, SHORT_DISCARD_NOTICE, SOURCES } = require("./auto-record");
const { autoRecordStartOptions, readAutoRecordPrivacy, readIntegrationSettings } = require("./integration-settings");
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
  RestartBackoff,
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
let workerRetryTimer = null;
// A worker that ran this long is healthy, so its next restart starts from the base delay.
const WORKER_STABLE_MS = 30_000;
const workerBackoff = new RestartBackoff({ baseMs: 2_000, maxMs: 60_000 });
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
      // Hand-edited configs open the sidebar only once the child proves it has an adapter.
      if (event.phase === "listening" && liveSession.active && !liveSidebarAvailable()) {
        try { createLiveSidebarWindow({ BrowserWindow }); } catch (_) {}
      }
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
  // Automatic starts follow the same setup gate as the record panel.
  canStart: () => recordingSession.idle && !capture.active && !quitRequested && !needsSetup(fs, DATA_DIR, CONFIG_PATH),
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

// Queueing and capture recovery only write the local job store, so provider keys stay out.
function ingestEnv() {
  return credentialFreeEnv(process.env);
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
  workerBackoff.reset();
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

// Fixed text plus the count only; job titles never appear in this dialog.
function retryConfirmation(count) {
  return {
    type: "question",
    title: "Meeting Wiki",
    message: `Retry ${count} failed job${count === 1 ? "" : "s"}?`,
    detail: "Each one is processed again with the current provider settings. Open Wiki & Corrections to retry jobs one at a time.",
    buttons: ["Retry", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

async function retryFailedJobs() {
  const count = Number(queueSummary.action_required) || 0;
  if (count < 1) return;
  app.focus({ steal: true });
  const choice = await dialog.showMessageBox(retryConfirmation(count));
  if (choice.response !== 0) return;
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

// User-triggered only: a fixed confirmation, then fixed-text results. Never overwrites files.
let shimInstallRunning = false;
async function installShimsFromMenu() {
  if (shimInstallRunning) return;
  shimInstallRunning = true;
  try {
    await presentShimInstall({
      focus: () => app.focus({ steal: true }),
      showDialog: (options) => dialog.showMessageBox(options),
      notify,
    });
  } catch (_) {
    notify("Command-line tools not installed", "Try again from the menu bar.");
  } finally {
    shimInstallRunning = false;
  }
}

// Retries run in the background so a key outage notifies once, then starts on its own after recovery.
function scheduleWorkerStart() {
  if (shuttingDown || worker || workerRetryTimer) return;
  workerRetryTimer = setTimeout(() => {
    workerRetryTimer = null;
    startWorker({ background: true });
  }, workerBackoff.nextDelayMs());
  workerRetryTimer.unref();
}

function startWorker({ background = false } = {}) {
  if (worker || shuttingDown) return;
  if (workerRetryTimer) {
    clearTimeout(workerRetryTimer);
    workerRetryTimer = null;
  }
  if (!pythonAvailable()) return;
  const env = processingEnv({ background });
  if (!env) {
    scheduleWorkerStart();
    return;
  }
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
  const startedAt = Date.now();
  worker.once("exit", () => {
    worker = null;
    if (Date.now() - startedAt >= WORKER_STABLE_MS) workerBackoff.reset();
    scheduleWorkerStart();
  });
}

function audioIngestArgs({ filePath, title, isPrivate, titleExplicit, micAudioPath = null, systemAudioPath = null, occurredAt = null, recordingStartedAt = null, requireCalendarMatch = false }) {
  const args = ["--audio", filePath, "--title", title];
  if (requireCalendarMatch) args.push("--require-calendar-match");
  if (micAudioPath) args.push("--mic-audio", micAudioPath);
  if (systemAudioPath) args.push("--system-audio", systemAudioPath);
  if (occurredAt) args.push("--occurred-at", occurredAt);
  if (recordingStartedAt) args.push("--recording-started-at", recordingStartedAt);
  if (!titleExplicit) args.push("--title-auto");
  if (isPrivate) args.push("--private");
  return args;
}

function enqueue(ingestArgs, label) {
  if (!pythonAvailable()) {
    notifyMissingPython();
    return;
  }
  const env = ingestEnv();
  const child = spawn(PYTHON, ["-m", "meeting_wiki.cli", "--config", CONFIG_PATH, "ingest", ...ingestArgs], { env, stdio: "ignore" });
  ingests.track(child);
  child.once("exit", (code) => {
    notify(code === 0 ? "Meeting queued" : "Meeting queue failed", label);
    void refreshQueueStatus();
  });
}

// Finalized recordings whose manifest outlived a failed hand-off are queued again at startup.
function recoverPendingCaptures() {
  if (!pythonAvailable()) return;
  execFile(PYTHON, ["-m", "meeting_wiki.cli", "--config", CONFIG_PATH, "recover-captures"], { env: ingestEnv(), timeout: 60_000 }, (error, stdout) => {
    if (error) {
      notify("Saved recordings were not queued", "Meeting Wiki will try again at next launch.");
      return;
    }
    let summary = {};
    try { summary = JSON.parse(String(stdout).trim().split("\n").pop() || "{}"); } catch (_) {}
    const recovered = Number(summary.recovered) || 0;
    const invalid = Number(summary.invalid) || 0;
    if (recovered > 0) notify("Saved recordings queued", `${recovered} recording${recovered === 1 ? " was" : "s were"} queued for processing.`);
    if (invalid > 0) notify("Saved recordings need attention", `${invalid} saved recording${invalid === 1 ? "" : "s"} could not be queued. Import the audio to process it.`);
    void refreshQueueStatus();
  });
}

// Live view is display-only: any failure here leaves capture and batch ingest untouched.
// Closing the sidebar hides it; only the end of the recording stops live and destroys it.
function startLiveSession(micPath, isPrivate, live) {
  if (!pythonAvailable() || !micPath) return;
  try {
    if (live.live === "ready") createLiveSidebarWindow({ BrowserWindow });
    liveSession.start({ micPath, isPrivate });
  } catch (_) {}
}

function stopLiveSession() {
  liveSession.stop().catch(() => {});
  destroyLiveSidebar();
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
    setupComplete: !needsSetup(fs, DATA_DIR, CONFIG_PATH),
    configText: readConfigText(),
    pythonAvailable: available,
    keyAvailable: available && Boolean(processingEnv({ background: true })),
    maxDurationMinutes: readMaxDurationMinutes(fs, DATA_DIR),
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
    recording: !recordingSession.idle,
  });
}

// Every start goes through this explicit confirmation of title, privacy, capture, length, and live view.
function openRecordPanel() {
  if (!recordingSession.idle || quitRequested) return;
  createRecordWindow(
    { app, BrowserWindow, ipcMain },
    {
      getContext: recordContext,
      onStart: (request) => { void startRecording(request); },
      onOpenSetup: openSetupWindow,
      openExternal: (url) => { void shell.openExternal(url); },
    },
  );
}

// Manual starts come from the record panel; integration starts pass source and the join time.
// Both run the same capture, limit, live view, and notification. Returns true when recording began.
// Automatic starts ignore any caller privacy and use the saved automatic-recording mode.
async function startRecording({ title: requestedTitle = "", isPrivate: requestedPrivate = false, source = null, occurredAt = null } = {}) {
  if (capture.active || !recordingSession.idle || quitRequested) return false;
  const auto = source ? autoRecordStartOptions(readAutoRecordPrivacy(fs, DATA_DIR).mode) : null;
  const isPrivate = auto ? auto.isPrivate : requestedPrivate === true;
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
  capture.active.requireCalendarMatch = Boolean(auto && auto.requireCalendarMatch);
  capture.active.occurredAt = occurredAt;
  // Calendar matching uses the capture start, never the stop or queue time.
  capture.active.recordingStartedAt = new Date().toISOString();
  let liveDecision = { liveStarts: false };
  try { liveDecision = recordContext(); } catch (_) {}
  if (liveDecision.liveStarts) startLiveSession(capture.active.micPath, isPrivate, liveDecision);
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
    const recordingStartedAt = capture.active.recordingStartedAt;
    const requireCalendarMatch = capture.active.requireCalendarMatch === true;
    if (reason === "limit") notify(LIMIT_NOTICE.title, LIMIT_NOTICE.body);
    stopLiveSession();
    updateMenu();
    try {
      const files = await capture.stop();
      const metadata = { title, titleExplicit, isPrivate, recordingStartedAt, occurredAt, requireCalendarMatch };
      const manifestPath = captureManifestPath(files.audioPath);
      try {
        atomicWriteFile(fs, manifestPath, JSON.stringify(buildCaptureManifest(files, metadata)));
      } catch (_) {
        // Without a manifest there is no startup recovery, so queue directly from the same metadata.
        enqueue(audioIngestArgs({ filePath: files.audioPath, ...files, ...metadata }), path.basename(files.audioPath));
        notify("Recording saved", files.audioPath);
        return;
      }
      enqueue(["--capture-manifest", manifestPath], path.basename(files.audioPath));
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
  // Imported files carry no capture time, so they are never matched to the event happening now.
  for (const file of result.filePaths) {
    enqueue(
      audioIngestArgs({ filePath: file, title: "Imported meeting", isPrivate: choice.checkboxChecked === true, titleExplicit: false }),
      path.basename(file),
    );
  }
  updateMenu();
}

function updateMenu() {
  updateTrayIcon();
  const items = [];
  if (recordingSession.recording) {
    items.push(
      { label: recordingLabel(recordingSession), enabled: false },
      ...(liveIssue ? [{ label: "Live captions unavailable. Recording continues.", enabled: false }] : []),
      ...(liveSidebarAvailable() ? [{ label: "Show live captions", click: () => { showLiveSidebar(); } }] : []),
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
    { label: "Install command-line tools...", click: () => { void installShimsFromMenu(); } },
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
  recoverPendingCaptures();
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
  if (quitPrepared || (recordingSession.idle && ingests.size === 0)) {
    // The sidebar hides on close, so it must be destroyed or it would cancel the quit.
    destroyLiveSidebar();
    return;
  }
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
