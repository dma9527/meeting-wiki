"use strict";

// Desktop-only recording settings. The Python worker never reads them, so saving here must
// not restart processing. Saves rewrite the file atomically and keep every other key.

const path = require("path");

const RECORDING_SETTINGS_FILE = "desktop-settings.json";
const MAX_DURATION_BOUNDS = Object.freeze({ min: 15, max: 480 });
const DEFAULT_MAX_DURATION_MINUTES = 120;
const RECORDING_DEFAULTS_VERSION = 1;
const DEFAULT_RECORDING_DEFAULTS = Object.freeze({ privacyMode: "shared", liveEnabled: true });
const RECORDING_PRIVACY_MODES = new Set(["private", "shared"]);

class RecordingSettingsError extends Error {}

function settingsPath(dataDir) {
  return path.join(dataDir, RECORDING_SETTINGS_FILE);
}

function inBounds(value) {
  return Number.isInteger(value) && value >= MAX_DURATION_BOUNDS.min && value <= MAX_DURATION_BOUNDS.max;
}

// Returns { exists, document } where document is the parsed object, or null when unreadable.
function readDocument(fs, dataDir) {
  let text;
  try {
    text = fs.readFileSync(settingsPath(dataDir), "utf8");
  } catch (error) {
    return { exists: !(error && error.code === "ENOENT"), document: error && error.code === "ENOENT" ? {} : null };
  }
  try {
    const parsed = JSON.parse(text);
    const isObject = parsed && typeof parsed === "object" && !Array.isArray(parsed);
    return { exists: true, document: isObject ? parsed : null };
  } catch (_) {
    return { exists: true, document: null };
  }
}

// Never throws: a missing, unreadable, or out-of-range value falls back to the default.
function readMaxDurationMinutes(fs, dataDir) {
  const { document } = readDocument(fs, dataDir);
  const recording = document && document.recording;
  const value = recording && typeof recording === "object" ? recording.max_duration_minutes : undefined;
  return inBounds(value) ? value : DEFAULT_MAX_DURATION_MINUTES;
}

function readRecordingDefaults(fs, dataDir) {
  const { exists, document } = readDocument(fs, dataDir);
  const hasRecording = Boolean(document && Object.prototype.hasOwnProperty.call(document, "recording"));
  const recording = document && document.recording;
  const recordingValid = !hasRecording || (recording && typeof recording === "object" && !Array.isArray(recording));
  const hasDefaults = Boolean(recordingValid && recording && Object.prototype.hasOwnProperty.call(recording, "defaults"));
  const defaults = hasDefaults ? recording.defaults : null;
  const valid = defaults
    && typeof defaults === "object"
    && !Array.isArray(defaults)
    && defaults.version === RECORDING_DEFAULTS_VERSION
    && RECORDING_PRIVACY_MODES.has(defaults.privacy_mode)
    && typeof defaults.live_enabled === "boolean";
  const malformed = exists && (!document || !recordingValid || (hasDefaults && !valid));
  return {
    configured: Boolean(valid),
    values: valid
      ? { privacyMode: defaults.privacy_mode, liveEnabled: defaults.live_enabled }
      : { ...DEFAULT_RECORDING_DEFAULTS, liveEnabled: malformed ? false : DEFAULT_RECORDING_DEFAULTS.liveEnabled },
  };
}

function decideManualStart({ blockers, defaults }) {
  if (Array.isArray(blockers) && blockers.length > 0) {
    return { action: "options", formMode: "override" };
  }
  if (!defaults || defaults.configured !== true) {
    return { action: "options", formMode: "initial" };
  }
  return {
    action: "start",
    options: {
      isPrivate: defaults.values.privacyMode === "private",
      liveEnabled: defaults.values.liveEnabled === true,
    },
  };
}

