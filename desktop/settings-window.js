"use strict";

// Settings window. Same lockdown as setup-window.js. It edits the [identity] section and
// the five Gemini feature values in a setup-managed config, plus desktop-only recording
// defaults, duration, and auto-record opt-ins in desktop-settings.json. It never touches the secret store.

const path = require("path");
const { pathToFileURL } = require("url");

const {
  GEMINI_API_KEY_ENV,
  GEMINI_MODELS,
  GEMINI_PROVIDER,
  MODEL_PATTERN,
  atomicWriteFile,
  readSetupState,
  renderGeminiConfig,
} = require("./setup-window");
const {
  DEFAULT_LANGUAGE_SETTINGS,
  IDENTITY_LIMITS,
  IdentityError,
  LANGUAGE_VALUES,
  identityFromTables,
  languageFromTables,
  parseManagedConfig,
  replaceIdentitySection,
  replaceLanguageSection,
  unsupportedLanguageFields,
  validateIdentity,
} = require("./managed-config");
const {
  MAX_DURATION_BOUNDS,
  RecordingSettingsError,
  readMaxDurationMinutes,
  readRecordingDefaults,
  saveRecordingPreferences,
  validateMaxDurationMinutes,
  validateRecordingDefaults,
} = require("./recording-settings");
const { settingMetadata } = require("./setting-metadata");
const { IntegrationError } = require("./integration-service");

const CHANNELS = Object.freeze({
  getIdentitySettings: "settings:getIdentitySettings",
  saveIdentitySettings: "settings:saveIdentitySettings",
  getLanguageSettings: "settings:getLanguageSettings",
  saveLanguageSettings: "settings:saveLanguageSettings",
  getGeminiSettings: "settings:getGeminiSettings",
  saveGeminiSettings: "settings:saveGeminiSettings",
  getRecordingSettings: "settings:getRecordingSettings",
  saveRecordingSettings: "settings:saveRecordingSettings",
  getIntegrationSettings: "settings:getIntegrationSettings",
  saveIntegrationSettings: "settings:saveIntegrationSettings",
  showMeetExtension: "settings:showMeetExtension",
  rerunSetup: "settings:rerunSetup",
  getSettingMetadata: "settings:getSettingMetadata",
});

// Mirrors LiveConfig in meeting_wiki/config.py; a test keeps the two in sync.
const SUMMARY_CONTEXT_BOUNDS = Object.freeze({ min: 500, max: 100000 });
const LIVE_DEFAULTS = Object.freeze({ summaryContextCharacters: 12000 });

const NOT_GEMINI = "These settings cover Gemini only. Run setup again to configure another provider.";
const NOT_MANAGED =
  "Your configuration was not created by setup or was edited by hand. Run setup again to manage it here.";
const NOT_ONLINE = "Finish setup first. Your name and aliases can be edited here once setup is complete.";
const NOT_ONLINE_RECORDING = "Finish setup first. The recording length limit can be changed here once setup is complete.";
const NOT_ONLINE_INTEGRATIONS = "Finish setup first. Automatic recording can be turned on here once setup is complete.";
const NO_INTEGRATIONS = "Automatic recording is not available in this build.";
const SAVE_FAILED = "The settings could not be saved.";

// Tables a Gemini config may contain. Anything else counts as a manual edit.
const GEMINI_TABLES = new Set(["", "identity", "languages", "providers", "live", "gemini"]);

class SettingsError extends Error {}

