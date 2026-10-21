"use strict";

// Auto-record opt-ins, stored in desktop-settings.json beside the recording limit. Both default to
// off; only an explicit true turns an integration on.

const { RecordingSettingsError, readSettingsDocument, settingsPath } = require("./recording-settings");

const INTEGRATION_KEYS = Object.freeze({ zoomAutoRecord: "zoom", googleMeetAutoRecord: "google_meet" });

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

function validateIntegrationSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const values = {};
  for (const field of Object.keys(INTEGRATION_KEYS)) {
    if (typeof source[field] !== "boolean") throw new RecordingSettingsError("Choose on or off for each integration.");
    values[field] = source[field];
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
  try {
    atomicWriteFile(fs, settingsPath(dataDir), `${JSON.stringify({ ...document, integrations }, null, 2)}\n`);
  } catch (_) {
    throw new RecordingSettingsError("The integration settings could not be saved.");
  }
  return values;
}

module.exports = { INTEGRATION_KEYS, readIntegrationSettings, saveIntegrationSettings, validateIntegrationSettings };
