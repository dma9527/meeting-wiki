"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { EXTENSION_ID, NATIVE_HOST_NAME, validateExtensionMessage } = require("../meet-protocol");
const content = require("../browser-extension/google-meet/content");
const background = require("../browser-extension/google-meet/background");

const EXTENSION_DIR = path.join(__dirname, "..", "browser-extension", "google-meet");
const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));

test("the manifest key derives the extension ID the native host is pinned to", () => {
  const der = Buffer.from(manifest.key, "base64");
  const id = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (char) => String.fromCharCode(97 + parseInt(char, 16)));
  assert.equal(id, EXTENSION_ID);
  assert.equal(background.HOST_NAME, NATIVE_HOST_NAME);
});

test("the extension asks only for native messaging and runs only on Meet", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["nativeMessaging"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.deepEqual(manifest.content_scripts, [{ matches: ["https://meet.google.com/*"], js: ["content.js"], run_at: "document_idle", all_frames: false }]);
});

test("extension code never reads captions, chat, history, or storage", () => {
  for (const file of ["content.js", "background.js"]) {
    const source = fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
    assert.doesNotMatch(source, /MutationObserver|innerText|innerHTML|document\.title|chrome\.(history|storage|tabs|cookies)|fetch\(|XMLHttpRequest|WebSocket|localStorage|console\./, file);
  }
});

function fakeRoot({ selectors = [], icons = [] } = {}) {
  return {
    querySelector: (selector) => (selectors.includes(selector) ? {} : null),
    querySelectorAll: () => icons.map((text) => ({ textContent: text })),
  };
}

test("joined detection looks only for the Leave call control", () => {
  assert.equal(content.hasLeaveControl(fakeRoot()), false);
  assert.equal(content.hasLeaveControl(fakeRoot({ selectors: ['button[jsname="CQylAd"]'] })), true);
  assert.equal(content.hasLeaveControl(fakeRoot({ selectors: ['button[aria-label="Leave call"]'] })), true);
  assert.equal(content.hasLeaveControl(fakeRoot({ icons: ["mic", " call_end "] })), true);
  assert.equal(content.hasLeaveControl(fakeRoot({ icons: ["mic", "videocam"] })), false);
});

test("the meeting code comes only from the URL path", () => {
  assert.equal(content.meetingCodeFrom("/abc-defg-hij"), "abc-defg-hij");
  assert.equal(content.meetingCodeFrom("/abc-defg-hij?authuser=0"), "abc-defg-hij");
  assert.equal(content.meetingCodeFrom("/landing"), null);
  assert.equal(content.meetingCodeFrom("/abc-defg-hijk"), null);
});

function fakePort(sender = {}) {
  const listeners = { message: [], disconnect: [] };
  return {
    name: "meeting-wiki-meet",
    sender,
    posted: [],
    disconnected: false,
    postMessage(message) { this.posted.push(message); },
    disconnect() { this.disconnected = true; },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    emitMessage: (message) => listeners.message.forEach((fn) => fn(message)),
    emitDisconnect: () => listeners.disconnect.forEach((fn) => fn()),
  };
}

test("the content monitor reports joined and left only after two matching checks", () => {
  let present = false;
  const port = fakePort();
  let clock = 0;
  const intervals = [];
  const monitor = content.createMonitor({
    root: { querySelector: (selector) => (present && selector === 'button[jsname="CQylAd"]' ? {} : null), querySelectorAll: () => [] },
    location: { pathname: "/abc-defg-hij" },
    connect: () => port,
    timers: { setInterval: (fn) => intervals.push(fn), setTimeout: () => {} },
    now: () => clock,
  });
  monitor.start();
  assert.deepEqual(port.posted, [{ type: "state", joined: false, meetingCode: "abc-defg-hij" }]);
  present = true;
  monitor.check();
  assert.equal(port.posted.length, 1);
  monitor.check();
  assert.deepEqual(port.posted.at(-1), { type: "state", joined: true, meetingCode: "abc-defg-hij" });
  clock += content.HEARTBEAT_MS;
  monitor.check();
  assert.equal(port.posted.length, 3);
  present = false;
  monitor.check();
  monitor.check();
  assert.deepEqual(port.posted.at(-1), { type: "state", joined: false, meetingCode: "abc-defg-hij" });
  assert.equal(intervals.length, 1);
});

function relayHarness() {
  const nativePosts = [];
  const timeouts = [];
  let nativeDisconnects = 0;
  let uuid = 0;
  const runtime = {
    id: "self",
    lastError: undefined,
    connectNative: (name) => {
      assert.equal(name, NATIVE_HOST_NAME);
      return {
        postMessage: (message) => nativePosts.push(message),
        disconnect: () => { nativeDisconnects += 1; },
        onDisconnect: { addListener: () => {} },
      };
    },
  };
  const relay = background.createRelay({
    runtime,
    randomUUID: () => `00000000-0000-0000-0000-00000000000${(uuid += 1)}`,
    timers: { setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; }, clearTimeout: () => {} },
  });
  return { relay, nativePosts, timeouts, disconnects: () => nativeDisconnects };
}

test("the relay forwards only validated join, heartbeat, and leave events", () => {
  const { relay, nativePosts, timeouts, disconnects } = relayHarness();
  const port = fakePort({ id: "self", frameId: 0, url: "https://meet.google.com/abc-defg-hij" });
  relay.onConnect(port);
  port.emitMessage({ type: "state", joined: true, meetingCode: "abc-defg-hij", chat: "x" });
  port.emitMessage({ type: "state", joined: true, meetingCode: "<script>" });
  port.emitMessage({ type: "state", joined: false });
  port.emitMessage({ type: "other" });
  port.emitDisconnect();
  const session = "00000000-0000-0000-0000-000000000001";
  assert.deepEqual(nativePosts, [
    { type: "hello", session },
    { type: "joined", session, meetingCode: "abc-defg-hij" },
    { type: "heartbeat", session, meetingCode: null },
    { type: "left", session },
  ]);
  for (const message of nativePosts) assert.ok(validateExtensionMessage(message), JSON.stringify(message));
  assert.equal(relay.connectedTabs, 0);
  timeouts.forEach((fn) => fn());
  assert.equal(disconnects(), 1);
});

test("a closed joined tab sends left, and untrusted senders are refused", () => {
  const { relay, nativePosts } = relayHarness();
  const port = fakePort({ id: "self", frameId: 0, url: "https://meet.google.com/abc-defg-hij" });
  relay.onConnect(port);
  port.emitMessage({ type: "state", joined: true, meetingCode: "abc-defg-hij" });
  port.emitDisconnect();
  assert.equal(nativePosts.at(-1).type, "left");
  for (const sender of [
    { id: "other", frameId: 0, url: "https://meet.google.com/x" },
    { id: "self", frameId: 3, url: "https://meet.google.com/x" },
    { id: "self", frameId: 0, url: "https://evil.example/meet.google.com/" },
  ]) {
    const rejected = fakePort(sender);
    relay.onConnect(rejected);
    assert.equal(rejected.disconnected, true);
  }
});
