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
  setupState: { completed: true, mode: "online" },
  pythonAvailable: true,
  keyAvailable: true,
  maxDurationMinutes: 90,
  microphone: "granted",
  systemAudio: "granted",
  recording: false,
});

test("a managed Gemini setup reports external live captions ready", () => {
  const context = record.buildRecordContext({ ...BASE, configText: setup.renderGeminiConfig() });
  assert.deepEqual(context, {
    setupComplete: true,
    maxDurationMinutes: 90,
    microphone: "granted",
    systemAudio: "granted",
    destination: "gemini",
    host: "",
    live: "ready",
    liveScope: "external",
    recording: false,
  });
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
  const odd = record.buildRecordContext({ ...BASE, configText: null, microphone: "weird", systemAudio: "denied", recording: true });
  assert.equal(odd.microphone, "unknown");
  assert.equal(odd.systemAudio, "denied");
  assert.equal(odd.recording, true);
});

test("start requests accept only a one-line title and an explicit private true", () => {
  assert.deepEqual(record.validateStartRequest({ title: "  Weekly \n sync  ", private: true }), { title: "Weekly sync", isPrivate: true });
  assert.deepEqual(record.validateStartRequest({}), { title: "", isPrivate: false });
  for (const flag of ["true", 1, "yes", null]) {
    assert.equal(record.validateStartRequest({ private: flag }).isPrivate, false);
  }
  assert.throws(() => record.validateStartRequest({ title: "x".repeat(201) }), /200 characters/);
  assert.throws(() => record.validateStartRequest({ title: "bad\u0001title" }), /control characters/);
  assert.throws(() => record.validateStartRequest({ title: 5 }), /plain text/);
});

test("the controller starts only when idle and passes the validated request", () => {
  const started = [];
  let recording = false;
  const controller = record.createRecordController({
    getContext: () => ({ recording }),
    onStart: (request) => started.push(request),
  });
  assert.deepEqual(controller.start({ title: "Design review", private: true, extra: "dropped" }), { ok: true });
  assert.deepEqual(started, [{ title: "Design review", isPrivate: true }]);
  recording = true;
  assert.throws(() => controller.start({}), /already running/);
  assert.equal(started.length, 1);
});

test("IPC rejects other senders and hides unexpected error details", async () => {
  const handlers = new Map();
  const trusted = { trusted: true };
  const controller = {
    getContext: () => { throw new Error("/Users/test/secret"); },
    start: () => ({ ok: true }),
    cancel: () => ({ ok: true }),
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
    getContext: () => ({ recording: false }),
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
  assert.deepEqual(await start({ sender: win.webContents, senderFrame: { url } }, { title: "Retro", private: false }), { ok: true });
  assert.deepEqual(events, [["start", { title: "Retro", isPrivate: false }, true]]);
});

test("the record bridge exposes only getContext, start, and cancel with picked fields", async () => {
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
  assert.deepEqual(Object.keys(exposed.api).sort(), ["cancel", "getContext", "start"]);
  await exposed.api.getContext("ignored");
  await exposed.api.start({ title: "Sync", private: "true", configPath: "/etc/passwd" });
  await exposed.api.cancel();
  assert.deepEqual(invocations, [
    { channel: record.CHANNELS.getContext, args: [] },
    { channel: record.CHANNELS.start, args: [{ title: "Sync", private: false }] },
    { channel: record.CHANNELS.cancel, args: [] },
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
  assert.match(html, /id="record-shared"[^>]*checked/);
  assert.doesNotMatch(html, /id="record-private"[^>]*checked/);
  for (const id of ["record-capture", "record-processing", "record-duration", "record-live"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /type="submit" class="button button-primary" id="record-start">Start recording</);

  const js = read("renderer/record.js");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|\brequire\(|ipcRenderer|fetch\(|console\./);
  assert.equal((js.match(/call\("start"/g) || []).length, 1);
  const init = js.slice(js.indexOf("async function init()"));
  assert.doesNotMatch(init, /call\("start"/);
  assert.match(js, /including for this private meeting/);
});

test("main removes implicit next-recording state and confirms every start and import", () => {
  const main = read("main.js");
  assert.doesNotMatch(main, /nextTitle|nextPrivate|askTitle|osascript|Mark next recording private|Set next title/);
  assert.match(main, /\{ label: "Start recording\.\.\.", accelerator: "CommandOrControl\+Shift\+0", click: openRecordPanel \}/);
  assert.match(main, /else if \(recordingSession\.idle\) openRecordPanel\(\);/);
  assert.match(main, /onStart: \(request\) => \{ void startRecording\(request\); \}/);
  assert.match(main, /async function startRecording\(\{ title: requestedTitle = "", isPrivate = false \} = \{\}\)/);
  const importBody = main.slice(main.indexOf("async function importAudio"), main.indexOf("function updateMenu"));
  assert.match(importBody, /if \(choice\.response !== 0\) return;/);
  assert.match(importBody, /choice\.checkboxChecked === true/);
  assert.match(main, /checkboxChecked: false,/);
});