// Reads the Gemini feature values from a setup-managed Gemini config, or returns null.
function parseManagedGeminiConfig(text) {
  const tables = parseManagedConfig(text);
  if (!tables || !Object.keys(tables).every((name) => GEMINI_TABLES.has(name))) return null;
  const { providers = {}, live = {}, gemini = {} } = tables;
  const capabilities = ["transcription", "llm", "live_transcription", "live_language"];
  const allGemini = capabilities.every((key) => providers[key] === GEMINI_PROVIDER);
  if (!allGemini || live.allow_external_providers !== true || gemini.api_key_env !== GEMINI_API_KEY_ENV) return null;
  return {
    batchAudioModel: gemini.batch_audio_model ?? GEMINI_MODELS.batchAudioModel,
    liveModel: gemini.live_model ?? GEMINI_MODELS.liveModel,
    languageModel: gemini.language_model ?? GEMINI_MODELS.languageModel,
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

function validateLanguageSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const values = {};
  for (const [field, allowed] of Object.entries(LANGUAGE_VALUES)) {
    if (!allowed.includes(source[field])) {
      throw new SettingsError("Choose one of the available language options.");
    }
    values[field] = source[field];
  }
  return values;
}

function readText(fs, filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return null;
  }
}

// Everything but the identity keys, for checking that an identity save changed nothing else.
function withoutIdentity(tables) {
  const { identity: _identity, "": topLevel, ...rest } = tables;
  const { user_name: _userName, ...otherTopLevel } = topLevel;
  return JSON.stringify({ topLevel: otherTopLevel, ...rest });
}

function withoutLanguages(tables) {
  const { languages: _languages, "": topLevel = {}, live = {}, ...rest } = tables;
  const { language: _legacyLanguage, ...topLevelRest } = topLevel;
  const { translation_target_language: _legacyTranslation, ...liveRest } = live;
  return JSON.stringify({ "": topLevelRest, ...rest, live: liveRest });
}

