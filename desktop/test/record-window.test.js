"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const record = require("../record-window");
const setup = require("../setup-window");

const DESKTOP = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(DESKTOP, relative), "utf8");

const BASE = Object.freeze({
  setupComplete: true,
  pythonAvailable: true,
  keyAvailable: true,
  maxDurationMinutes: 90,
  microphone: "granted",
  recording: false,
});

test("a managed Gemini setup reports external live captions ready", () => {
  const context = record.buildRecordContext({ ...BASE, configText: setup.renderGeminiConfig() });
  assert.deepEqual(context, {
    setupComplete: true,
    blockers: [],
    maxDurationMinutes: 90,
    microphone: "granted",
    systemAudio: "not_checkable",
    destination: "gemini",
    host: "",
    live: "ready",
    liveStarts: true,
    liveScope: "external",
    recording: false,
  });
});

test("system audio readiness is never derived from the screen recording status", () => {
  const context = record.buildRecordContext({ ...BASE, configText: setup.renderGeminiConfig(), systemAudio: "granted" });
  assert.equal(context.systemAudio, "not_checkable");
  assert.doesNotMatch(read("main.js"), /systemAudio: systemPreferences\.getMediaAccessStatus\("screen"\)/);
});

test("incomplete setup and a blocked microphone are blockers", () => {
  const gemini = setup.renderGeminiConfig();
  assert.deepEqual(record.buildRecordContext({ ...BASE, configText: gemini, setupComplete: false }).blockers, ["setup_incomplete"]);
  for (const microphone of ["denied", "restricted"]) {
    assert.deepEqual(record.buildRecordContext({ ...BASE, configText: gemini, microphone }).blockers, ["microphone_blocked"]);
  }
  assert.deepEqual(record.buildRecordContext({ ...BASE, configText: gemini, microphone: "not-determined" }).blockers, []);
  assert.deepEqual(
    record.buildRecordContext({ ...BASE, configText: gemini, setupComplete: false, microphone: "denied" }).blockers,
    ["setup_incomplete", "microphone_blocked"],
  );
});

test("the controller refuses to start while a blocker remains", () => {
  const started = [];
  const controller = record.createRecordController({
    getContext: () => ({ recording: false, blockers: ["microphone_blocked"] }),
    onStart: (request) => started.push(request),
  });
  assert.throws(() => controller.start({ privacyMode: "shared", liveEnabled: false }), /Microphone access is blocked/);
  const setupController = record.createRecordController({
    getContext: () => ({ recording: false, blockers: ["setup_incomplete"] }),
    onStart: (request) => started.push(request),
  });
  assert.throws(() => setupController.start({ privacyMode: "shared", liveEnabled: false }), /Finish setup/);
  assert.equal(started.length, 0);
});

test("only fixed privacy panes can be opened and setup opens through a callback", () => {
  const opened = [];
  let setupOpened = 0;
  const controller = record.createRecordController({
    getContext: () => ({ recording: false, blockers: [] }),
    onStart: () => {},
    openExternal: (url) => opened.push(url),
    onOpenSetup: () => { setupOpened += 1; },
  });
  controller.openPrivacySettings("microphone");
  controller.openPrivacySettings("systemAudio");
  assert.deepEqual(opened, [record.PRIVACY_PANES.microphone, record.PRIVACY_PANES.systemAudio]);
  for (const bad of ["camera", "x-apple.systempreferences:evil", "", 5, null]) {
    assert.throws(() => controller.openPrivacySettings(bad), /privacy setting/);
  }
  assert.equal(opened.length, 2);
  for (const url of Object.values(record.PRIVACY_PANES)) {
    assert.match(url, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_[A-Za-z]+$/);
  }
  controller.openSetup();
  assert.equal(setupOpened, 1);
});

test("live captions start only for providers with a live adapter", () => {
  const online = setup.renderOnlineConfig({
    baseUrl: "https://provider.example.test/v1",
    transcriptionModel: "test-transcribe",
    languageModel: "test-language",
  });
  assert.equal(record.buildRecordContext({ ...BASE, configText: online }).liveStarts, false);
  const gemini = setup.renderGeminiConfig();
  assert.equal(record.buildRecordContext({ ...BASE, configText: gemini, keyAvailable: false }).liveStarts, false);
  assert.equal(record.buildRecordContext({ ...BASE, configText: gemini, pythonAvailable: false }).liveStarts, false);
  assert.equal(record.buildRecordContext({ ...BASE, configText: '[providers]\nllm = "ollama"\n' }).liveStarts, true);
});

