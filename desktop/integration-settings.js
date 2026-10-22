"use strict";

// Auto-record opt-ins, stored in desktop-settings.json beside the recording limit. Both default to
// off; only an explicit true turns an integration on.

const { RecordingSettingsError, readSettingsDocument, settingsPath } = require("./recording-settings");

const INTEGRATION_KEYS = Object.freeze({ zoomAutoRecord: "zoom", googleMeetAutoRecord: "google_meet" });
// Where automatic recordings go. calendar = shared only when a calendar event matches.
const AUTO_RECORD_PRIVACY = Object.freeze(["private", "calendar", "shared"]);
const PRIVACY_KEY = "auto_record_privacy";
// Builds before this setting always recorded automatic meetings as shared.
const LEGACY_PRIVACY = "shared";
const PRIVACY_ERROR = "Choose private, calendar, or shared for automatic recordings.";

function readIntegrationSettings(fs, dataDir) {
  const { document } = readSettingsDocument(fs, dataDir);
  const section = document && document.integrations && typeof document.integrations === "object" ? document.integrations : {};
  const values = {};
  for (const [field, key] of Object.entries(INTEGRATION_KEYS)) {
    const entry = section[key];
    values[field] = Boolean(entry && typeof entry === "object" && entry.auto_record === true);
  }
  return values;
}

// New installs default to private. An install that already auto-records keeps the documented
// shared behavior and is asked to choose; a stored choice is never changed on its own.
function readAutoRecordPrivacy(fs, dataDir) {
  const { document } = readSettingsDocument(fs, dataDir);
  const section = document && document.integrations && typeof document.integrations === "object" ? document.integrations : {};
  if (AUTO_RECORD_PRIVACY.includes(section[PRIVACY_KEY])) return { mode: section[PRIVACY_KEY], choiceNeeded: false };
  const enabled = Object.values(readIntegrationSettings(fs, dataDir)).some(Boolean);
  return enabled ? { mode: LEGACY_PRIVACY, choiceNeeded: true } : { mode: "private", choiceNeeded: false };
}

// Unknown modes fail closed to private.
function autoRecordStartOptions(mode) {
  if (mode === "shared") return { isPrivate: false, requireCalendarMatch: false };
  if (mode === "calendar") return { isPrivate: false, requireCalendarMatch: true };
  return { isPrivate: true, requireCalendarMatch: false };
}

function validateIntegrationSettings(raw, { requirePrivacy = false } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const values = {};
  for (const field of Object.keys(INTEGRATION_KEYS)) {
    if (typeof source[field] !== "boolean") throw new RecordingSettingsError("Choose on or off for each integration.");
    values[field] = source[field];
  }
  if (source.autoRecordPrivacy !== undefined || requirePrivacy) {
    if (!AUTO_RECORD_PRIVACY.includes(source.autoRecordPrivacy)) throw new RecordingSettingsError(PRIVACY_ERROR);
    values.autoRecordPrivacy = source.autoRecordPrivacy;
  }
  return values;
}

// Read-modify-write that keeps every other key, including other keys inside each integration.
function saveIntegrationSettings(fs, dataDir, raw, atomicWriteFile) {
  const values = validateIntegrationSettings(raw);
  const { document } = readSettingsDocument(fs, dataDir);
  if (!document) throw new RecordingSettingsError("The recording settings file could not be read, so it was left unchanged.");
  const current = document.integrations && typeof document.integrations === "object" && !Array.isArray(document.integrations)
    ? document.integrations
    : {};
  const integrations = { ...current };
  for (const [field, key] of Object.entries(INTEGRATION_KEYS)) {
    const entry = current[key] && typeof current[key] === "object" && !Array.isArray(current[key]) ? current[key] : {};
    integrations[key] = { ...entry, auto_record: values[field] };
  }
  if (values.autoRecordPrivacy) integrations[PRIVACY_KEY] = values.autoRecordPrivacy;
  try {
    atomicWriteFile(fs, settingsPath(dataDir), `${JSON.stringify({ ...document, integrations }, null, 2)}\n`);
  } catch (_) {
    throw new RecordingSettingsError("The integration settings could not be saved.");
  }
  return values;
}

module.exports = {
  AUTO_RECORD_PRIVACY,
  INTEGRATION_KEYS,
  autoRecordStartOptions,
  readAutoRecordPrivacy,
  readIntegrationSettings,
  saveIntegrationSettings,
  validateIntegrationSettings,
};
