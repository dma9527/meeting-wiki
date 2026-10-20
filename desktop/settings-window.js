"use strict";

// Gemini settings window. Same lockdown as setup-window.js. It edits only the five
// Gemini feature values in a setup-managed config and never touches the secret store.

const path = require("path");
const { pathToFileURL } = require("url");

const {
  GEMINI_API_KEY_ENV,
  GEMINI_MODELS,
  GEMINI_PROVIDER,
  MODEL_PATTERN,
  atomicWriteFile,
  isManagedConfig,
  readSetupState,
  renderGeminiConfig,
} = require("./setup-window");

const CHANNELS = Object.freeze({
  getGeminiSettings: "settings:getGeminiSettings",
  saveGeminiSettings: "settings:saveGeminiSettings",
  rerunSetup: "settings:rerunSetup",
});

// Mirrors LiveConfig in meeting_wiki/config.py; a test keeps the two in sync.
const SUMMARY_CONTEXT_BOUNDS = Object.freeze({ min: 500, max: 100000 });
const LIVE_DEFAULTS = Object.freeze({ translationTargetLanguage: "zh", summaryContextCharacters: 12000 });
// A language code (zh, pt-BR) or plain name (Japanese); it is interpolated into a prompt.
const LANGUAGE_PATTERN = /^[A-Za-z][A-Za-z0-9 -]{0,39}$/;

const NOT_GEMINI = "These settings cover Gemini only. Run setup again to configure another provider.";
const NOT_MANAGED =
  "Your configuration was not created by setup or was edited by hand. Run setup again to manage it here.";

// Exactly the keys renderGeminiConfig can emit. Anything else counts as a manual edit.
const MANAGED_SCHEMA = Object.freeze({
  providers: { transcription: "string", llm: "string", live_transcription: "string", live_language: "string" },
  live: { allow_external_providers: "boolean", translation_target_language: "string", summary_context_characters: "integer" },
  gemini: { api_key_env: "string", batch_audio_model: "string", live_model: "string", language_model: "string" },
});

class SettingsError extends Error {}

function parseValue(raw) {
  if (raw === "true") return { type: "boolean", value: true };
  if (raw === "false") return { type: "boolean", value: false };
  if (/^\d{1,9}$/.test(raw)) return { type: "integer", value: Number(raw) };
  if (/^"(?:[^"\\\u0000-\u001f]|\\["\\]|\\u[0-9a-fA-F]{4})*"$/.test(raw)) {
    return { type: "string", value: JSON.parse(raw) };
  }
  return null;
}

// Strict reader for the TOML that setup generates. Returns null for anything else.
function parseManagedGeminiConfig(text) {
  if (!isManagedConfig(text)) return null;
  const tables = {};
  let section = null;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([a-z_]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      if (!MANAGED_SCHEMA[section] || tables[section]) return null;
      tables[section] = {};
      continue;
    }
    const pair = /^([a-z_]+) = (.+)$/.exec(line);
    if (!pair || !section) return null;
    const [, key, raw] = pair;
    const expected = MANAGED_SCHEMA[section][key];
    const parsed = parseValue(raw);
    if (!expected || !parsed || parsed.type !== expected || key in tables[section]) return null;
    tables[section][key] = parsed.value;
  }
  const { providers = {}, live = {}, gemini = {} } = tables;
  const allGemini = Object.keys(MANAGED_SCHEMA.providers).every((key) => providers[key] === GEMINI_PROVIDER);
  if (!allGemini || live.allow_external_providers !== true || gemini.api_key_env !== GEMINI_API_KEY_ENV) return null;
  return {
    batchAudioModel: gemini.batch_audio_model ?? GEMINI_MODELS.batchAudioModel,
    liveModel: gemini.live_model ?? GEMINI_MODELS.liveModel,
    languageModel: gemini.language_model ?? GEMINI_MODELS.languageModel,
    translationTargetLanguage: live.translation_target_language ?? LIVE_DEFAULTS.translationTargetLanguage,
    summaryContextCharacters: live.summary_context_characters ?? LIVE_DEFAULTS.summaryContextCharacters,
  };
}

function validateGeminiFeatureSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const values = {};
  for (const [field, label] of [
    ["batchAudioModel", "recording transcription model"],
    ["liveModel", "live transcription model"],
    ["languageModel", "summary and translation model"],
  ]) {
    const value = typeof source[field] === "string" ? source[field].trim() : "";
    if (!MODEL_PATTERN.test(value)) throw new SettingsError(`Enter a valid ${label} name.`);
    values[field] = value;
  }
  const language = typeof source.translationTargetLanguage === "string" ? source.translationTargetLanguage.trim() : "";
  if (!LANGUAGE_PATTERN.test(language)) {
    throw new SettingsError("Enter a translation language code such as zh or a name such as Japanese.");
  }
  values.translationTargetLanguage = language;
  const rawCharacters = source.summaryContextCharacters;
  const characters =
    typeof rawCharacters === "number" ? rawCharacters : /^\s*\d{1,9}\s*$/.test(String(rawCharacters ?? "")) ? Number(rawCharacters) : NaN;
  const { min, max } = SUMMARY_CONTEXT_BOUNDS;
  if (!Number.isInteger(characters) || characters < min || characters > max) {
    throw new SettingsError(`Enter a whole number of summary context characters from ${min} to ${max}.`);
  }
  values.summaryContextCharacters = characters;
  return values;
}

