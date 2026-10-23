"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const DESKTOP = path.join(__dirname, "..");
const RENDERER = path.join(DESKTOP, "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

function freshSidebarModule() {
  const modulePath = require.resolve("../live-sidebar-window");
  delete require.cache[modulePath];
  return require(modulePath);
}

function fakeElectron() {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.sent = [];
      this.loaded = null;
      this.shown = 0;
      this.openHandler = null;
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, payload) => this.sent.push({ channel, payload });
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      windows.push(this);
    }

    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible === true; }
    showInactive() { this.shown += 1; this.visible = true; }
    show() { this.shown += 1; this.visible = true; }
    focus() {}
    hide() { this.visible = false; }
    loadFile(file) { this.loaded = file; }
    // Mirrors Electron: a close handler may cancel the close with preventDefault.
    close() {
      let prevented = false;
      this.emit("close", { preventDefault: () => { prevented = true; } });
      if (prevented) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return { electron: { BrowserWindow }, windows };
}

test("the sidebar window is sandboxed, isolated, and blocks navigation and popups", () => {
  const sidebar = freshSidebarModule();
  const { electron, windows } = fakeElectron();
  sidebar.createLiveSidebarWindow(electron);
  const [window] = windows;
  const prefs = window.options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.preload, path.join(DESKTOP, "live-sidebar-preload.js"));
  assert.equal(window.loaded, sidebar.LIVE_SIDEBAR_PAGE);
  for (const name of ["will-navigate", "will-redirect", "will-attach-webview"]) {
    let prevented = false;
    window.webContents.emit(name, { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, `${name} must be denied`);
  }
  assert.deepEqual(window.openHandler({ url: "https://example.test" }), { action: "deny" });
  sidebar.destroyLiveSidebar();
});

test("events are buffered until load, re-sanitized, and sent on one channel", () => {
  const sidebar = freshSidebarModule();
  const { electron, windows } = fakeElectron();
  assert.equal(sidebar.publishLiveEvent({ type: "state", phase: "starting" }), false);
  sidebar.createLiveSidebarWindow(electron);
  const [window] = windows;
  sidebar.publishLiveEvent({ type: "state", phase: "starting", private: true, token: "secret" });
  sidebar.publishLiveEvent({ type: "transcript", sequence: 1, text: "Hello", path: "/fake/mic.wav" });
  sidebar.publishLiveEvent({ type: "unknown", sequence: 1 });
  assert.deepEqual(window.sent, []);
  window.webContents.emit("did-finish-load");
  sidebar.publishLiveEvent({ type: "translation", sequence: 1, text: "你好" });
  assert.deepEqual(window.sent, [
    { channel: sidebar.LIVE_EVENT_CHANNEL, payload: { type: "locale", uiLanguage: "system" } },
    { channel: sidebar.LIVE_EVENT_CHANNEL, payload: { type: "state", phase: "starting", private: true } },
    { channel: sidebar.LIVE_EVENT_CHANNEL, payload: { type: "transcript", sequence: 1, text: "Hello" } },
    { channel: sidebar.LIVE_EVENT_CHANNEL, payload: { type: "translation", sequence: 1, text: "你好" } },
  ]);
  sidebar.destroyLiveSidebar();
});

test("the saved UI language is sent first on every load and unknown values follow macOS", () => {
  const sidebar = freshSidebarModule();
  const { electron, windows } = fakeElectron();
  sidebar.createLiveSidebarWindow(electron, { uiLanguage: "zh-CN" });
  const [window] = windows;
  sidebar.publishLiveEvent({ type: "transcript", sequence: 1, text: "Hello" });
  window.webContents.emit("did-finish-load");
  assert.deepEqual(window.sent.map(({ payload }) => payload.type), ["locale", "transcript"]);
  assert.deepEqual(window.sent[0].payload, { type: "locale", uiLanguage: "zh-CN" });
  window.webContents.emit("did-finish-load");
  assert.deepEqual(window.sent.at(-1).payload, { type: "locale", uiLanguage: "zh-CN" });
  sidebar.destroyLiveSidebar();

  const fallback = fakeElectron();
  sidebar.createLiveSidebarWindow(fallback.electron, { uiLanguage: "fr" });
  fallback.windows[0].webContents.emit("did-finish-load");
  assert.deepEqual(fallback.windows[0].sent[0].payload, { type: "locale", uiLanguage: "system" });
  sidebar.destroyLiveSidebar();
});

test("a reload buffers events and replays the locale and the last state first", () => {
  const sidebar = freshSidebarModule();
  const { electron, windows } = fakeElectron();
  sidebar.createLiveSidebarWindow(electron, { uiLanguage: "en" });
  const [window] = windows;
  window.webContents.emit("did-finish-load");
  sidebar.publishLiveEvent({ type: "state", phase: "listening", private: true, scope: "external" });
  sidebar.publishLiveEvent({ type: "transcript", sequence: 1, text: "Before" });
  window.sent = [];
  window.webContents.emit("did-start-loading");
  sidebar.publishLiveEvent({ type: "transcript", sequence: 2, text: "During" });
  assert.deepEqual(window.sent, []);
  window.webContents.emit("did-finish-load");
  assert.deepEqual(window.sent.map(({ payload }) => payload), [
    { type: "locale", uiLanguage: "en" },
    { type: "state", phase: "listening", private: true, scope: "external" },
    { type: "transcript", sequence: 2, text: "During" },
  ]);
  sidebar.destroyLiveSidebar();
});

