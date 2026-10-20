"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const { CHANNELS } = require("../setup-window");

function loadPreload() {
  const invocations = [];
  const listeners = new Map();
  let exposed;
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => { exposed = { name, api }; },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invocations.push({ channel, args });
        return Promise.resolve({ ok: true });
      },
      on: (channel, fn) => listeners.set(channel, fn),
      removeListener: (channel, fn) => {
        if (listeners.get(channel) === fn) listeners.delete(channel);
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const preloadPath = require.resolve("../setup-preload");
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  return { exposed, invocations, listeners };
}

test("the setup bridge exposes only the named setup actions", () => {
  const { exposed } = loadPreload();
  assert.equal(exposed.name, "meetingWikiSetup");
  assert.deepEqual(Object.keys(exposed.api).sort(), [
    "completeSetup",
    "downloadLocalModel",
    "getSetupState",
    "listLocalModels",
    "onLocalModelProgress",
    "readClipboardApiKey",
    "saveGeminiProvider",
    "saveOnlineProvider",
    "testGeminiProvider",
    "testOnlineProvider",
    "testSavedProvider",
  ]);
  for (const value of Object.values(exposed.api)) assert.equal(typeof value, "function");
});

test("bridge actions use only the setup channels registered in main", async () => {
  const { exposed, invocations } = loadPreload();
  await exposed.api.getSetupState();
  await exposed.api.testOnlineProvider();
  await exposed.api.listLocalModels();
  await exposed.api.downloadLocalModel("model-a");
  await exposed.api.completeSetup({ mode: "online", extra: "dropped" });
  await exposed.api.saveOnlineProvider({ baseUrl: "https://provider.example.test/v1", apiKey: "test-key", acknowledgedEgress: true });
  assert.deepEqual(
    invocations.map(({ channel }) => channel),
    [
      CHANNELS.getSetupState,
      CHANNELS.testOnlineProvider,
      CHANNELS.listLocalModels,
      CHANNELS.downloadLocalModel,
      CHANNELS.completeSetup,
      CHANNELS.saveOnlineProvider,
    ],
  );
  assert.deepEqual(invocations[4].args, [{ mode: "online" }]);
});

test("saveOnlineProvider forwards only the expected settings fields", async () => {
  const { exposed, invocations } = loadPreload();
  await exposed.api.saveOnlineProvider({
    baseUrl: "https://provider.example.test/v1",
    transcriptionModel: "test-transcribe-1",
    languageModel: "test-language-1",
    apiKey: "test-key",
    acknowledgedEgress: "yes",
    injected: { channel: "wiki:readPage" },
  });
  assert.deepEqual(invocations[0].args, [{
    baseUrl: "https://provider.example.test/v1",
    transcriptionModel: "test-transcribe-1",
    languageModel: "test-language-1",
    apiKey: "test-key",
    useSavedKey: false,
    acknowledgedEgress: false,
  }]);
});

test("onLocalModelProgress delivers sanitized events and unsubscribes", () => {
  const { exposed, listeners } = loadPreload();
  const received = [];
  const unsubscribe = exposed.api.onLocalModelProgress((event) => received.push(event));
  const listener = listeners.get(CHANNELS.localModelProgress);
  assert.equal(typeof listener, "function");

  listener({ sender: "ipc-event" }, { id: "model-a", status: "downloading", receivedBytes: 5, path: "/secret" });
  listener({}, { id: "model-a", status: "unknown" });
  listener({}, null);
  assert.deepEqual(received, [{ id: "model-a", status: "downloading", receivedBytes: 5 }]);

  unsubscribe();
  assert.equal(listeners.has(CHANNELS.localModelProgress), false);
  assert.equal(typeof exposed.api.onLocalModelProgress("not a function"), "function");
});

test("the setup preload has no generic IPC passthrough", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "setup-preload.js"), "utf8");
  assert.doesNotMatch(source, /ipcRenderer\.send\b|sendSync|invoke\(\s*channel|\.\.\.args|exposeInMainWorld\([^)]*ipcRenderer\s*\)/);
  const channels = [...source.matchAll(/"(setup:[A-Za-z]+)"/g)].map((match) => match[1]);
  assert.ok(channels.length > 0);
  for (const channel of channels) assert.ok(Object.values(CHANNELS).includes(channel), `unknown channel ${channel}`);
});

test("Gemini bridge actions forward only a key and an acknowledgement on their own channels", async () => {
  const { exposed, invocations } = loadPreload();
  await exposed.api.saveGeminiProvider({
    apiKey: "test-gemini-key",
    acknowledgedEgress: true,
    baseUrl: "https://evil.test",
    model: "override",
  });
  await exposed.api.testGeminiProvider({ acknowledgedEgress: "yes", channel: "wiki:readPage" });
  await exposed.api.saveGeminiProvider("not an object");
  assert.deepEqual(invocations, [
    { channel: CHANNELS.saveGeminiProvider, args: [{ apiKey: "test-gemini-key", useSavedKey: false, acknowledgedEgress: true }] },
    { channel: CHANNELS.testGeminiProvider, args: [{ apiKey: "", useSavedKey: false, acknowledgedEgress: false }] },
    { channel: CHANNELS.saveGeminiProvider, args: [{ apiKey: "", useSavedKey: false, acknowledgedEgress: false }] },
  ]);
});

test("completeSetup forwards only a known provider", async () => {
  const { exposed, invocations } = loadPreload();
  await exposed.api.completeSetup({ mode: "online", provider: "gemini" });
  await exposed.api.completeSetup({ mode: "online", provider: "../evil" });
  assert.deepEqual(invocations.map(({ args }) => args[0]), [
    { mode: "online", provider: "gemini" },
    { mode: "online" },
  ]);
});

test("saved-key test and clipboard paste take no arguments from the renderer", async () => {
  const { exposed, invocations } = loadPreload();
  await exposed.api.testSavedProvider({ configPath: "/evil" });
  await exposed.api.readClipboardApiKey("ignored");
  await exposed.api.saveGeminiProvider({ apiKey: "", useSavedKey: true, acknowledgedEgress: true });
  assert.deepEqual(invocations, [
    { channel: CHANNELS.testSavedProvider, args: [] },
    { channel: CHANNELS.readClipboardApiKey, args: [] },
    { channel: CHANNELS.saveGeminiProvider, args: [{ apiKey: "", useSavedKey: true, acknowledgedEgress: true }] },
  ]);
});
