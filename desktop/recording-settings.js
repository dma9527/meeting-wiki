"use strict";

// Desktop-only recording settings. The Python worker never reads them, so saving here must
// not restart processing. Saves rewrite the file atomically and keep every other key.

const path = require("path");

const RECORDING_SETTINGS_FILE = "desktop-settings.json";
const MAX_DURATION_BOUNDS = Object.freeze({ min: 15, max: 480 });
const DEFAULT_MAX_DURATION_MINUTES = 120;

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
  MAX_DURATION_BOUNDS,
  RECORDING_SETTINGS_FILE,
  RecordingSettingsError,
  readMaxDurationMinutes,
  readSettingsDocument: readDocument,
  saveMaxDurationMinutes,
  settingsPath,
  validateMaxDurationMinutes,
};
