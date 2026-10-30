"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSecretStore } = require("../secret-store");
const setup = require("../setup-window");
const APPLIES_SETUP = require("../setting-metadata").APPLIES.setupFinish;
const { DEFAULT_LANGUAGE_SETTINGS, EMPTY_IDENTITY, languageFromTables, parseManagedConfig } = require("../managed-config");

const TEST_KEY = "test-online-key-not-real-0000";
const VALID_SETTINGS = Object.freeze({
  baseUrl: "https://provider.example.test/v1",
  transcriptionModel: "test-transcribe-1",
  languageModel: "test-language-1",
  apiKey: TEST_KEY,
  acknowledgedEgress: true,
});

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-setup-"));
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString("hex")}`),
    decryptString: (value) => Buffer.from(value.toString().slice(4), "hex").toString(),
  };
}

function fakeSpawn({ code = 0, stdout = "" } = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, env: { ...options.env }, liveEnv: options.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code);
    });
    return child;
  };
  return { spawnFn, calls };
}

function controllerFor(dataDir, spawnOptions) {
  const python = path.join(dataDir, "python");
  fs.writeFileSync(python, "", { mode: 0o700 });
  const spawn = fakeSpawn(spawnOptions);
  const completed = [];
  const baseEnv = { PATH: "/usr/bin" };
  const controller = setup.createSetupController({
    fs,
    secretStore: createSecretStore({ safeStorage: fakeSafeStorage(), fs, filePath: path.join(dataDir, "secrets.json") }),
    dataDir,
    configPath: path.join(dataDir, "config.toml"),
    python,
    spawnFn: spawn.spawnFn,
    baseEnv,
    now: () => new Date("2026-01-01T00:00:00Z"),
    onComplete: (mode) => completed.push(mode),
  });
  return { controller, spawn, completed, baseEnv };
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function filesUnder(dir) {
  return fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
}

test("validation requires egress acknowledgement, https, safe model names, and a clean key", () => {
  const cases = [
    [{ acknowledgedEgress: false }, /Confirm that meeting data/],
    [{ acknowledgedEgress: "true" }, /Confirm that meeting data/],
    [{ baseUrl: "http://provider.example.test/v1" }, /https/],
    [{ baseUrl: "https://user:pass@provider.example.test/v1" }, /username or password/],
    [{ baseUrl: "https://provider.example.test/v1?token=x" }, /query string/],
    [{ transcriptionModel: 'bad"model' }, /transcription model/],
    [{ languageModel: "" }, /summary and translation model/],
    [{ apiKey: "has space" }, /API key/],
    [{ apiKey: "line\nbreak" }, /API key/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(
      () => setup.validateOnlineSettings({ ...VALID_SETTINGS, ...override }),
      (error) => error instanceof setup.SetupError && pattern.test(error.message) && !error.message.includes(TEST_KEY),
    );
  }
  const loopback = setup.validateOnlineSettings({ ...VALID_SETTINGS, baseUrl: "http://127.0.0.1:8080/v1/" });
  assert.equal(loopback.settings.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(loopback.settings.loopback, true);
});

test("tomlString escapes quotes, backslashes, and control characters", () => {
  assert.equal(setup.tomlString('a"b\\c\n'), '"a\\"b\\\\c\\u000a"');
});

test("saveOnlineProvider stages in memory; only completeSetup writes the key and env name", async () => {
  const dataDir = tempDataDir();
  const { controller } = controllerFor(dataDir, { code: 0 });

  const result = controller.saveOnlineProvider({ ...VALID_SETTINGS });

  assert.deepEqual(result, { ok: true });
  const configPath = path.join(dataDir, "config.toml");
  assert.deepEqual(fs.readdirSync(dataDir), ["python"], "staging must not touch disk");
  await controller.testOnlineProvider();
  assert.deepEqual(fs.readdirSync(dataDir), ["python"], "a passing check must not touch the active state");
  controller.completeSetup({ mode: "online" });
  const config = fs.readFileSync(configPath, "utf8");
  assert.ok(config.startsWith(setup.MANAGED_HEADER));
  assert.match(config, /^api_key_env = "MEETING_WIKI_ONLINE_API_KEY"$/m);
  assert.match(config, /^base_url = "https:\/\/provider\.example\.test\/v1"$/m);
  assert.match(config, /^model = "test-transcribe-1"$/m);
  assert.match(config, /^model = "test-language-1"$/m);
  assert.equal(mode(configPath), 0o600);
  assert.equal(mode(dataDir), 0o700);
  for (const content of filesUnder(dataDir)) assert.ok(!content.includes(TEST_KEY), "plaintext key on disk");
  assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp") || name.includes("candidate")), []);
});

test("completeSetup backs up a hand-written config owner-only before replacing it", async () => {
  const dataDir = tempDataDir();
  const configPath = path.join(dataDir, "config.toml");
  fs.writeFileSync(configPath, 'user_name = "Test User"\n', { mode: 0o600 });
  const { controller } = controllerFor(dataDir, { code: 0 });

  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  await controller.testOnlineProvider();
  assert.equal(fs.readdirSync(dataDir).filter((name) => name.startsWith("config.toml.before-setup-")).length, 0);
  controller.completeSetup({ mode: "online" });

  const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith("config.toml.before-setup-"));
  assert.equal(backups.length, 1);
  const backupPath = path.join(dataDir, backups[0]);
  assert.equal(fs.readFileSync(backupPath, "utf8"), 'user_name = "Test User"\n');
  assert.equal(mode(backupPath), 0o600);

  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  await controller.testOnlineProvider();
  controller.completeSetup({ mode: "online" });
  assert.equal(fs.readdirSync(dataDir).filter((name) => name.startsWith("config.toml.before-setup-")).length, 1);
});

test("completeSetup writes nothing when Keychain encryption is unavailable", async () => {
  const dataDir = tempDataDir();
  const python = path.join(dataDir, "python");
  fs.writeFileSync(python, "", { mode: 0o700 });
  const controller = setup.createSetupController({
    fs,
    secretStore: createSecretStore({
      safeStorage: { isEncryptionAvailable: () => false },
      fs,
      filePath: path.join(dataDir, "secrets.json"),
    }),
    dataDir,
    configPath: path.join(dataDir, "config.toml"),
    python,
    spawnFn: fakeSpawn({ code: 0 }).spawnFn,
  });
  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  await controller.testOnlineProvider();
  assert.throws(() => controller.completeSetup({ mode: "online" }), /Keychain encryption is unavailable/);
  assert.deepEqual(fs.readdirSync(dataDir), ["python"]);
});

// Active Gemini setup with a known key, config, and state, to prove replacements never touch them.
function activeGeminiSetup(dataDir) {
  const secretStore = createSecretStore({ safeStorage: fakeSafeStorage(), fs, filePath: path.join(dataDir, "secrets.json") });
  secretStore.save(setup.GEMINI_SECRET_ID, "test-active-gemini-key-0000");
  fs.writeFileSync(path.join(dataDir, "config.toml"), setup.renderGeminiConfig(), { mode: 0o600 });
  fs.writeFileSync(
    path.join(dataDir, "setup-state.json"),
    JSON.stringify({ version: 1, completed: true, mode: "online", provider: "gemini" }),
    { mode: 0o600 },
  );
  return secretStore;
}

function snapshot(dataDir) {
  return Object.fromEntries(
    fs.readdirSync(dataDir).sort().map((name) => [name, fs.readFileSync(path.join(dataDir, name), "utf8")]),
  );
}

function controllerWithStore(dataDir, secretStore, spawnOptions, extra = {}) {
  const python = path.join(dataDir, "python");
  fs.writeFileSync(python, "", { mode: 0o700 });
  const spawn = fakeSpawn(spawnOptions);
  const completed = [];
  const controller = setup.createSetupController({
    fs,
    secretStore,
    dataDir,
    configPath: path.join(dataDir, "config.toml"),
    python,
    spawnFn: spawn.spawnFn,
    baseEnv: { PATH: "/usr/bin" },
    now: () => new Date("2026-01-01T00:00:00Z"),
    onComplete: (value) => completed.push(value),
    ...extra,
  });
  return { controller, spawn, completed };
}

test("a failed replacement check keeps the active provider, key, and setup state byte-identical", async () => {
  const dataDir = tempDataDir();
  const secretStore = activeGeminiSetup(dataDir);
  const { controller, completed } = controllerWithStore(dataDir, secretStore, { code: 1, stdout: "FAIL llm: 401\n" });
  const before = snapshot(dataDir);

  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  const result = await controller.testOnlineProvider();

  assert.match(result.error, /FAIL llm: 401/);
  assert.match(result.error, /current provider settings are unchanged/);
  assert.deepEqual(snapshot(dataDir), before);
  assert.equal(secretStore.read(setup.GEMINI_SECRET_ID), "test-active-gemini-key-0000");
  assert.throws(() => controller.completeSetup({ mode: "online" }), /Test the provider connection/);
  await assert.rejects(async () => controller.testOnlineProvider(), /Save the provider settings/, "a rejected candidate is discarded");
  assert.deepEqual(completed, []);
});

test("a passing check without Finish leaves the active setup untouched", async () => {
  const dataDir = tempDataDir();
  const secretStore = activeGeminiSetup(dataDir);
  const { controller } = controllerWithStore(dataDir, secretStore, { code: 0 });
  const before = snapshot(dataDir);
  controller.saveGeminiProvider({ apiKey: "test-replacement-key-0000", acknowledgedEgress: true });
  assert.equal((await controller.testGeminiProvider({ acknowledgedEgress: true })).ok, true);
  assert.deepEqual(snapshot(dataDir), before);
});

test("the candidate check uses a temporary owner-only config that is removed afterwards", async () => {
  const dataDir = tempDataDir();
  const secretStore = activeGeminiSetup(dataDir);
  let seenConfig = "";
  let seenMode = 0;
  const python = path.join(dataDir, "python");
  fs.writeFileSync(python, "", { mode: 0o700 });
  const spawnFn = (_command, args) => {
    seenConfig = fs.readFileSync(args[3], "utf8");
    seenMode = mode(args[3]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit("close", 0));
    child.args = args;
    return child;
  };
  const controller = setup.createSetupController({
    fs, secretStore, dataDir, configPath: path.join(dataDir, "config.toml"), python, spawnFn, baseEnv: {},
  });
  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  await controller.testOnlineProvider();
  assert.match(seenConfig, /openai_compatible/);
  assert.equal(seenMode, 0o600);
  assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.includes("candidate")), []);
  assert.match(fs.readFileSync(path.join(dataDir, "config.toml"), "utf8"), /"gemini"/);
});

test("useSavedKey replaces settings with the Keychain key and no re-paste", async () => {
  const dataDir = tempDataDir();
  const secretStore = activeGeminiSetup(dataDir);
  const { controller, spawn } = controllerWithStore(dataDir, secretStore, { code: 0 });
  controller.saveGeminiProvider({ apiKey: "", useSavedKey: true, acknowledgedEgress: true });
  await controller.testGeminiProvider({ acknowledgedEgress: true });
  assert.equal(spawn.calls[0].env.MEETING_WIKI_GEMINI_API_KEY, "test-active-gemini-key-0000");
  controller.completeSetup({ mode: "online", provider: "gemini" });
  assert.equal(secretStore.read(setup.GEMINI_SECRET_ID), "test-active-gemini-key-0000");

  assert.throws(
    () => controller.saveOnlineProvider({ ...VALID_SETTINGS, apiKey: "", useSavedKey: true }),
    /No saved key was found/,
  );
  assert.throws(() => controller.saveOnlineProvider({ ...VALID_SETTINGS, apiKey: "" }), /API key/);
});

test("testSavedProvider checks the active config and key and changes nothing", async () => {
  const dataDir = tempDataDir();
  const secretStore = activeGeminiSetup(dataDir);
  const { controller, spawn } = controllerWithStore(dataDir, secretStore, { code: 0 });
  const before = snapshot(dataDir);
  const result = await controller.testSavedProvider();
  assert.deepEqual(result, { ok: true, detail: "Your saved provider and key responded." });
  const [call] = spawn.calls;
  assert.equal(call.args[3], path.join(dataDir, "config.toml"));
  assert.equal(call.env.MEETING_WIKI_GEMINI_API_KEY, "test-active-gemini-key-0000");
  assert.equal("MEETING_WIKI_GEMINI_API_KEY" in call.liveEnv, false);
  assert.deepEqual(snapshot(dataDir), before);

  const fresh = controllerFor(tempDataDir()).controller;
  await assert.rejects(async () => fresh.testSavedProvider(), /Finish setup first/);
});

test("a failed setup-state write rolls back the key and config", async () => {
  const dataDir = tempDataDir();
  const secretStore = activeGeminiSetup(dataDir);
  const before = snapshot(dataDir);
  const failingFs = {
    ...fs,
    renameSync: (from, to) => {
      if (path.basename(to) === "setup-state.json") throw new Error("disk full");
      return fs.renameSync(from, to);
    },
  };
  const { controller, completed } = controllerWithStore(dataDir, secretStore, { code: 0 }, { fs: failingFs });
  controller.saveGeminiProvider({ apiKey: "test-replacement-key-0000", acknowledgedEgress: true });
  await controller.testGeminiProvider({ acknowledgedEgress: true });
  assert.throws(() => controller.completeSetup({ mode: "online", provider: "gemini" }), /current provider settings are unchanged/);
  const after = snapshot(dataDir);
  assert.equal(after["config.toml"], before["config.toml"]);
  assert.equal(after["setup-state.json"], before["setup-state.json"]);
  assert.equal(secretStore.read(setup.GEMINI_SECRET_ID), "test-active-gemini-key-0000");
  assert.deepEqual(completed, []);
});

test("getSetupState reports only whether keys are saved", () => {
  const dataDir = tempDataDir();
  const secretStore = activeGeminiSetup(dataDir);
  const { controller } = controllerWithStore(dataDir, secretStore, { code: 0 });
  const state = controller.getSetupState();
  assert.deepEqual(state.savedKeys, { gemini: true, openai_compatible: false });
  assert.ok(!JSON.stringify(state).includes("test-active-gemini-key"));
});

test("clipboard paste returns only a single-line key and never stores it", () => {
  const dataDir = tempDataDir();
  let clipboard = "  test-clipboard-key-0000\n";
  const { controller } = controllerWithStore(dataDir, createSecretStore({ safeStorage: fakeSafeStorage(), fs, filePath: path.join(dataDir, "secrets.json") }), {}, {
    readClipboard: () => clipboard,
  });
  assert.deepEqual(controller.readClipboardApiKey(), { value: "test-clipboard-key-0000" });
  for (const value of ["", "two words", "line\nbreak", "x".repeat(9000), 42]) {
    clipboard = value;
    assert.match(controller.readClipboardApiKey().error, /clipboard does not contain an API key/);
  }
  const throwing = controllerWithStore(tempDataDir(), { read: () => "", has: () => false }, {}, {
    readClipboard: () => { throw new Error("denied test-secret"); },
  }).controller;
  assert.deepEqual(throwing.readClipboardApiKey(), { error: setup.clipboardApiKey("").error });
  assert.deepEqual(fs.readdirSync(dataDir), ["python"]);
});

test("testOnlineProvider injects the key only into the checker child environment", async () => {
  const dataDir = tempDataDir();
  const { controller, spawn, baseEnv } = controllerFor(dataDir, { code: 0, stdout: "OK transcription: ok\nOK llm: ok\n" });

  await assert.rejects(async () => controller.testOnlineProvider(), /Save the provider settings/);
  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  const result = await controller.testOnlineProvider();

  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes(TEST_KEY));
  assert.equal(spawn.calls.length, 1);
  const [call] = spawn.calls;
  assert.equal(call.env.MEETING_WIKI_ONLINE_API_KEY, TEST_KEY);
  assert.equal(call.env.PATH, "/usr/bin");
  assert.deepEqual(call.args.filter((_, index) => index !== 3), ["-m", "meeting_wiki.cli", "--config", "doctor"]);
  assert.match(call.args[3], /\/\.config\.candidate\.[0-9a-f]{12}\.toml$/);
  assert.ok(!call.args.some((arg) => arg.includes(TEST_KEY)));
  assert.equal("MEETING_WIKI_ONLINE_API_KEY" in call.liveEnv, false, "key not discarded after check");
  assert.equal("MEETING_WIKI_ONLINE_API_KEY" in baseEnv, false);
  assert.equal("MEETING_WIKI_ONLINE_API_KEY" in process.env, false);
});

test("a failed check reports only provider FAIL lines with the key redacted", async () => {
  const dataDir = tempDataDir();
  const stdout = `OK storage: ${dataDir}\nFAIL llm: 401 for key ${TEST_KEY}\nFAIL transcription: ConnectError\n`;
  const { controller } = controllerFor(dataDir, { code: 1, stdout });
  controller.saveOnlineProvider({ ...VALID_SETTINGS });

  const result = await controller.testOnlineProvider();

  assert.equal(result.ok, undefined);
  assert.ok(!result.error.includes(TEST_KEY));
  assert.ok(!result.error.includes(dataDir));
  assert.match(result.error, /FAIL llm: 401 for key \[redacted\]/);
  assert.match(result.error, /FAIL transcription: ConnectError/);
  assert.throws(() => controller.completeSetup({ mode: "online" }), /Test the provider connection/);
});

test("runProviderCheck kills a hung checker and still discards the key", async () => {
  let killed = "";
  let liveEnv;
  const spawnFn = (_command, _args, options) => {
    liveEnv = options.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = (signal) => { killed = signal; };
    return child;
  };
  const result = await setup.runProviderCheck({
    spawnFn,
    python: "/test/python",
    configPath: "/test/config.toml",
    apiKey: TEST_KEY,
    baseEnv: {},
    timeoutMs: 10,
  });
  assert.match(result.error, /did not respond/);
  assert.equal(killed, "SIGKILL");
  assert.equal("MEETING_WIKI_ONLINE_API_KEY" in liveEnv, false);
});

test("completeSetup requires a passing online test and records completion", async () => {
  const dataDir = tempDataDir();
  const configPath = path.join(dataDir, "config.toml");
  const { controller, completed } = controllerFor(dataDir, { code: 0 });
  assert.equal(setup.needsSetup(fs, dataDir, configPath), true);

  assert.throws(() => controller.completeSetup({ mode: "online" }), /Test the provider connection/);
  assert.throws(() => controller.completeSetup({ mode: "other" }), /Choose a setup path/);
  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  await controller.testOnlineProvider();
  assert.deepEqual(controller.completeSetup({ mode: "online" }), { ok: true });

  assert.deepEqual(completed, ["online"]);
  const statePath = path.join(dataDir, "setup-state.json");
  assert.equal(mode(statePath), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).mode, "online");
  assert.equal(setup.needsSetup(fs, dataDir, configPath), false);
  assert.deepEqual(controller.getSetupState(), { storagePath: dataDir, appliesAfter: APPLIES_SETUP, uiLanguage: "system", savedKeys: { gemini: false, openai_compatible: true }, mode: "online" });
});

test("needsSetup treats a pre-existing hand-written config as configured", () => {
  const dataDir = tempDataDir();
  const configPath = path.join(dataDir, "config.toml");
  fs.writeFileSync(configPath, 'user_name = "Test User"\n');
  assert.equal(setup.needsSetup(fs, dataDir, configPath), false);
  fs.writeFileSync(configPath, `${setup.MANAGED_HEADER}\n`);
  assert.equal(setup.needsSetup(fs, dataDir, configPath), true);
});

test("local model actions return a safe not-yet-available status", () => {
  const dataDir = tempDataDir();
  const { controller, completed } = controllerFor(dataDir);
  assert.deepEqual(controller.listLocalModels(), []);
  assert.deepEqual(controller.downloadLocalModel("any-model"), { error: setup.LOCAL_UNAVAILABLE });
  assert.throws(() => controller.completeSetup({ mode: "local" }), /not yet available/);
  assert.deepEqual(completed, []);
});

test("IPC handlers reject other senders and hide unexpected error details", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const controller = {
    getSetupState: () => ({ storagePath: "/test" }),
    saveOnlineProvider: () => { throw new Error(`/secret/path ${TEST_KEY}`); },
    testOnlineProvider: () => ({ ok: true }),
    listLocalModels: () => [],
    downloadLocalModel: () => ({ error: "x" }),
    completeSetup: () => ({ ok: true }),
  };
  const trusted = { trusted: true };
  setup.registerSetupHandlers(ipcMain, () => controller, (event) => event === trusted);

  const expected = Object.entries(setup.CHANNELS)
    .filter(([name]) => name !== "localModelProgress")
    .map(([, channel]) => channel)
    .sort();
  assert.deepEqual([...handlers.keys()].sort(), expected);

  assert.deepEqual(await handlers.get(setup.CHANNELS.getSetupState)({}), {
    error: "This request did not come from the setup window.",
  });
  assert.deepEqual(await handlers.get(setup.CHANNELS.getSetupState)(trusted), { storagePath: "/test" });
  assert.deepEqual(await handlers.get(setup.CHANNELS.saveOnlineProvider)(trusted, {}), {
    error: "Setup could not complete this step.",
  });
});

function fakeElectron() {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      this.webContents = {
        on: (name, fn) => { this.handlers[name] = fn; },
        setWindowOpenHandler: (fn) => { this.openHandler = fn; },
      };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return false; }
    show() {}
    focus() {}
    loadFile(file) { this.loadedFile = file; }
    static getAllWindows() { return windows.filter((window) => !window.destroyed); }
  }
  const handlers = new Map();
  return {
    windows,
    handlers,
    electron: {
      app: { dock: { show() {}, hide() {} } },
      BrowserWindow,
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    },
  };
}

test("setup window uses the same hardening as the wiki window and loads only setup.html", async () => {
  const wikiFake = fakeElectron();
  require("../wiki-window").createWikiWindow(wikiFake.electron, { dataDir: tempDataDir(), python: "", configPath: "" });
  const setupFake = fakeElectron();
  const dataDir = tempDataDir();
  const win = setup.createSetupWindow(setupFake.electron, {
    fs,
    secretStore: { save() {}, read: () => "" },
    dataDir,
    configPath: path.join(dataDir, "config.toml"),
    python: "/nonexistent/python",
    spawnFn: () => assert.fail("spawn must not run"),
  });

  const { preload: wikiPreload, ...wikiPrefs } = wikiFake.windows[0].options.webPreferences;
  const { preload: setupPreload, ...setupPrefs } = win.options.webPreferences;
  assert.deepEqual(setupPrefs, wikiPrefs);
  assert.equal(setupPrefs.sandbox, true);
  assert.equal(setupPrefs.contextIsolation, true);
  assert.equal(setupPrefs.nodeIntegration, false);
  assert.equal(path.basename(wikiPreload), "preload.js");
  assert.equal(setupPreload, path.join(__dirname, "..", "setup-preload.js"));
  assert.equal(win.loadedFile, path.join(__dirname, "..", "renderer", "setup.html"));

  for (const name of ["will-navigate", "will-attach-webview"]) {
    let prevented = false;
    win.handlers[name]({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, `${name} is not denied`);
  }
  assert.deepEqual(win.openHandler({ url: "https://example.test" }), { action: "deny" });

  const getState = setupFake.handlers.get(setup.CHANNELS.getSetupState);
  const setupUrl = require("url").pathToFileURL(path.join(__dirname, "..", "renderer", "setup.html")).href;
  assert.deepEqual(await getState({ sender: win.webContents, senderFrame: { url: setupUrl } }), {
    storagePath: dataDir,
    appliesAfter: APPLIES_SETUP,
    uiLanguage: "system",
    savedKeys: { gemini: false, openai_compatible: false },
  });
  assert.match((await getState({ sender: win.webContents, senderFrame: { url: "https://evil.test/" } })).error, /setup window/);
  assert.match((await getState({ sender: {}, senderFrame: { url: setupUrl } })).error, /setup window/);
});

test("setup main-process code never logs", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "setup-window.js"), "utf8");
  assert.doesNotMatch(source, /console\.|process\.stdout|process\.stderr/);
});

const REPO_PYTHON = path.join(__dirname, "..", "..", ".venv", "bin", "python");
const LOAD_CONFIG_SCRIPT = [
  "import sys",
  "from pathlib import Path",
  "from meeting_wiki.config import load_config",
  "config = load_config(Path(sys.argv[1]))",
  "print(config.providers.live_transcription, config.providers.live_language, config.live.allow_external_providers)",
].join("\n");

test("managed online config routes live providers online and opts in to external live providers", () => {
  const config = setup.renderOnlineConfig({
    baseUrl: "https://provider.example.test/v1",
    transcriptionModel: "test-transcribe-1",
    languageModel: "test-language-1",
  });
  assert.match(config, /^live_transcription = "openai_compatible"$/m);
  assert.match(config, /^live_language = "openai_compatible"$/m);
  assert.match(config, /^\[live\]\n(#.*\n)*allow_external_providers = true$/m);
});

test("managed online config is accepted by AppConfig", { skip: !fs.existsSync(REPO_PYTHON) && "repo .venv not installed" }, () => {
  const dataDir = tempDataDir();
  const configPath = path.join(dataDir, "config.toml");
  fs.writeFileSync(configPath, setup.renderOnlineConfig({
    baseUrl: "https://provider.example.test/v1",
    transcriptionModel: "test-transcribe-1",
    languageModel: "test-language-1",
  }));
  const env = { ...process.env, MEETING_WIKI_DATA_DIR: dataDir };
  delete env[setup.API_KEY_ENV];
  const result = require("child_process").spawnSync(REPO_PYTHON, ["-", configPath], {
    input: LOAD_CONFIG_SCRIPT,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "openai_compatible openai_compatible True");
});

function writeSetupState(dataDir, mode) {
  fs.writeFileSync(path.join(dataDir, "setup-state.json"), JSON.stringify({ version: 1, completed: true, mode }));
}

function storeWithKey(dataDir) {
  const secretStore = createSecretStore({ safeStorage: fakeSafeStorage(), fs, filePath: path.join(dataDir, "secrets.json") });
  secretStore.save(setup.SECRET_ID, TEST_KEY);
  return secretStore;
}

test("resolveProcessEnv injects the key into a copy only when setup completed online", () => {
  const dataDir = tempDataDir();
  const secretStore = storeWithKey(dataDir);
  const baseEnv = Object.freeze({ PATH: "/usr/bin" });

  assert.deepEqual(setup.resolveProcessEnv({ fs, dataDir, secretStore, baseEnv }), { env: { PATH: "/usr/bin" } });

  writeSetupState(dataDir, "local");
  assert.deepEqual(setup.resolveProcessEnv({ fs, dataDir, secretStore, baseEnv }), { env: { PATH: "/usr/bin" } });

  writeSetupState(dataDir, "online");
  const first = setup.resolveProcessEnv({ fs, dataDir, secretStore, baseEnv });
  const second = setup.resolveProcessEnv({ fs, dataDir, secretStore, baseEnv });
  assert.deepEqual(first, { env: { PATH: "/usr/bin", [setup.API_KEY_ENV]: TEST_KEY } });
  assert.notEqual(first.env, second.env, "each child gets its own env object");
  assert.deepEqual(baseEnv, { PATH: "/usr/bin" });
});

test("resolveProcessEnv overrides an inherited key with the Keychain value", () => {
  const dataDir = tempDataDir();
  writeSetupState(dataDir, "online");
  const result = setup.resolveProcessEnv({
    fs,
    dataDir,
    secretStore: storeWithKey(dataDir),
    baseEnv: { [setup.API_KEY_ENV]: "inherited-value" },
  });
  assert.equal(result.env[setup.API_KEY_ENV], TEST_KEY);
});

test("resolveProcessEnv returns a safe error and no env when the online key is unavailable", () => {
  const dataDir = tempDataDir();
  writeSetupState(dataDir, "online");
  const baseEnv = { PATH: "/usr/bin", [setup.API_KEY_ENV]: "inherited-value" };
  const stores = [
    { read: () => { throw new Error(`macOS Keychain encryption is unavailable ${TEST_KEY}`); } },
    { read: () => "" },
  ];
  for (const secretStore of stores) {
    const result = setup.resolveProcessEnv({ fs, dataDir, secretStore, baseEnv });
    assert.deepEqual(result, { error: setup.KEY_UNAVAILABLE });
    assert.ok(!result.error.includes(TEST_KEY));
  }
});

// ---- Gemini provider ----

const GEMINI_KEY = "test-gemini-key-not-real-0000";
const GEMINI_SETTINGS = Object.freeze({ apiKey: GEMINI_KEY, acknowledgedEgress: true });

test("Gemini constants are provider scoped and models use the source-backed defaults", () => {
  assert.equal(setup.GEMINI_SECRET_ID, "gemini");
  assert.equal(setup.GEMINI_API_KEY_ENV, "MEETING_WIKI_GEMINI_API_KEY");
  assert.deepEqual(setup.GEMINI_MODELS, {
    batchAudioModel: "gemini-3.5-flash",
    batchAudioApi: "generate_content",
    liveModel: "gemini-3.5-transcribe-live",
    languageModel: "gemini-3.5-flash",
  });
  assert.notEqual(setup.GEMINI_SECRET_ID, setup.SECRET_ID);
  assert.notEqual(setup.GEMINI_API_KEY_ENV, setup.API_KEY_ENV);
});

test("Gemini validation requires egress acknowledgement and a clean key, and ignores other fields", () => {
  const cases = [
    [{ acknowledgedEgress: false }, /Confirm that meeting data/],
    [{ acknowledgedEgress: "true" }, /Confirm that meeting data/],
    [{ apiKey: "" }, /API key/],
    [{ apiKey: "has space" }, /API key/],
    [{ apiKey: "line\nbreak" }, /API key/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(
      () => setup.validateGeminiSettings({ ...GEMINI_SETTINGS, ...override }),
      (error) => error instanceof setup.SetupError && pattern.test(error.message) && !error.message.includes(GEMINI_KEY),
    );
  }
  assert.throws(() => setup.validateGeminiSettings(null), setup.SetupError);
  assert.deepEqual(
    setup.validateGeminiSettings({ ...GEMINI_SETTINGS, apiKey: ` ${GEMINI_KEY} `, baseUrl: "https://evil.test", model: "x" }),
    { apiKey: GEMINI_KEY },
  );
});

test("renderGeminiConfig selects gemini everywhere with the default models and only the key env name", () => {
  const config = setup.renderGeminiConfig();
  assert.ok(config.startsWith(setup.MANAGED_HEADER));
  for (const capability of ["transcription", "llm", "live_transcription", "live_language"]) {
    assert.match(config, new RegExp(`^${capability} = "gemini"$`, "m"));
  }
  assert.match(config, /^\[live\]\n(#.*\n)*allow_external_providers = true$/m);
  assert.match(config, /^\[gemini\]$/m);
  assert.match(config, /^api_key_env = "MEETING_WIKI_GEMINI_API_KEY"$/m);
  assert.match(config, /^batch_audio_model = "gemini-3\.5-flash"$/m);
  assert.match(config, /^batch_audio_api = "generate_content"$/m);
  assert.match(config, /^live_model = "gemini-3\.5-transcribe-live"$/m);
  assert.match(config, /^language_model = "gemini-3\.5-flash"$/m);
  assert.doesNotMatch(config, /openai|MEETING_WIKI_ONLINE_API_KEY|base_url/);
});

// A managed config as setup wrote it before batch_audio_api existed.
function legacyGeminiConfig(batchModel = "gemini-3.5-transcribe") {
  return setup
    .renderGeminiConfig()
    .replace(/^batch_audio_api = .*\n/m, "")
    .replace(/^batch_audio_model = .*$/m, `batch_audio_model = ${setup.tomlString(batchModel)}`);
}

test("the legacy batch model migrates to the general model and generate_content", () => {
  const legacy = legacyGeminiConfig();
  const migrated = setup.migrateGeminiBatchAudio(legacy);

  assert.match(migrated, /^batch_audio_model = "gemini-3\.5-flash"\nbatch_audio_api = "generate_content"$/m);
  assert.equal(migrated, setup.renderGeminiConfig());
  assert.equal(setup.migrateGeminiBatchAudio(migrated), null);
});

test("a custom batch model keeps the transcription API it already used", () => {
  const migrated = setup.migrateGeminiBatchAudio(legacyGeminiConfig("custom-transcribe-model"));

  assert.match(migrated, /^batch_audio_model = "custom-transcribe-model"\nbatch_audio_api = "interactions"$/m);
});

test("migration leaves unmanaged, non-Gemini, and already migrated configs alone", () => {
  for (const text of [
    null,
    "# My config\n[gemini]\nbatch_audio_model = \"gemini-3.5-transcribe\"\n",
    setup.renderOnlineConfig({ baseUrl: "https://provider.example.test/v1", transcriptionModel: "a", languageModel: "b" }),
    setup.renderGeminiConfig(),
  ]) {
    assert.equal(setup.migrateGeminiBatchAudio(text), null);
  }
});

test("a committed Gemini setup stores the key encrypted under the gemini secret and never in plaintext", async () => {
  const dataDir = tempDataDir();
  const { controller } = controllerFor(dataDir, { code: 0 });

  assert.deepEqual(controller.saveGeminiProvider({ ...GEMINI_SETTINGS }), { ok: true });
  assert.equal(fs.existsSync(path.join(dataDir, "secrets.json")), false, "staging must not touch the Keychain store");
  await controller.testGeminiProvider({ acknowledgedEgress: true });
  controller.completeSetup({ mode: "online", provider: "gemini" });

  const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, "secrets.json"), "utf8"));
  assert.deepEqual(Object.keys(secrets), ["gemini"]);
  const configPath = path.join(dataDir, "config.toml");
  const firstRunLanguages = { ...DEFAULT_LANGUAGE_SETTINGS, uiLanguage: "system", liveTranslationLanguage: "en", liveSummaryLanguage: "en" };
  assert.equal(fs.readFileSync(configPath, "utf8"), setup.renderGeminiConfig({}, EMPTY_IDENTITY, firstRunLanguages));
  assert.equal(mode(configPath), 0o600);
  for (const name of fs.readdirSync(dataDir)) assert.ok(!name.includes(GEMINI_KEY), "key in a file name");
  for (const content of filesUnder(dataDir)) assert.ok(!content.includes(GEMINI_KEY), "plaintext key on disk");
});

test("saveGeminiProvider rejects missing acknowledgement before writing anything", () => {
  const dataDir = tempDataDir();
  const { controller } = controllerFor(dataDir);
  assert.throws(() => controller.saveGeminiProvider({ apiKey: GEMINI_KEY }), /Confirm that meeting data/);
  assert.deepEqual(fs.readdirSync(dataDir), ["python"]);
});

test("testGeminiProvider runs doctor with only the Gemini key in the child environment", async () => {
  const dataDir = tempDataDir();
  const { controller, spawn, baseEnv } = controllerFor(dataDir, { code: 0, stdout: "OK transcription: ok\nOK llm: ok\n" });
  baseEnv.MEETING_WIKI_ONLINE_API_KEY = "inherited-online-value";
  baseEnv.MEETING_WIKI_GEMINI_API_KEY = "inherited-gemini-value";

  await assert.rejects(async () => controller.testGeminiProvider({ acknowledgedEgress: true }), /Save the provider settings/);
  controller.saveGeminiProvider({ ...GEMINI_SETTINGS });
  await assert.rejects(async () => controller.testGeminiProvider({}), /Confirm that meeting data/);
  const result = await controller.testGeminiProvider({ acknowledgedEgress: true, apiKey: "ignored-renderer-value" });

  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes(GEMINI_KEY));
  assert.equal(spawn.calls.length, 1);
  const [call] = spawn.calls;
  assert.equal(call.env.MEETING_WIKI_GEMINI_API_KEY, GEMINI_KEY);
  assert.equal("MEETING_WIKI_ONLINE_API_KEY" in call.env, false, "online key leaked into Gemini check");
  assert.deepEqual(call.args.filter((_, index) => index !== 3), ["-m", "meeting_wiki.cli", "--config", "doctor"]);
  assert.match(call.args[3], /\/\.config\.candidate\.[0-9a-f]{12}\.toml$/);
  assert.ok(!call.args.some((arg) => arg.includes(GEMINI_KEY)));
  assert.equal("MEETING_WIKI_GEMINI_API_KEY" in call.liveEnv, false, "key not discarded after check");
  assert.equal(baseEnv.MEETING_WIKI_GEMINI_API_KEY, "inherited-gemini-value");
  assert.equal("MEETING_WIKI_GEMINI_API_KEY" in process.env, false);
});

test("a failed Gemini check redacts the key", async () => {
  const dataDir = tempDataDir();
  const stdout = `FAIL llm: rejected ${GEMINI_KEY}\nProvider configuration error: missing ${GEMINI_KEY}\n`;
  const { controller } = controllerFor(dataDir, { code: 1, stdout });
  controller.saveGeminiProvider({ ...GEMINI_SETTINGS });
  const result = await controller.testGeminiProvider({ acknowledgedEgress: true });
  assert.ok(!result.error.includes(GEMINI_KEY));
  assert.match(result.error, /\[redacted\]/);
  assert.throws(() => controller.completeSetup({ mode: "online", provider: "gemini" }), /Test the provider connection/);
});

test("completeSetup records the Gemini provider and requires the matching provider test", async () => {
  const dataDir = tempDataDir();
  const { controller, completed } = controllerFor(dataDir, { code: 0 });
  controller.saveGeminiProvider({ ...GEMINI_SETTINGS });
  await controller.testGeminiProvider({ acknowledgedEgress: true });

  assert.throws(() => controller.completeSetup({ mode: "online" }), /Test the provider connection/);
  assert.deepEqual(controller.completeSetup({ mode: "online", provider: "gemini" }), { ok: true });

  assert.deepEqual(completed, ["online"]);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "setup-state.json"), "utf8"));
  assert.equal(saved.mode, "online");
  assert.equal(saved.provider, "gemini");
  assert.deepEqual(controller.getSetupState(), { storagePath: dataDir, appliesAfter: APPLIES_SETUP, uiLanguage: "system", savedKeys: { gemini: true, openai_compatible: false }, mode: "online", provider: "gemini" });
});

test("saving the generic provider after a Gemini test invalidates the Gemini session", async () => {
  const dataDir = tempDataDir();
  const { controller } = controllerFor(dataDir, { code: 0 });
  controller.saveGeminiProvider({ ...GEMINI_SETTINGS });
  await controller.testGeminiProvider({ acknowledgedEgress: true });
  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  assert.throws(() => controller.completeSetup({ mode: "online", provider: "gemini" }), /Test the provider connection/);
  await controller.testOnlineProvider();
  assert.deepEqual(controller.completeSetup({ mode: "online" }), { ok: true });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "setup-state.json"), "utf8"));
  assert.equal(saved.provider, "openai_compatible");
  assert.deepEqual(controller.getSetupState(), { storagePath: dataDir, appliesAfter: APPLIES_SETUP, uiLanguage: "system", savedKeys: { gemini: false, openai_compatible: true }, mode: "online" });
});

test("the generic OpenAI-compatible check keeps only the online key in the child environment", async () => {
  const dataDir = tempDataDir();
  const { controller, spawn, baseEnv } = controllerFor(dataDir, { code: 0 });
  baseEnv.MEETING_WIKI_GEMINI_API_KEY = "inherited-gemini-value";
  controller.saveOnlineProvider({ ...VALID_SETTINGS });
  await controller.testOnlineProvider();
  const [call] = spawn.calls;
  assert.equal(call.env.MEETING_WIKI_ONLINE_API_KEY, TEST_KEY);
  assert.equal("MEETING_WIKI_GEMINI_API_KEY" in call.env, false);
});

test("IPC registers the narrow Gemini channels and forwards only settings", async () => {
  const handlers = new Map();
  const received = [];
  const controller = {
    saveGeminiProvider: (settings) => { received.push(["save", settings]); return { ok: true }; },
    testGeminiProvider: (settings) => { received.push(["test", settings]); return { ok: true }; },
  };
  const trusted = { trusted: true };
  setup.registerSetupHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, () => controller, (event) => event === trusted);
  assert.equal(setup.CHANNELS.saveGeminiProvider, "setup:saveGeminiProvider");
  assert.equal(setup.CHANNELS.testGeminiProvider, "setup:testGeminiProvider");
  await handlers.get(setup.CHANNELS.saveGeminiProvider)(trusted, GEMINI_SETTINGS, "extra");
  await handlers.get(setup.CHANNELS.testGeminiProvider)(trusted, { acknowledgedEgress: true });
  assert.deepEqual(received, [["save", GEMINI_SETTINGS], ["test", { acknowledgedEgress: true }]]);
  assert.match((await handlers.get(setup.CHANNELS.saveGeminiProvider)({}, GEMINI_SETTINGS)).error, /setup window/);
});

function writeState(dataDir, state) {
  fs.writeFileSync(path.join(dataDir, "setup-state.json"), JSON.stringify({ version: 1, completed: true, ...state }));
}

function storeWithBothKeys(dataDir) {
  const secretStore = createSecretStore({ safeStorage: fakeSafeStorage(), fs, filePath: path.join(dataDir, "secrets.json") });
  secretStore.save(setup.SECRET_ID, TEST_KEY);
  secretStore.save(setup.GEMINI_SECRET_ID, GEMINI_KEY);
  return secretStore;
}

const INHERITED_ENV = Object.freeze({
  PATH: "/usr/bin",
  MEETING_WIKI_ONLINE_API_KEY: "inherited-online-value",
  MEETING_WIKI_GEMINI_API_KEY: "inherited-gemini-value",
});

test("resolveProcessEnv injects only the Gemini key for Gemini setup state", () => {
  const dataDir = tempDataDir();
  writeState(dataDir, { mode: "online", provider: "gemini" });
  const result = setup.resolveProcessEnv({ fs, dataDir, secretStore: storeWithBothKeys(dataDir), baseEnv: INHERITED_ENV });
  assert.deepEqual(result, { env: { PATH: "/usr/bin", MEETING_WIKI_GEMINI_API_KEY: GEMINI_KEY } });
  assert.equal(INHERITED_ENV.MEETING_WIKI_GEMINI_API_KEY, "inherited-gemini-value");
  assert.equal("MEETING_WIKI_GEMINI_API_KEY" in process.env, false);
});

test("resolveProcessEnv keeps legacy and openai_compatible online states on the online key", () => {
  for (const state of [{ mode: "online" }, { mode: "online", provider: "openai_compatible" }]) {
    const dataDir = tempDataDir();
    writeState(dataDir, state);
    const result = setup.resolveProcessEnv({ fs, dataDir, secretStore: storeWithBothKeys(dataDir), baseEnv: INHERITED_ENV });
    assert.deepEqual(result, { env: { PATH: "/usr/bin", MEETING_WIKI_ONLINE_API_KEY: TEST_KEY } });
  }
});

test("resolveProcessEnv injects no managed key for local state", () => {
  const dataDir = tempDataDir();
  writeState(dataDir, { mode: "local" });
  const result = setup.resolveProcessEnv({ fs, dataDir, secretStore: storeWithBothKeys(dataDir), baseEnv: { PATH: "/usr/bin" } });
  assert.deepEqual(result, { env: { PATH: "/usr/bin" } });
});

test("resolveProcessEnv returns a safe error when the Gemini key is unavailable", () => {
  const dataDir = tempDataDir();
  writeState(dataDir, { mode: "online", provider: "gemini" });
  const onlineOnly = storeWithKey(dataDir);
  const result = setup.resolveProcessEnv({ fs, dataDir, secretStore: onlineOnly, baseEnv: INHERITED_ENV });
  assert.deepEqual(result, { error: setup.GEMINI_KEY_UNAVAILABLE });
  assert.ok(!result.error.includes(GEMINI_KEY));
});

test("managed Gemini config is accepted by AppConfig and passes doctor", { skip: !fs.existsSync(REPO_PYTHON) && "repo .venv not installed" }, () => {
  const dataDir = tempDataDir();
  const configPath = path.join(dataDir, "config.toml");
  fs.writeFileSync(configPath, setup.renderGeminiConfig());
  const env = { ...process.env, MEETING_WIKI_DATA_DIR: dataDir };
  delete env[setup.API_KEY_ENV];
  delete env[setup.GEMINI_API_KEY_ENV];
  const { spawnSync } = require("child_process");
  const loaded = spawnSync(REPO_PYTHON, ["-", configPath], { input: LOAD_CONFIG_SCRIPT, env, encoding: "utf8" });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout.trim(), "gemini gemini True");

  const doctor = spawnSync(REPO_PYTHON, ["-m", "meeting_wiki.cli", "--config", configPath, "doctor"], {
    env: { ...env, [setup.GEMINI_API_KEY_ENV]: GEMINI_KEY },
    encoding: "utf8",
  });
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /^OK transcription: .*gemini-3\.5-flash/m);
  assert.match(doctor.stdout, /^OK llm: .*gemini-3\.5-flash/m);
  assert.ok(!(doctor.stdout + doctor.stderr).includes(GEMINI_KEY));
});

test("credentialFreeEnv copies the base env without any managed provider key", () => {
  const baseEnv = Object.freeze({
    PATH: "/usr/bin",
    [setup.API_KEY_ENV]: "inherited-value",
    [setup.GEMINI_API_KEY_ENV]: "inherited-gemini-value",
  });
  const env = setup.credentialFreeEnv(baseEnv);
  assert.deepEqual(env, { PATH: "/usr/bin" });
  assert.notEqual(env, baseEnv);
  assert.equal(baseEnv[setup.API_KEY_ENV], "inherited-value");
});


// ---- App language ----

function completeGeminiWithLanguage(systemLocale) {
  const dataDir = tempDataDir();
  const store = createSecretStore({ safeStorage: fakeSafeStorage(), fs, filePath: path.join(dataDir, "secrets.json") });
  const { controller } = controllerWithStore(dataDir, store, { code: 0 }, { systemLocale: () => systemLocale });
  return { controller, configPath: path.join(dataDir, "config.toml") };
}

test("the setup language becomes the UI, live translation, and live summary language", async () => {
  for (const [choice, systemLocale, expected] of [
    ["zh-CN", "en-US", { ui: "zh-CN", translation: "zh-CN" }],
    ["en", "zh-CN", { ui: "en", translation: "en" }],
    ["system", "zh-Hans-CN", { ui: "system", translation: "zh-CN" }],
    ["system", "en-GB", { ui: "system", translation: "en" }],
  ]) {
    const { controller, configPath } = completeGeminiWithLanguage(systemLocale);
    assert.deepEqual(controller.setAppLanguage(choice), { ok: true });
    controller.saveGeminiProvider({ apiKey: "test-gemini-key-not-real-0000", acknowledgedEgress: true });
    await controller.testGeminiProvider({ acknowledgedEgress: true });
    controller.completeSetup({ mode: "online", provider: "gemini" });
    const languages = languageFromTables(parseManagedConfig(fs.readFileSync(configPath, "utf8")));
    assert.equal(languages.uiLanguage, expected.ui, choice);
    assert.equal(languages.liveTranslationLanguage, expected.translation, choice);
    assert.equal(languages.liveSummaryLanguage, expected.translation, choice);
    assert.equal(languages.memoryLanguage, "source");
    assert.equal(controller.getSetupState().uiLanguage, expected.ui);
  }
});

test("setAppLanguage rejects unsupported values and a first run without a choice follows macOS", async () => {
  const { controller, configPath } = completeGeminiWithLanguage("en-US");
  for (const value of ["", "fr", "zh", null, 42]) {
    assert.throws(() => controller.setAppLanguage(value), /supported language/);
  }
  controller.saveGeminiProvider({ apiKey: "test-gemini-key-not-real-0000", acknowledgedEgress: true });
  await controller.testGeminiProvider({ acknowledgedEgress: true });
  controller.completeSetup({ mode: "online", provider: "gemini" });
  const languages = languageFromTables(parseManagedConfig(fs.readFileSync(configPath, "utf8")));
  assert.deepEqual(languages, {
    ...DEFAULT_LANGUAGE_SETTINGS,
    uiLanguage: "system",
    liveTranslationLanguage: "en",
    liveSummaryLanguage: "en",
  });
});

test("rerunning setup without a language choice keeps the languages saved in Settings", async () => {
  const dataDir = tempDataDir();
  const store = createSecretStore({ safeStorage: fakeSafeStorage(), fs, filePath: path.join(dataDir, "secrets.json") });
  const configPath = path.join(dataDir, "config.toml");
  const finish = async (controller) => {
    controller.saveGeminiProvider({ apiKey: "test-gemini-key-not-real-0000", acknowledgedEgress: true });
    await controller.testGeminiProvider({ acknowledgedEgress: true });
    controller.completeSetup({ mode: "online", provider: "gemini" });
  };
  const first = controllerWithStore(dataDir, store, { code: 0 }, { systemLocale: () => "en-US" }).controller;
  first.setAppLanguage("zh-CN");
  await finish(first);
  const edited = fs.readFileSync(configPath, "utf8")
    .replace('live_summary = "zh-CN"', 'live_summary = "en"')
    .replace('memory = "source"', 'memory = "zh-CN"');
  fs.writeFileSync(configPath, edited);
  const saved = languageFromTables(parseManagedConfig(edited));
  assert.equal(saved.liveSummaryLanguage, "en");
  assert.equal(saved.memoryLanguage, "zh-CN");

  await finish(controllerWithStore(dataDir, store, { code: 0 }, { systemLocale: () => "zh-CN" }).controller);
  assert.deepEqual(languageFromTables(parseManagedConfig(fs.readFileSync(configPath, "utf8"))), saved);
});
