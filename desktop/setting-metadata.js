"use strict";

// Single source of "when does this take effect" copy for Settings, setup, and the tray.
// Codes reflect where each value is read: the worker loads config at start (restarted on
// save), each live session reads config when a recording starts, and the recording limit
// is read when a recording starts.

const APPLIES = Object.freeze({
  immediate: "Applies immediately to this Settings window and the next window you open.",
  processing:
    "Applies to meetings processed from now on, including any still waiting in the queue. Processing restarts automatically. Meetings already in the wiki keep their notes.",
  liveSession: "Applies from the next recording's live captions. A live view that is already open keeps its current setting.",
  processingAndLive:
    "Applies to meetings processed from now on and to the next recording's live captions. Processing restarts automatically.",
  nextRecording: "Applies to the next recording you start. A recording in progress keeps its current limit.",
  integration:
    "Applies right away. Turning it off stops watching for meetings but does not stop a recording already in progress.",
  autoRecordPrivacy:
    "Applies to the next automatic recording. A recording already in progress keeps the privacy it started with.",
  setupFinish: "Applies when you finish setup after a passing check. Until then your current provider keeps working.",
  manualEdit:
    "Settings never change a hand-edited configuration. Your own edits apply to live captions from the next recording and to processing after you quit and reopen Meeting Wiki.",
});

const SETTINGS = Object.freeze({
  primaryProfileName: Object.freeze({ form: "identity", applies: "processing" }),
  aliases: Object.freeze({ form: "identity", applies: "processing" }),
  transcriptLanguage: Object.freeze({ form: "languages", applies: "processingAndLive" }),
  liveTranslationLanguage: Object.freeze({ form: "languages", applies: "liveSession" }),
  liveSummaryLanguage: Object.freeze({ form: "languages", applies: "liveSession" }),
  memoryLanguage: Object.freeze({ form: "languages", applies: "processing" }),
  uiLanguage: Object.freeze({ form: "languages", applies: "immediate" }),
  batchAudioModel: Object.freeze({ form: "gemini", applies: "processing" }),
  liveModel: Object.freeze({ form: "gemini", applies: "liveSession" }),
  languageModel: Object.freeze({ form: "gemini", applies: "processingAndLive" }),
  summaryContextCharacters: Object.freeze({ form: "gemini", applies: "liveSession" }),
  defaultPrivacyMode: Object.freeze({ form: "recording", applies: "nextRecording" }),
  recordingLiveEnabled: Object.freeze({ form: "recording", applies: "nextRecording" }),
  maxDurationMinutes: Object.freeze({ form: "recording", applies: "nextRecording" }),
  zoomAutoRecord: Object.freeze({ form: "integrations", applies: "integration" }),
  googleMeetAutoRecord: Object.freeze({ form: "integrations", applies: "integration" }),
  autoRecordPrivacy: Object.freeze({ form: "integrations", applies: "autoRecordPrivacy" }),
  provider: Object.freeze({ form: "setup", applies: "setupFinish" }),
  apiKey: Object.freeze({ form: "setup", applies: "setupFinish" }),
});

function appliesCopy(key) {
  const entry = SETTINGS[key];
  return entry ? APPLIES[entry.applies] : "";
}

// Plain data for the sandboxed renderers, which cannot require this module.
function settingMetadata() {
  const settings = {};
  for (const [key, entry] of Object.entries(SETTINGS)) {
    settings[key] = { form: entry.form, appliesAfter: entry.applies, copy: APPLIES[entry.applies] };
  }
  return { settings, manualEdit: APPLIES.manualEdit };
}

module.exports = { APPLIES, SETTINGS, appliesCopy, settingMetadata };
