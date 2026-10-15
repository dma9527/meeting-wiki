"use strict";

// First-run setup window. Same lockdown as wiki-window.js. The API key crosses
// from the renderer exactly once (saveOnlineProvider), goes straight to the
// Keychain-backed secret store, and is never returned, logged, or written to TOML.

const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");

const API_KEY_ENV = "MEETING_WIKI_ONLINE_API_KEY";
const SECRET_ID = "online";
const MANAGED_HEADER = "# Managed by Meeting Wiki setup.";
const SETUP_STATE_FILE = "setup-state.json";
const CHECK_TIMEOUT_MS = 30_000;
const MAX_CHECK_OUTPUT = 64 * 1024;
const LOCAL_UNAVAILABLE = "Local model downloads are not yet available in this build. Choose Online API key.";

const CHANNELS = Object.freeze({
  getSetupState: "setup:getSetupState",
  saveOnlineProvider: "setup:saveOnlineProvider",
  testOnlineProvider: "setup:testOnlineProvider",
  listLocalModels: "setup:listLocalModels",
  downloadLocalModel: "setup:downloadLocalModel",
  completeSetup: "setup:completeSetup",
  localModelProgress: "setup:localModelProgress",
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const API_KEY_PATTERN = /^[\x21-\x7e]{1,4096}$/;

// Errors whose message is safe to show in the renderer.
class SetupError extends Error {}

function validateOnlineSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  if (source.acknowledgedEgress !== true) {
    throw new SetupError("Confirm that meeting data will be sent to this provider.");
  }
  const baseUrlRaw = typeof source.baseUrl === "string" ? source.baseUrl.trim() : "";
  if (!baseUrlRaw || baseUrlRaw.length > 2048) throw new SetupError("Enter the provider's endpoint URL.");
  let url;
  try {
    url = new URL(baseUrlRaw);
  } catch (_) {
    throw new SetupError("Enter a full URL, for example https://provider.example/v1.");
  }
  if (url.username || url.password) throw new SetupError("Remove the username or password from the URL.");
  if (url.search || url.hash) throw new SetupError("Remove the query string or fragment from the URL.");
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new SetupError("Use an https URL. Plain http is allowed only for a server on this Mac.");
  }
  const models = {};
  for (const [field, label] of [
    ["transcriptionModel", "transcription model"],
    ["languageModel", "summary and translation model"],
  ]) {
    const value = typeof source[field] === "string" ? source[field].trim() : "";
    if (!MODEL_PATTERN.test(value)) throw new SetupError(`Enter a valid ${label} name.`);
    models[field] = value;
  }
  const apiKey = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new SetupError("Enter the API key from your provider without spaces or line breaks.");
  }
  return {
    settings: {
      baseUrl: url.toString().replace(/\/+$/, ""),
      host: url.host,
      loopback,
      ...models,
    },
    apiKey,
  };
}

function tomlString(value) {
  const escaped = String(value).replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    if (char === "\\") return "\\\\";
    if (char === '"') return '\\"';
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `"${escaped}"`;
}

function renderOnlineConfig(settings) {
  return [
    MANAGED_HEADER,
    "# Secrets are not stored here. The API key lives in the macOS Keychain and is",
    `# provided to Meeting Wiki processes through ${API_KEY_ENV}.`,
    "",
    "[providers]",
    'transcription = "openai_compatible"',
    'llm = "openai_compatible"',
    'live_transcription = "openai_compatible"',
    'live_language = "openai_compatible"',
    "",
    "[live]",
    "# The user acknowledged sending meeting data to this provider during setup.",
    "allow_external_providers = true",
    "",
    "[openai_compatible]",
    `base_url = ${tomlString(settings.baseUrl)}`,
    `model = ${tomlString(settings.languageModel)}`,
    `api_key_env = ${tomlString(API_KEY_ENV)}`,
    "",
    "[openai_transcription]",
    `base_url = ${tomlString(settings.baseUrl)}`,
    `model = ${tomlString(settings.transcriptionModel)}`,
    `api_key_env = ${tomlString(API_KEY_ENV)}`,
    "",
  ].join("\n");
}

function ensurePrivateDir(fs, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

// Write to an exclusive owner-only temp file in the same directory, fsync, then rename.
function atomicWriteFile(fs, filePath, content) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(fs, dir);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* already closed */ }
    }
    try { fs.unlinkSync(tempPath); } catch (_) { /* never created */ }
    throw error;
  }
}

function readText(fs, filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return null;
  }
}

