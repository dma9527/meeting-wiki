"use strict";

// First-run setup window. Same lockdown as wiki-window.js. An API key crosses from
// the renderer exactly once (saveOnlineProvider or saveGeminiProvider), goes straight
// to the Keychain-backed secret store, and is never returned, logged, or written to TOML.

const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");

const API_KEY_ENV = "MEETING_WIKI_ONLINE_API_KEY";
const SECRET_ID = "online";
const GEMINI_PROVIDER = "gemini";
const OPENAI_PROVIDER = "openai_compatible";
const GEMINI_API_KEY_ENV = "MEETING_WIKI_GEMINI_API_KEY";
const GEMINI_SECRET_ID = "gemini";
const GEMINI_MODELS = Object.freeze({
  batchAudioModel: "gemini-3.5-transcribe",
  liveModel: "gemini-3.5-transcribe-live",
  languageModel: "gemini-3.5-flash",
});
const MANAGED_KEY_ENVS = Object.freeze([API_KEY_ENV, GEMINI_API_KEY_ENV]);
const MANAGED_HEADER = "# Managed by Meeting Wiki setup.";
const SETUP_STATE_FILE = "setup-state.json";
const CHECK_TIMEOUT_MS = 30_000;
const MAX_CHECK_OUTPUT = 64 * 1024;
const LOCAL_UNAVAILABLE = "Local model downloads are not yet available in this build. Choose Online API key.";