test("an OpenAI-compatible setup shows only its host and no live adapter", () => {
  const configText = setup.renderOnlineConfig({
    baseUrl: "https://provider.example.test/v1",
    transcriptionModel: "test-transcribe",
    languageModel: "test-language",
  });
  const context = record.buildRecordContext({ ...BASE, configText });
  assert.equal(context.destination, "openai_compatible");
  assert.equal(context.host, "provider.example.test");
  assert.equal(context.live, "no_adapter");
  assert.ok(!JSON.stringify(context).includes("test-transcribe"));
});

test("engine, key, manual config, permissions, and recording state map to codes", () => {
  const gemini = setup.renderGeminiConfig();
  assert.equal(record.buildRecordContext({ ...BASE, configText: gemini, pythonAvailable: false }).live, "engine_missing");
  assert.equal(record.buildRecordContext({ ...BASE, configText: gemini, keyAvailable: false }).live, "key_unavailable");
  const manual = record.buildRecordContext({ ...BASE, configText: '[providers]\nllm = "ollama"\n' });
  assert.equal(manual.live, "manual");
  assert.equal(manual.destination, "manual");
  assert.equal(manual.liveScope, "unknown");
  const odd = record.buildRecordContext({ ...BASE, configText: null, microphone: "weird", recording: true });
  assert.equal(odd.microphone, "unknown");
  assert.equal(odd.recording, true);
});

test("start requests accept a one-line title, explicit privacy, and a strict live opt-out", () => {
  assert.deepEqual(record.validateStartRequest({ title: "  Weekly \n sync  ", privacyMode: "private", liveEnabled: false }), {
    title: "Weekly sync",
    isPrivate: true,
    liveEnabled: false,
  });
  assert.deepEqual(record.validateStartRequest({ privacyMode: "shared" }), { title: "", isPrivate: false, liveEnabled: false });
  for (const privacyMode of ["", "calendar", true, null, undefined]) {
    assert.throws(() => record.validateStartRequest({ privacyMode }), /Choose where the notes go/);
  }
  for (const flag of ["false", 0, null]) {
    assert.throws(() => record.validateStartRequest({ privacyMode: "shared", liveEnabled: flag }), /Choose whether live/);
  }
  assert.throws(() => record.validateStartRequest({ title: "x".repeat(201) }), /200 characters/);
  assert.throws(() => record.validateStartRequest({ title: "bad\u0001title" }), /control characters/);
  assert.throws(() => record.validateStartRequest({ title: 5 }), /plain text/);
});

test("the controller starts only when idle and passes the validated request", () => {
  const started = [];
  let recording = false;
  const controller = record.createRecordController({
    getContext: () => ({ recording, blockers: [] }),
    onStart: (request) => started.push(request),
  });
  assert.deepEqual(controller.start({ title: "Design review", privacyMode: "private", liveEnabled: false, extra: "dropped" }), { ok: true });
  assert.deepEqual(started, [{ title: "Design review", isPrivate: true, liveEnabled: false }]);
  recording = true;
  assert.throws(() => controller.start({ privacyMode: "shared", liveEnabled: false }), /already running/);
  assert.equal(started.length, 1);
});

test("IPC rejects other senders and hides unexpected error details", async () => {
  const handlers = new Map();
  const trusted = { trusted: true };
  const controller = {
    getContext: () => { throw new Error("/Users/test/secret"); },
    start: () => ({ ok: true }),
    cancel: () => ({ ok: true }),
    openSetup: () => ({ ok: true }),
    openPrivacySettings: () => ({ ok: true }),
  };
  record.registerRecordHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, () => controller, (event) => event === trusted);
  assert.deepEqual([...handlers.keys()].sort(), Object.values(record.CHANNELS).sort());
  assert.match((await handlers.get(record.CHANNELS.start)({}, {})).error, /recording window/);
  assert.deepEqual(await handlers.get(record.CHANNELS.getContext)(trusted), { error: "The recording could not start. Try again." });
});

function fakeElectron() {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.handlers = {};
      this.closed = false;
      this.webContents = {
        on: (name, fn) => { this.handlers[name] = fn; },
        setWindowOpenHandler: (fn) => { this.openHandler = fn; },
      };
      windows.push(this);
    }
    isDestroyed() { return this.closed; }
    isVisible() { return false; }
    show() {}
    focus() {}
    close() { this.closed = true; this.emit("closed"); }
    loadFile(file) { this.loadedFile = file; }
    static getAllWindows() { return windows.filter((window) => !window.closed); }
  }
  const handlers = new Map();
  return {
    windows,
    handlers,
    electron: {
      app: { dock: { show() {}, hide() {} }, focus() {} },
      BrowserWindow,
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    },
  };
}