function createSettingsController({ fs, dataDir, configPath, onSaved = () => {}, onRerunSetup = () => {}, integrations = null }) {
  // Re-read on every call so a save never trusts state rendered earlier.
  function identityReadiness() {
    const state = readSetupState(fs, dataDir);
    if (!state || state.mode !== "online") return { ready: false, reason: NOT_ONLINE };
    const text = readText(fs, configPath);
    const tables = parseManagedConfig(text);
    if (!tables) return { ready: false, reason: NOT_MANAGED, manualConfig: true };
    return { ready: true, text, tables, identity: identityFromTables(tables) };
  }

  function languageReadiness() {
    const text = readText(fs, configPath);
    const tables = parseManagedConfig(text);
    if (!tables) return { ready: false, reason: NOT_MANAGED, manualConfig: true };
    return { ready: true, text, tables, values: languageFromTables(tables) };
  }

  function readiness() {
    const state = readSetupState(fs, dataDir);
    if (!state || state.mode !== "online" || state.provider !== GEMINI_PROVIDER) return { ready: false, reason: NOT_GEMINI };
    const text = readText(fs, configPath);
    const tables = parseManagedConfig(text);
    const values = parseManagedGeminiConfig(text);
    if (!values || !tables) return { ready: false, reason: NOT_MANAGED, manualConfig: true };
    return { ready: true, values, identity: identityFromTables(tables), tables };
  }

  function recordingReady() {
    const state = readSetupState(fs, dataDir);
    return Boolean(state && state.mode === "online");
  }

  function write(config) {
    try {
      atomicWriteFile(fs, configPath, config);
    } catch (_) {
      throw new SettingsError(SAVE_FAILED);
    }
    onSaved();
  }

  return {
    getIdentitySettings() {
      const current = identityReadiness();
      if (!current.ready) return current;
      const { primaryProfileName, aliases, legacyUserName } = current.identity;
      return {
        ready: true,
        values: { primaryProfileName, aliases },
        legacyUserName,
        limits: { ...IDENTITY_LIMITS },
      };
    },

    saveIdentitySettings(raw) {
      const current = identityReadiness();
      if (!current.ready) throw new SettingsError(current.reason);
      let values;
      try {
        values = validateIdentity(raw);
      } catch (error) {
        throw error instanceof IdentityError ? new SettingsError(error.message) : error;
      }
      // user_name stays for older readers; primary_profile_name now takes precedence.
      const identity = { ...values, legacyUserName: current.identity.legacyUserName };
      const config = replaceIdentitySection(current.text, identity);
      const readBack = parseManagedConfig(config);
      if (
        !readBack ||
        withoutIdentity(readBack) !== withoutIdentity(current.tables) ||
        JSON.stringify(identityFromTables(readBack)) !== JSON.stringify(identity)
      ) {
        throw new SettingsError(SAVE_FAILED);
      }
      write(config);
      return { ok: true, values };
    },

    getLanguageSettings() {
      const current = languageReadiness();
      if (!current.ready) return current;
      return {
        ready: true,
        values: current.values,
        unsupportedFields: unsupportedLanguageFields(current.tables),
        choices: Object.fromEntries(
          Object.entries(LANGUAGE_VALUES).map(([field, values]) => [field, [...values]]),
        ),
      };
    },

    saveLanguageSettings(raw) {
      const current = languageReadiness();
      if (!current.ready) throw new SettingsError(current.reason);
      const values = validateLanguageSettings(raw);
      const config = replaceLanguageSection(current.text, values);
      const readBack = parseManagedConfig(config);
      if (
        !readBack
        || withoutLanguages(readBack) !== withoutLanguages(current.tables)
        || JSON.stringify(languageFromTables(readBack)) !== JSON.stringify(values)
      ) {
        throw new SettingsError(SAVE_FAILED);
      }
      write(config);
      return { ok: true, values };
    },

    getGeminiSettings() {
      const current = readiness();
      if (!current.ready) return current;
      return { ready: true, values: current.values, bounds: { summaryContextCharacters: { ...SUMMARY_CONTEXT_BOUNDS } } };
    },

    saveGeminiSettings(raw) {
      const current = readiness();
      if (!current.ready) throw new SettingsError(current.reason);
      if (unsupportedLanguageFields(current.tables).length > 0) {
        throw new SettingsError("Open Languages and choose supported values before saving Gemini settings.");
      }
      const values = validateGeminiFeatureSettings(raw);
      const config = renderGeminiConfig(
        values,
        current.identity,
        languageFromTables(current.tables),
      );
      // The regenerated file must read back as the same Gemini values and identity.
      if (
        JSON.stringify(parseManagedGeminiConfig(config)) !== JSON.stringify(values) ||
        JSON.stringify(identityFromTables(parseManagedConfig(config))) !== JSON.stringify(current.identity)
      ) {
        throw new SettingsError(SAVE_FAILED);
      }
      write(config);
      return { ok: true, values };
    },

    getRecordingSettings() {
      if (!recordingReady()) return { ready: false, reason: NOT_ONLINE_RECORDING };
      const defaults = readRecordingDefaults(fs, dataDir);
      return {
        ready: true,
        values: {
          maxDurationMinutes: readMaxDurationMinutes(fs, dataDir),
          defaultsConfigured: defaults.configured,
          defaultPrivacyMode: defaults.values.privacyMode,
          liveEnabled: defaults.values.liveEnabled,
        },
        bounds: { maxDurationMinutes: { ...MAX_DURATION_BOUNDS } },
      };
    },

    // Desktop-only: the worker never reads this file, so processing is not restarted.
    saveRecordingSettings(raw) {
      if (!recordingReady()) throw new SettingsError(NOT_ONLINE_RECORDING);
      const source = raw && typeof raw === "object" ? raw : {};
      try {
        const maxDurationMinutes = validateMaxDurationMinutes(source.maxDurationMinutes);
        const defaults = validateRecordingDefaults({
          privacyMode: source.defaultPrivacyMode,
          liveEnabled: source.liveEnabled,
        });
        const current = readRecordingDefaults(fs, dataDir);
        const expectedMatches = typeof source.expectedDefaultsConfigured === "boolean"
          && source.expectedDefaultsConfigured === current.configured
          && source.expectedDefaultPrivacyMode === current.values.privacyMode
          && source.expectedLiveEnabled === current.values.liveEnabled;
        if (!expectedMatches) {
          throw new RecordingSettingsError("Recording defaults changed. Close and reopen Settings before saving.");
        }
        const values = saveRecordingPreferences(
          fs,
          dataDir,
          {
            maxDurationMinutes,
            privacyMode: defaults.privacyMode,
            liveEnabled: defaults.liveEnabled,
          },
          atomicWriteFile,
        );
        return {
          ok: true,
          values: {
            maxDurationMinutes: values.maxDurationMinutes,
            defaultPrivacyMode: values.privacyMode,
            liveEnabled: values.liveEnabled,
          },
        };
      } catch (error) {
        throw error instanceof RecordingSettingsError ? new SettingsError(error.message) : error;
      }
    },

    getIntegrationSettings() {
      if (!integrations) return { ready: false, reason: NO_INTEGRATIONS };
      if (!recordingReady()) return { ready: false, reason: NOT_ONLINE_INTEGRATIONS };
      return { ready: true, values: integrations.readValues(), readiness: integrations.readiness() };
    },

    // Turning Google Meet on pairs the browser connection; turning it off removes it.
    saveIntegrationSettings(raw) {
      if (!integrations) throw new SettingsError(NO_INTEGRATIONS);
      if (!recordingReady()) throw new SettingsError(NOT_ONLINE_INTEGRATIONS);
      try {
        const values = integrations.save(raw);
        return { ok: true, values, readiness: integrations.readiness() };
      } catch (error) {
        throw error instanceof IntegrationError ? new SettingsError(error.message) : error;
      }
    },

    showMeetExtension() {
      if (!integrations) throw new SettingsError(NO_INTEGRATIONS);
      try {
        integrations.showExtensionFolder();
        return { ok: true };
      } catch (error) {
        throw error instanceof IntegrationError ? new SettingsError(error.message) : error;
      }
    },

    rerunSetup() {
      onRerunSetup();
      return { ok: true };
    },

    getSettingMetadata() {
      return settingMetadata();
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
  handle(CHANNELS.getIdentitySettings, (controller) => controller.getIdentitySettings());
  handle(CHANNELS.saveIdentitySettings, (controller, settings) => controller.saveIdentitySettings(settings));
  handle(CHANNELS.getLanguageSettings, (controller) => controller.getLanguageSettings());
  handle(CHANNELS.saveLanguageSettings, (controller, settings) => controller.saveLanguageSettings(settings));
  handle(CHANNELS.getGeminiSettings, (controller) => controller.getGeminiSettings());
  handle(CHANNELS.saveGeminiSettings, (controller, settings) => controller.saveGeminiSettings(settings));
  handle(CHANNELS.getRecordingSettings, (controller) => controller.getRecordingSettings());
  handle(CHANNELS.saveRecordingSettings, (controller, settings) => controller.saveRecordingSettings(settings));
  handle(CHANNELS.getIntegrationSettings, (controller) => controller.getIntegrationSettings());
  handle(CHANNELS.saveIntegrationSettings, (controller, settings) => controller.saveIntegrationSettings(settings));
  handle(CHANNELS.showMeetExtension, (controller) => controller.showMeetExtension());
  handle(CHANNELS.rerunSetup, (controller) => controller.rerunSetup());
  handle(CHANNELS.getSettingMetadata, (controller) => controller.getSettingMetadata());
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
  LIVE_DEFAULTS,
  NOT_GEMINI,
  NOT_MANAGED,
  NOT_ONLINE,
  NOT_ONLINE_INTEGRATIONS,
  NOT_ONLINE_RECORDING,
  NO_INTEGRATIONS,
  SUMMARY_CONTEXT_BOUNDS,
  SettingsError,
  createSettingsController,
  createSettingsWindow,
  guard,
  parseManagedGeminiConfig,
  registerSettingsHandlers,
  validateGeminiFeatureSettings,
  validateLanguageSettings,
};