const CHANNELS = Object.freeze({
  getSetupState: "setup:getSetupState",
  saveOnlineProvider: "setup:saveOnlineProvider",
  testOnlineProvider: "setup:testOnlineProvider",
  saveGeminiProvider: "setup:saveGeminiProvider",
  testGeminiProvider: "setup:testGeminiProvider",
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
  requireEgressAck(source);
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

const EGRESS_REQUIRED = "Confirm that meeting data will be sent to this provider.";

function requireEgressAck(source) {
  if (!source || typeof source !== "object" || source.acknowledgedEgress !== true) {
    throw new SetupError(EGRESS_REQUIRED);
  }
}

// Gemini accepts only a key; endpoint and models are fixed by GEMINI_MODELS.
function validateGeminiSettings(raw) {
  requireEgressAck(raw);
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new SetupError("Enter the Gemini API key without spaces or line breaks.");
  }
  return { apiKey };
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

// Settings may override the models and add the two live keys; setup passes nothing.
function renderGeminiConfig(settings = {}) {
  const models = { ...GEMINI_MODELS, ...pickDefined(settings, ["batchAudioModel", "liveModel", "languageModel"]) };
  const liveLines = [];
  if (settings.translationTargetLanguage !== undefined) {
    liveLines.push(`translation_target_language = ${tomlString(settings.translationTargetLanguage)}`);
  }
  if (settings.summaryContextCharacters !== undefined) {
    liveLines.push(`summary_context_characters = ${Number(settings.summaryContextCharacters)}`);
  }
  return [
    MANAGED_HEADER,
    "# Secrets are not stored here. The Gemini API key lives in the macOS Keychain and",
    `# is provided to Meeting Wiki processes through ${GEMINI_API_KEY_ENV}.`,
    "",
    "[providers]",
    'transcription = "gemini"',
    'llm = "gemini"',
    'live_transcription = "gemini"',
    'live_language = "gemini"',
    "",
    "[live]",
    "# The user acknowledged sending meeting data to Google Gemini during setup.",
    "allow_external_providers = true",
    ...liveLines,
    "",
    "[gemini]",
    `api_key_env = ${tomlString(GEMINI_API_KEY_ENV)}`,
    `batch_audio_model = ${tomlString(models.batchAudioModel)}`,
    `live_model = ${tomlString(models.liveModel)}`,
    `language_model = ${tomlString(models.languageModel)}`,
    "",
  ].join("\n");
}

function pickDefined(source, keys) {
  const picked = {};
  for (const key of keys) if (source[key] !== undefined) picked[key] = source[key];
  return picked;
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
const GEMINI_KEY_UNAVAILABLE = "The Gemini API key could not be read from the macOS Keychain. Run setup again.";

// Legacy online state (no provider) and openai_compatible both use the generic online key.
function providerCredentials(state) {
  if (!state || state.mode !== "online") return null;
  if (state.provider === GEMINI_PROVIDER) {
    return { secretId: GEMINI_SECRET_ID, envName: GEMINI_API_KEY_ENV, unavailable: GEMINI_KEY_UNAVAILABLE };
  }
  return { secretId: SECRET_ID, envName: API_KEY_ENV, unavailable: KEY_UNAVAILABLE };
}

// Child environment for a processing process. Only the selected provider's key is added,
// and only when setup completed online; returns { error } when that key is unavailable.
function resolveProcessEnv({ fs, dataDir, secretStore, baseEnv }) {
  const env = { ...baseEnv };
  const credentials = providerCredentials(readSetupState(fs, dataDir));
  if (!credentials) return { env };
  for (const name of MANAGED_KEY_ENVS) delete env[name];
  let apiKey = "";
  try {
    apiKey = secretStore.read(credentials.secretId);
  } catch (_) {
    return { error: credentials.unavailable };
  }
  if (!apiKey) return { error: credentials.unavailable };
  env[credentials.envName] = apiKey;
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
function runProviderCheck({
  spawnFn,
  python,
  configPath,
  apiKey,
  baseEnv,
  envName = API_KEY_ENV,
  successDetail = "Transcription and language endpoints responded.",
  timeoutMs = CHECK_TIMEOUT_MS,
}) {
  const childEnv = { ...baseEnv };
  for (const name of MANAGED_KEY_ENVS) delete childEnv[name];
  childEnv[envName] = apiKey;
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete childEnv[envName];
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child) child.kill("SIGKILL");
      finish({ error: "The provider did not respond within 30 seconds." });
    }, timeoutMs);
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
        finish({ ok: true, detail: successDetail });
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
  // savedProvider/testedProvider name the provider whose settings were saved and checked
  // in this window session; a new save of either provider resets both.
  const session = { savedProvider: null, testedProvider: null };

  function saveProvider(provider, secretId, apiKey, config) {
    session.savedProvider = null;
    session.testedProvider = null;
    try {
      secretStore.save(secretId, apiKey);
    } catch (error) {
      throw new SetupError(
        /Keychain/.test(error && error.message) ? "macOS Keychain encryption is unavailable." : "The API key could not be saved.",
      );
    }
    try {
      backupUnmanagedConfig(fs, configPath, now);
      atomicWriteFile(fs, configPath, config);
    } catch (_) {
      throw new SetupError("The provider settings could not be saved.");
    }
    session.savedProvider = provider;
    return { ok: true };
  }

  async function testProvider(provider, secretId, checkOptions) {
    if (session.savedProvider !== provider) throw new SetupError("Save the provider settings before testing.");
    if (!fs.existsSync(python)) {
      throw new SetupError("The Meeting Wiki engine is not installed yet, so the connection cannot be tested.");
    }
    let apiKey = "";
    try {
      apiKey = secretStore.read(secretId);
    } catch (_) {
      throw new SetupError("macOS Keychain encryption is unavailable.");
    }
    if (!apiKey) throw new SetupError("The saved API key could not be read. Enter it again.");
    const result = await runProviderCheck({ spawnFn, python, configPath, apiKey, baseEnv, ...checkOptions });
    apiKey = "";
    session.testedProvider = result.ok ? provider : null;
    return result;
  }

  return {
    getSetupState() {
      const completed = readSetupState(fs, dataDir);
      const result = { storagePath: dataDir };
      if (completed && (completed.mode === "online" || completed.mode === "local")) result.mode = completed.mode;
      if (result.mode === "online" && completed.provider === GEMINI_PROVIDER) result.provider = GEMINI_PROVIDER;
      return result;
    },

    saveOnlineProvider(raw) {
      const { settings, apiKey } = validateOnlineSettings(raw);
      return saveProvider(OPENAI_PROVIDER, SECRET_ID, apiKey, renderOnlineConfig(settings));
    },

    testOnlineProvider() {
      return testProvider(OPENAI_PROVIDER, SECRET_ID, {});
    },

    saveGeminiProvider(raw) {
      const { apiKey } = validateGeminiSettings(raw);
      return saveProvider(GEMINI_PROVIDER, GEMINI_SECRET_ID, apiKey, renderGeminiConfig());
    },

    // The renderer never resends the key; only the egress acknowledgement is checked.
    testGeminiProvider(raw) {
      requireEgressAck(raw);
      return testProvider(GEMINI_PROVIDER, GEMINI_SECRET_ID, {
        envName: GEMINI_API_KEY_ENV,
        successDetail: "Gemini transcription and language providers are ready.",
      });
    },

    listLocalModels() {
      return [];
    },

    downloadLocalModel() {
      return { error: LOCAL_UNAVAILABLE };
    },

    completeSetup(options) {
      const source = options && typeof options === "object" ? options : {};
      const mode = source.mode;
      if (mode === "local") throw new SetupError(LOCAL_UNAVAILABLE);
      if (mode !== "online") throw new SetupError("Choose a setup path first.");
      const provider = source.provider === GEMINI_PROVIDER ? GEMINI_PROVIDER : OPENAI_PROVIDER;
      if (session.testedProvider !== provider) throw new SetupError("Test the provider connection before finishing.");
      try {
        atomicWriteFile(
          fs,
          path.join(dataDir, SETUP_STATE_FILE),
          JSON.stringify({ version: 1, completed: true, mode, provider, completedAt: now().toISOString() }),
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
  handle(CHANNELS.saveGeminiProvider, (controller, settings) => controller.saveGeminiProvider(settings));
  handle(CHANNELS.testGeminiProvider, (controller, settings) => controller.testGeminiProvider(settings));
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
  GEMINI_API_KEY_ENV,
  GEMINI_KEY_UNAVAILABLE,
  GEMINI_MODELS,
  GEMINI_PROVIDER,
  GEMINI_SECRET_ID,
  KEY_UNAVAILABLE,
  LOCAL_UNAVAILABLE,
  MANAGED_HEADER,
  MODEL_PATTERN,
  SECRET_ID,
  SetupError,
  atomicWriteFile,
  createSetupController,
  createSetupWindow,
  failureDetail,
  guard,
  isManagedConfig,
  needsSetup,
  readSetupState,
  registerSetupHandlers,
  renderGeminiConfig,
  renderOnlineConfig,
  resolveProcessEnv,
  runProviderCheck,
  tomlString,
  validateGeminiSettings,
  validateOnlineSettings,
};