function validateRecordingDefaults(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (!RECORDING_PRIVACY_MODES.has(source.privacyMode)) {
    throw new RecordingSettingsError("Choose private or shared as the recording default.");
  }
  if (typeof source.liveEnabled !== "boolean") {
    throw new RecordingSettingsError("Choose whether live captions, translation, and summary start automatically.");
  }
  return { privacyMode: source.privacyMode, liveEnabled: source.liveEnabled };
}

function saveRecordingDefaults(fs, dataDir, raw, atomicWriteFile) {
  const values = validateRecordingDefaults(raw);
  const { document } = readDocument(fs, dataDir);
  if (!document) {
    throw new RecordingSettingsError("The recording settings file could not be read, so it was left unchanged.");
  }
  const recording = document.recording && typeof document.recording === "object" && !Array.isArray(document.recording)
    ? document.recording
    : {};
  const defaults = {
    version: RECORDING_DEFAULTS_VERSION,
    privacy_mode: values.privacyMode,
    live_enabled: values.liveEnabled,
  };
  const next = { ...document, recording: { ...recording, defaults } };
  try {
    atomicWriteFile(fs, settingsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  } catch (_) {
    throw new RecordingSettingsError("The recording settings could not be saved.");
  }
  return values;
}

function saveRecordingPreferences(fs, dataDir, raw, atomicWriteFile) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const maxDurationMinutes = validateMaxDurationMinutes(source.maxDurationMinutes);
  const defaultsValues = validateRecordingDefaults(source);
  const { document } = readDocument(fs, dataDir);
  if (!document) {
    throw new RecordingSettingsError("The recording settings file could not be read, so it was left unchanged.");
  }
  const recording = document.recording && typeof document.recording === "object" && !Array.isArray(document.recording)
    ? document.recording
    : {};
  const defaults = {
    version: RECORDING_DEFAULTS_VERSION,
    privacy_mode: defaultsValues.privacyMode,
    live_enabled: defaultsValues.liveEnabled,
  };
  const next = {
    ...document,
    recording: { ...recording, max_duration_minutes: maxDurationMinutes, defaults },
  };
  try {
    atomicWriteFile(fs, settingsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  } catch (_) {
    throw new RecordingSettingsError("The recording settings could not be saved.");
  }
  return { maxDurationMinutes, ...defaultsValues };
}

function validateMaxDurationMinutes(raw) {
  const { min, max } = MAX_DURATION_BOUNDS;
  const value = typeof raw === "number" ? raw : /^\s*\d{1,4}\s*$/.test(String(raw ?? "")) ? Number(raw) : NaN;
  if (!inBounds(value)) {
    throw new RecordingSettingsError(`Enter a whole number of minutes from ${min} to ${max}.`);
  }
  return value;
}

// Read-modify-write that keeps unknown top-level keys and other recording keys.
function saveMaxDurationMinutes(fs, dataDir, raw, atomicWriteFile) {
  const minutes = validateMaxDurationMinutes(raw);
  const { document } = readDocument(fs, dataDir);
  if (!document) {
    throw new RecordingSettingsError("The recording settings file could not be read, so it was left unchanged.");
  }
  const recording = document.recording && typeof document.recording === "object" && !Array.isArray(document.recording)
    ? document.recording
    : {};
  const next = { ...document, recording: { ...recording, max_duration_minutes: minutes } };
  try {
    atomicWriteFile(fs, settingsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  } catch (_) {
    throw new RecordingSettingsError("The recording settings could not be saved.");
  }
  return minutes;
}

module.exports = {
  DEFAULT_MAX_DURATION_MINUTES,
  DEFAULT_RECORDING_DEFAULTS,
  MAX_DURATION_BOUNDS,
  RECORDING_DEFAULTS_VERSION,
  RECORDING_SETTINGS_FILE,
  RecordingSettingsError,
  decideManualStart,
  readMaxDurationMinutes,
  readRecordingDefaults,
  readSettingsDocument: readDocument,
  saveMaxDurationMinutes,
  saveRecordingDefaults,
  saveRecordingPreferences,
  settingsPath,
  validateMaxDurationMinutes,
  validateRecordingDefaults,
};