test("the record window matches setup hardening and closes before capture starts", async () => {
  const setupFake = fakeElectron();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-record-"));
  setup.createSetupWindow(setupFake.electron, {
    fs, secretStore: { read: () => "", has: () => false }, dataDir, configPath: path.join(dataDir, "config.toml"), python: "", spawnFn: () => {},
  });
  const fake = fakeElectron();
  const events = [];
  const win = record.createRecordWindow(fake.electron, {
    getContext: () => ({ recording: false, blockers: [] }),
    onStart: (request) => events.push(["start", request, win.closed]),
  });
  const { preload: setupPreload, ...setupPrefs } = setupFake.windows[0].options.webPreferences;
  const { preload, ...prefs } = win.options.webPreferences;
  assert.deepEqual(prefs, setupPrefs);
  assert.equal(path.basename(setupPreload), "setup-preload.js");
  assert.equal(preload, path.join(DESKTOP, "record-preload.js"));
  assert.equal(win.loadedFile, path.join(DESKTOP, "renderer", "record.html"));
  assert.deepEqual(win.openHandler({ url: "https://example.test" }), { action: "deny" });

  const url = pathToFileURL(path.join(DESKTOP, "renderer", "record.html")).href;
  const start = fake.handlers.get(record.CHANNELS.start);
  assert.match((await start({ sender: win.webContents, senderFrame: { url: "https://evil.test/" } }, {})).error, /recording window/);
  assert.deepEqual(await start({ sender: win.webContents, senderFrame: { url } }, { title: "Retro", privacyMode: "shared", liveEnabled: true }), { ok: true });
  assert.deepEqual(events, [["start", { title: "Retro", isPrivate: false, liveEnabled: true }, true]]);
});

test("an already-open options window keeps its original controller and mode", async () => {
  const modulePath = require.resolve("../record-window");
  delete require.cache[modulePath];
  const freshRecord = require(modulePath);
  const fake = fakeElectron();
  const firstEvents = [];
  const secondEvents = [];
  const first = freshRecord.createRecordWindow(fake.electron, {
    getContext: () => ({ recording: false, blockers: [] }),
    onStart: (request) => firstEvents.push(request),
  });
  const second = freshRecord.createRecordWindow(fake.electron, {
    getContext: () => ({ recording: false, blockers: [] }),
    onStart: (request) => secondEvents.push(request),
  });
  assert.equal(second, first);
  const url = pathToFileURL(path.join(DESKTOP, "renderer", "record.html")).href;
  const start = fake.handlers.get(freshRecord.CHANNELS.start);
  assert.deepEqual(
    await start(
      { sender: first.webContents, senderFrame: { url } },
      { title: "First mode", privacyMode: "private", liveEnabled: true },
    ),
    { ok: true },
  );
  assert.deepEqual(firstEvents, [{ title: "First mode", isPrivate: true, liveEnabled: true }]);
  assert.deepEqual(secondEvents, []);
});

test("the record bridge exposes only its fixed actions with picked fields", async () => {
  const invocations = [];
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    ipcRenderer: { invoke: (channel, ...args) => { invocations.push({ channel, args }); return Promise.resolve({ ok: true }); } },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const preloadPath = require.resolve("../record-preload");
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(exposed.name, "meetingWikiRecord");
  assert.deepEqual(Object.keys(exposed.api).sort(), ["cancel", "getContext", "openPrivacySettings", "openSetup", "start"]);
  await exposed.api.getContext("ignored");
  await exposed.api.start({ title: "Sync", privacyMode: "private", private: "true", liveEnabled: false, configPath: "/etc/passwd" });
  await exposed.api.cancel();
  await exposed.api.openSetup("ignored");
  await exposed.api.openPrivacySettings("microphone");
  await exposed.api.openPrivacySettings({ url: "https://evil.test" });
  assert.deepEqual(invocations, [
    { channel: record.CHANNELS.getContext, args: [] },
    { channel: record.CHANNELS.start, args: [{ title: "Sync", privacyMode: "private", liveEnabled: false }] },
    { channel: record.CHANNELS.cancel, args: [] },
    { channel: record.CHANNELS.openSetup, args: [] },
    { channel: record.CHANNELS.openPrivacySettings, args: ["microphone"] },
    { channel: record.CHANNELS.openPrivacySettings, args: [""] },
  ]);
});