test("closing hides the sidebar and keeps receiving events until the recording ends", () => {
  const sidebar = freshSidebarModule();
  const { electron, windows } = fakeElectron();
  const first = sidebar.createLiveSidebarWindow(electron);
  const second = sidebar.createLiveSidebarWindow(electron);
  assert.equal(first, second);
  assert.equal(windows.length, 1);
  first.webContents.emit("did-finish-load");
  first.visible = true;
  first.close();
  assert.equal(first.destroyed, false, "a user close must only hide");
  assert.equal(first.isVisible(), false);
  assert.equal(sidebar.liveSidebarAvailable(), true);
  assert.equal(sidebar.publishLiveEvent({ type: "transcript", sequence: 1, text: "Still live" }), true);
  assert.equal(first.sent.at(-1).payload.text, "Still live");

  assert.equal(sidebar.showLiveSidebar(), true);
  assert.equal(first.isVisible(), true);

  sidebar.destroyLiveSidebar();
  assert.equal(first.destroyed, true);
  assert.equal(sidebar.liveSidebarAvailable(), false);
  assert.equal(sidebar.showLiveSidebar(), false);
  assert.equal(sidebar.publishLiveEvent({ type: "state", phase: "stopped" }), false);
});

test("the sidebar explains both labeled audio channels", () => {
  const html = read("live-sidebar.html");
  assert.match(html, /your microphone, labeled You, and all audio played on this Mac, including other participants, labeled Others/);
  assert.doesNotMatch(html, /microphone only/);
});

test("the sidebar registers no IPC handlers", () => {
  const source = fs.readFileSync(path.join(DESKTOP, "live-sidebar-window.js"), "utf8");
  assert.doesNotMatch(source, /ipcMain|\.handle\(|\.on\(\s*["']live:/);
});

function loadPreload() {
  const listeners = new Map();
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    ipcRenderer: {
      invoke: () => { throw new Error("the live preload must not invoke"); },
      send: () => { throw new Error("the live preload must not send"); },
      on: (channel, fn) => listeners.set(channel, fn),
      removeListener: (channel, fn) => { if (listeners.get(channel) === fn) listeners.delete(channel); },
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const preloadPath = require.resolve("../live-sidebar-preload");
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  return { exposed, listeners };
}

test("the preload exposes only subscribe and unsubscribe on the main channel", () => {
  const { LIVE_EVENT_CHANNEL } = freshSidebarModule();
  const { exposed, listeners } = loadPreload();
  assert.equal(exposed.name, "meetingWikiLive");
  assert.deepEqual(Object.keys(exposed.api).sort(), ["subscribe", "unsubscribe"]);
  const received = [];
  assert.equal(exposed.api.subscribe((event) => received.push(event)), true);
  assert.deepEqual([...listeners.keys()], [LIVE_EVENT_CHANNEL]);
  const listener = listeners.get(LIVE_EVENT_CHANNEL);
  listener({ sender: "ignored" }, { type: "transcript", sequence: 2, text: "Hi", token: "secret" });
  listener({}, { type: "state", phase: "listening", private: true, scope: "external", path: "/x" });
  listener({}, { type: "exec", command: "rm" });
  listener({}, { type: "summary", sequence: 2, points: ["A", "B"] });
  listener({}, { type: "locale", uiLanguage: "zh-CN", path: "/x" });
  listener({}, { type: "locale", uiLanguage: "fr" });
  assert.deepEqual(received, [
    { type: "transcript", sequence: 2, text: "Hi" },
    { type: "state", phase: "listening", private: true, scope: "external", issue: "" },
    { type: "summary", sequence: 2, points: ["A", "B"] },
    { type: "locale", uiLanguage: "zh-CN" },
  ]);
  exposed.api.unsubscribe();
  assert.equal(listeners.size, 0);
  assert.equal(exposed.api.subscribe("not a function"), false);
});

test("the preload channel matches the window channel", () => {
  const { LIVE_EVENT_CHANNEL } = freshSidebarModule();
  const preload = fs.readFileSync(path.join(DESKTOP, "live-sidebar-preload.js"), "utf8");
  assert.match(preload, new RegExp(`const CHANNEL = "${LIVE_EVENT_CHANNEL}";`));
});

test("live-sidebar.html enforces a self-only CSP with no network and no inline code", () => {
  const html = read("live-sidebar.html");
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(csp, "live-sidebar.html is missing a CSP meta tag");
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(directive), `CSP is missing ${directive}`);
  }
  assert.match(html, /<script src="live-sidebar\.js" defer><\/script>/);
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//);
  assert.doesNotMatch(html, /<script>|\sstyle="|\son[a-z]+="/);
});

test("live-sidebar.js uses only the live bridge and writes text, never markup or network", () => {
  const js = read("live-sidebar.js");
  assert.match(js, /window\.meetingWikiLive/);
  assert.match(js, /bridge\.subscribe\(handle\)/);
  assert.doesNotMatch(js, /\brequire\(|\bprocess\.|ipcRenderer|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|token/);
  assert.doesNotMatch(read("live-sidebar.css"), /@import|url\(/);
});