function isManagedConfig(text) {
  return typeof text === "string" && text.startsWith(MANAGED_HEADER);
}

// A hand-written config is preserved as an owner-only backup before setup replaces it.
function backupUnmanagedConfig(fs, configPath, now) {
  const existing = readText(fs, configPath);
  if (existing === null || isManagedConfig(existing)) return null;
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.before-setup-${stamp}`;
  atomicWriteFile(fs, backupPath, existing);
  return backupPath;
}

function readSetupState(fs, dataDir) {
  const text = readText(fs, path.join(dataDir, SETUP_STATE_FILE));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.completed === true ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Setup is needed unless it was completed, or a hand-written config predates the wizard.
function needsSetup(fs, dataDir, configPath) {
  if (readSetupState(fs, dataDir)) return false;
  const existing = readText(fs, configPath);
  return existing === null || isManagedConfig(existing);
}

const KEY_UNAVAILABLE = "The online API key could not be read from the macOS Keychain. Run setup again.";

// Child environment for a processing process. The online key is added only when setup
// completed in online mode; returns { error } instead of an env when the key is unavailable.
function resolveProcessEnv({ fs, dataDir, secretStore, baseEnv }) {
  const env = { ...baseEnv };
  const state = readSetupState(fs, dataDir);
  if (!state || state.mode !== "online") return { env };
  delete env[API_KEY_ENV];
  let apiKey = "";
  try {
    apiKey = secretStore.read(SECRET_ID);
  } catch (_) {
    return { error: KEY_UNAVAILABLE };
  }
  if (!apiKey) return { error: KEY_UNAVAILABLE };
  env[API_KEY_ENV] = apiKey;
  return { env };
}

function failureDetail(stdout, apiKey) {
  const lines = String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^FAIL (transcription|llm):/.test(line) || line.startsWith("Provider configuration error:"));
  let detail = lines.join(" ").slice(0, 300);
  if (apiKey) detail = detail.split(apiKey).join("[redacted]");
  return detail;
}

// Run `meeting-wiki doctor` with the key present only in this child's environment.
function runProviderCheck({ spawnFn, python, configPath, apiKey, baseEnv, timeoutMs = CHECK_TIMEOUT_MS }) {
  const childEnv = { ...baseEnv };
  delete childEnv[API_KEY_ENV];
  childEnv[API_KEY_ENV] = apiKey;
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete childEnv[API_KEY_ENV];
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child) child.kill("SIGKILL");
      finish({ error: "The provider did not respond within 30 seconds." });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      child = spawnFn(python, ["-m", "meeting_wiki.cli", "--config", configPath, "doctor"], {
        env: childEnv,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (_) {
      finish({ error: "The connection check could not start." });
      return;
    }
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_CHECK_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.once("error", () => finish({ error: "The connection check could not start." }));
    child.once("close", (code) => {
      if (code === 0) {
        finish({ ok: true, detail: "Transcription and language endpoints responded." });
      } else {
        finish({ error: failureDetail(stdout, apiKey) || "The provider rejected the connection check." });
      }
    });
  });
}

function createSetupController({
  fs,
  secretStore,
  dataDir,
  configPath,
  python,
  spawnFn,
  baseEnv = process.env,
  now = () => new Date(),
  onComplete = () => {},
}) {
  const session = { savedOnline: false, testedOnline: false };

  return {
    getSetupState() {
      const completed = readSetupState(fs, dataDir);
      const result = { storagePath: dataDir };
      if (completed && (completed.mode === "online" || completed.mode === "local")) result.mode = completed.mode;
      return result;
    },

    saveOnlineProvider(raw) {
      const { settings, apiKey } = validateOnlineSettings(raw);
      session.savedOnline = false;
      session.testedOnline = false;
      try {
        secretStore.save(SECRET_ID, apiKey);
      } catch (error) {
        throw new SetupError(
          /Keychain/.test(error && error.message) ? "macOS Keychain encryption is unavailable." : "The API key could not be saved.",
        );
      }
      try {
        backupUnmanagedConfig(fs, configPath, now);
        atomicWriteFile(fs, configPath, renderOnlineConfig(settings));
      } catch (_) {
        throw new SetupError("The provider settings could not be saved.");
      }
      session.savedOnline = true;
      return { ok: true };
    },

    async testOnlineProvider() {
      if (!session.savedOnline) throw new SetupError("Save the provider settings before testing.");
      if (!fs.existsSync(python)) {
        throw new SetupError("The Meeting Wiki engine is not installed yet, so the connection cannot be tested.");
      }
      let apiKey = "";
      try {
        apiKey = secretStore.read(SECRET_ID);
      } catch (_) {
        throw new SetupError("macOS Keychain encryption is unavailable.");
      }
      if (!apiKey) throw new SetupError("The saved API key could not be read. Enter it again.");
      const result = await runProviderCheck({ spawnFn, python, configPath, apiKey, baseEnv });
      apiKey = "";
      session.testedOnline = Boolean(result.ok);
      return result;
    },

    listLocalModels() {
      return [];
    },

    downloadLocalModel() {
      return { error: LOCAL_UNAVAILABLE };
    },

    completeSetup(options) {
      const mode = options && typeof options === "object" ? options.mode : undefined;
      if (mode === "local") throw new SetupError(LOCAL_UNAVAILABLE);
      if (mode !== "online") throw new SetupError("Choose a setup path first.");
      if (!session.testedOnline) throw new SetupError("Test the provider connection before finishing.");
      try {
        atomicWriteFile(
          fs,
          path.join(dataDir, SETUP_STATE_FILE),
          JSON.stringify({ version: 1, completed: true, mode, completedAt: now().toISOString() }),
        );
      } catch (_) {
        throw new SetupError("Setup could not be saved.");
      }
      onComplete(mode);
      return { ok: true };
    },
  };
}

async function guard(operation) {
  try {
    const result = await operation();
    return result === undefined ? { ok: true } : result;
  } catch (error) {
    // Only messages written for the renderer are surfaced. Never stacks, paths, or input.
    return { error: error instanceof SetupError ? error.message : "Setup could not complete this step." };
  }
}

function registerSetupHandlers(ipcMain, getController, isTrustedSender) {
  const handle = (channel, run) =>
    ipcMain.handle(channel, (event, ...args) =>
      guard(async () => {
        if (!isTrustedSender(event)) throw new SetupError("This request did not come from the setup window.");
        return run(getController(), ...args);
      }),
    );
  handle(CHANNELS.getSetupState, (controller) => controller.getSetupState());
  handle(CHANNELS.saveOnlineProvider, (controller, settings) => controller.saveOnlineProvider(settings));
  handle(CHANNELS.testOnlineProvider, (controller) => controller.testOnlineProvider());
  handle(CHANNELS.listLocalModels, (controller) => controller.listLocalModels());
  handle(CHANNELS.downloadLocalModel, (controller, id) => controller.downloadLocalModel(String(id || "")));
  handle(CHANNELS.completeSetup, (controller, options) => controller.completeSetup(options));
}

let setupWindow = null;
let setupController = null;
let handlersRegistered = false;
const SETUP_PAGE = path.join(__dirname, "renderer", "setup.html");

function isSetupSender(event) {
  if (!setupWindow || setupWindow.isDestroyed()) return false;
  if (!event || event.sender !== setupWindow.webContents) return false;
  const frame = event.senderFrame;
  return Boolean(frame) && frame.url === pathToFileURL(SETUP_PAGE).href;
}

function createSetupWindow(electron, context) {
  const { app, BrowserWindow, ipcMain } = electron;
  if (!setupController) setupController = createSetupController(context);
  if (!handlersRegistered) {
    handlersRegistered = true;
    registerSetupHandlers(ipcMain, () => setupController, isSetupSender);
  }
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return setupWindow;
  }
  if (app.dock) app.dock.show();
  setupWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: "Set up Meeting Wiki",
    backgroundColor: "#f4f1ea",
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });
  const denyNavigation = (event) => event.preventDefault();
  setupWindow.webContents.on("will-navigate", denyNavigation);
  setupWindow.webContents.on("will-attach-webview", denyNavigation);
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWindow.once("ready-to-show", () => setupWindow.show());
  setupWindow.on("closed", () => {
    setupWindow = null;
    // A new window starts a new session: the key must be saved and tested again.
    setupController = null;
    const othersOpen = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible());
    if (app.dock && !othersOpen) app.dock.hide();
  });
  setupWindow.loadFile(SETUP_PAGE);
  return setupWindow;
}

module.exports = {
  API_KEY_ENV,
  CHANNELS,
  KEY_UNAVAILABLE,
  LOCAL_UNAVAILABLE,
  MANAGED_HEADER,
  SECRET_ID,
  SetupError,
  atomicWriteFile,
  createSetupController,
  createSetupWindow,
  failureDetail,
  guard,
  needsSetup,
  registerSetupHandlers,
  renderOnlineConfig,
  resolveProcessEnv,
  runProviderCheck,
  tomlString,
  validateOnlineSettings,
};
