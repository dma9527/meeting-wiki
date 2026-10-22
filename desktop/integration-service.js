"use strict";

// Settings-facing service for the auto-record integrations: readiness, opt-in saves (with Meet
// pairing and unpairing), and revealing the bundled extension folder. Main wires the watchers.

const { MeetPairingError } = require("./meet-bridge");
const { RecordingSettingsError } = require("./recording-settings");
const { readAutoRecordPrivacy, readIntegrationSettings, saveIntegrationSettings, validateIntegrationSettings } = require("./integration-settings");
const { zoomReadiness } = require("./zoom-detector");

class IntegrationError extends Error {}

function createIntegrationService({
  fs,
  dataDir,
  atomicWriteFile,
  meetBridge,
  extensionDir,
  mediaAccess = () => "unknown",
  zoomStatus = () => "off",
  meetStatus = () => ({ state: "off", lastSeenAt: null }),
  existsSync = fs.existsSync,
  revealPath = () => {},
  onChanged = () => {},
}) {
  function readiness() {
    const meet = meetStatus();
    return {
      // Electron cannot read the Core Audio tap permission used for system audio.
      permissions: { microphone: mediaAccess("microphone"), systemAudio: "not_checkable" },
      zoom: { ...zoomReadiness({ existsSync }), detector: zoomStatus() },
      googleMeet: {
        ...meetBridge.readiness(),
        extensionBundled: existsSync(extensionDir),
        detector: meet.state,
        extensionLastSeenAt: meet.lastSeenAt,
      },
    };
  }

  function readValues() {
    const privacy = readAutoRecordPrivacy(fs, dataDir);
    return {
      ...readIntegrationSettings(fs, dataDir),
      autoRecordPrivacy: privacy.mode,
      autoRecordPrivacyChoiceNeeded: privacy.choiceNeeded,
    };
  }

  function save(raw) {
    let values;
    try {
      values = validateIntegrationSettings(raw, { requirePrivacy: true });
    } catch (error) {
      throw error instanceof RecordingSettingsError ? new IntegrationError(error.message) : error;
    }
    const before = readIntegrationSettings(fs, dataDir);
    const newlyPaired = values.googleMeetAutoRecord && !before.googleMeetAutoRecord;
    try {
      if (values.googleMeetAutoRecord) meetBridge.pair();
    } catch (error) {
      throw new IntegrationError(error instanceof MeetPairingError ? error.message : "Google Meet could not be connected.");
    }
    try {
      saveIntegrationSettings(fs, dataDir, values, atomicWriteFile);
    } catch (error) {
      if (newlyPaired) meetBridge.unpair();
      throw new IntegrationError(error instanceof RecordingSettingsError ? error.message : "The integration settings could not be saved.");
    }
    if (!values.googleMeetAutoRecord) meetBridge.unpair();
    const current = readValues();
    onChanged(readIntegrationSettings(fs, dataDir));
    return current;
  }

  function showExtensionFolder() {
    if (!existsSync(extensionDir)) throw new IntegrationError("The Google Meet extension is missing from this build.");
    revealPath(extensionDir);
  }

  return { readValues, readiness, save, showExtensionFolder };
}

module.exports = { IntegrationError, createIntegrationService };