function readText(fs, filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return null;
  }
}

function createSettingsController({ fs, dataDir, configPath, onSaved = () => {}, onRerunSetup = () => {} }) {
  // Re-read on every call so a save never trusts state rendered earlier.
  function readiness() {
    const state = readSetupState(fs, dataDir);
    if (!state || state.mode !== "online" || state.provider !== GEMINI_PROVIDER) return { ready: false, reason: NOT_GEMINI };
    const values = parseManagedGeminiConfig(readText(fs, configPath));
    if (!values) return { ready: false, reason: NOT_MANAGED };
    return { ready: true, values };
  }

  return {
    getGeminiSettings() {
      const current = readiness();
      if (!current.ready) return current;
      return { ready: true, values: current.values, bounds: { summaryContextCharacters: { ...SUMMARY_CONTEXT_BOUNDS } } };
    },

    saveGeminiSettings(raw) {
      const current = readiness();
      if (!current.ready) throw new SettingsError(current.reason);
      const values = validateGeminiFeatureSettings(raw);
      const config = renderGeminiConfig(values);
      // The regenerated file must read back as the same managed Gemini config.
      if (JSON.stringify(parseManagedGeminiConfig(config)) !== JSON.stringify(values)) {
        throw new SettingsError("The settings could not be saved.");
      }
      try {
        atomicWriteFile(fs, configPath, config);
      } catch (_) {
        throw new SettingsError("The settings could not be saved.");
      }
      onSaved();
      return { ok: true, values };
    },

    rerunSetup() {
      onRerunSetup();
      return { ok: true };
    },
  };
}

async function guard(operation) {
  try {
    const result = await operation();
    return result === undefined ? { ok: true } : result;
  } catch (error) {
    return { error: error instanceof SettingsError ? error.message : "Settings could not complete this step." };
  }
}

function registerSettingsHandlers(ipcMain, getController, isTrustedSender) {
  const handle = (channel, run) =>
    ipcMain.handle(channel, (event, ...args) =>
      guard(async () => {
        if (!isTrustedSender(event)) throw new SettingsError("This request did not come from the settings window.");
        return run(getController(), ...args);
      }),
    );
  handle(CHANNELS.getGeminiSettings, (controller) => controller.getGeminiSettings());
  handle(CHANNELS.saveGeminiSettings, (controller, settings) => controller.saveGeminiSettings(settings));
  handle(CHANNELS.rerunSetup, (controller) => controller.rerunSetup());
}

let settingsWindow = null;
let settingsController = null;
let handlersRegistered = false;
const SETTINGS_PAGE = path.join(__dirname, "renderer", "settings.html");

function isSettingsSender(event) {
  if (!settingsWindow || settingsWindow.isDestroyed()) return false;
  if (!event || event.sender !== settingsWindow.webContents) return false;
  const frame = event.senderFrame;
  return Boolean(frame) && frame.url === pathToFileURL(SETTINGS_PAGE).href;
}

function createSettingsWindow(electron, context) {
  const { app, BrowserWindow, ipcMain } = electron;
  settingsController = createSettingsController({
    ...context,
    onRerunSetup: () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
      if (context.onRerunSetup) context.onRerunSetup();
    },
  });
  if (!handlersRegistered) {
    handlersRegistered = true;
    registerSettingsHandlers(ipcMain, () => settingsController, isSettingsSender);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  if (app.dock) app.dock.show();
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    show: false,
    title: "Meeting Wiki Settings",
    backgroundColor: "#f4f1ea",
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
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
  settingsWindow.webContents.on("will-navigate", denyNavigation);
  settingsWindow.webContents.on("will-attach-webview", denyNavigation);
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWindow.once("ready-to-show", () => settingsWindow.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
    const othersOpen = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible());
    if (app.dock && !othersOpen) app.dock.hide();
  });
  settingsWindow.loadFile(SETTINGS_PAGE);
  return settingsWindow;
}

module.exports = {
  CHANNELS,
  LANGUAGE_PATTERN,
  LIVE_DEFAULTS,
  NOT_GEMINI,
  NOT_MANAGED,
  SUMMARY_CONTEXT_BOUNDS,
  SettingsError,
  createSettingsController,
  createSettingsWindow,
  guard,
  parseManagedGeminiConfig,
  registerSettingsHandlers,
  validateGeminiFeatureSettings,
};