test("record.html is self-only, labelled, and starts nothing on load", () => {
  const html = read("renderer/record.html");
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(directive), `CSP is missing ${directive}`);
  }
  assert.doesNotMatch(html, /<script>|\sstyle="|\son[a-z]+="|(src|href)="(https?:)?\/\//);
  assert.match(html, /<label for="record-title">/);
  assert.doesNotMatch(html, /id="record-shared"[^>]*checked/);
  assert.doesNotMatch(html, /id="record-private"[^>]*checked/);
  for (const id of ["record-capture", "record-processing", "record-duration", "record-live"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /type="checkbox"[^>]*id="record-live-enabled"[^>]*checked/);
  assert.match(html, /type="submit" class="button button-primary" id="record-start">Start recording</);

  const js = read("renderer/record.js");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|\brequire\(|ipcRenderer|fetch\(|console\./);
  assert.equal((js.match(/call\("start"/g) || []).length, 1);
  const init = js.slice(js.indexOf("async function init()"));
  assert.doesNotMatch(init, /call\("start"/);
  assert.match(js, /including for this private meeting/);
  assert.match(js, /Live captions use your microphone only/);
  assert.match(js, /start\.disabled = systemBlocked \|\| privacyMissing;/);
  assert.match(html, /id="record-blockers"[^>]*role="alert"[^>]*hidden/);
  for (const id of ["record-open-setup", "record-open-microphone", "record-open-system-audio"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*type="button"|type="button"[^>]*id="${id}"`));
  }
  assert.doesNotMatch(js, /context\.systemAudio === "(granted|denied|restricted)"/);
});

test("main uses saved defaults for quick start and reserves the panel for first use or overrides", () => {
  const main = read("main.js");
  assert.doesNotMatch(main, /nextTitle|nextPrivate|askTitle|osascript|Mark next recording private|Set next title/);
  assert.match(main, /function startManualRecording\(\)/);
  assert.match(main, /readRecordingDefaults\(fs, DATA_DIR\)/);
  assert.match(main, /const decision = decideManualStart\(\{ blockers: context\.blockers, defaults \}\);/);
  assert.match(main, /openRecordPanel\(decision\.formMode\);/);
  assert.match(main, /closeRecordWindow\(\);\s*void startRecording\(decision\.options\);/);
  assert.match(main, /\{ label: "Start recording", accelerator: "CommandOrControl\+Shift\+0", click: startManualRecording \}/);
  assert.match(main, /\{ label: "Start with options\.\.\.", click: \(\) => openRecordPanel\("override"\) \}/);
  assert.match(main, /else if \(recordingSession\.idle\) startManualRecording\(\);/);
  assert.match(main, /if \(formMode === "initial" && !readRecordingDefaults\(fs, DATA_DIR\)\.configured\)/);
  assert.match(main, /saveRecordingDefaults\(\s*fs,\s*DATA_DIR/);
  assert.match(main, /async function startRecording\(\{ title: requestedTitle = "", isPrivate: requestedPrivate = false, liveEnabled: requestedLive = false, source = null, occurredAt = null \} = \{\}\)/);
  const importBody = main.slice(main.indexOf("async function importAudio"), main.indexOf("function updateMenu"));
  assert.match(importBody, /if \(choice\.response !== 0\) return;/);
  assert.match(importBody, /choice\.checkboxChecked === true/);
  assert.match(main, /checkboxChecked: false,/);
});

test("main gates the live sidebar on a live adapter and keeps it reopenable", () => {
  const main = read("main.js");
  assert.match(main, /setupComplete: !needsSetup\(fs, DATA_DIR, CONFIG_PATH\)/);
  assert.match(main, /onOpenSetup: openSetupWindow/);
  assert.match(main, /openExternal: \(url\) => \{ void shell\.openExternal\(url\); \}/);
  const start = main.slice(main.indexOf("async function startRecording"), main.indexOf("// The limit, the user, and quit"));
  assert.match(start, /if \(liveEnabled && liveDecision\.liveStarts\) startLiveSession\(capture\.active\.micPath, isPrivate, liveDecision\);/);
  const live = main.slice(main.indexOf("function startLiveSession"), main.indexOf("function readConfigText"));
  assert.match(live, /if \(live\.live === "ready"\) createLiveSidebarWindow\(\{ BrowserWindow \}\);/);
  assert.match(live, /destroyLiveSidebar\(\);/);
  assert.doesNotMatch(live, /onClosed/);
  assert.match(main, /label: "Show live captions", click: \(\) => \{ showLiveSidebar\(\); \}/);
});
