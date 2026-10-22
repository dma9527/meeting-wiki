"use strict";

// Settings bridge. Exposes only the named identity, Gemini, recording, integration, and metadata actions. Channel names must
// match CHANNELS in settings-window.js (sandboxed preloads cannot require local modules).

const { contextBridge, ipcRenderer } = require("electron");

function pickGeminiFeatureSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const text = (value) => (typeof value === "string" ? value : "");
  const characters = source.summaryContextCharacters;
  return {
    batchAudioModel: text(source.batchAudioModel),
    liveModel: text(source.liveModel),
    languageModel: text(source.languageModel),
    translationTargetLanguage: text(source.translationTargetLanguage),
    summaryContextCharacters: typeof characters === "number" || typeof characters === "string" ? characters : "",
  };
}

// Main validates the limits; this only bounds the payload and drops non-string values.
const MAX_FORWARDED_ALIASES = 64;

function pickIdentitySettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const aliases = Array.isArray(source.aliases) ? source.aliases.slice(0, MAX_FORWARDED_ALIASES) : [];
  return {
    primaryProfileName: typeof source.primaryProfileName === "string" ? source.primaryProfileName : "",
    aliases: aliases.filter((alias) => typeof alias === "string"),
  };
}

function pickRecordingSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const minutes = source.maxDurationMinutes;
  return { maxDurationMinutes: typeof minutes === "number" || typeof minutes === "string" ? minutes : "" };
}

const AUTO_RECORD_PRIVACY = new Set(["private", "calendar", "shared"]);

function pickIntegrationSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    zoomAutoRecord: source.zoomAutoRecord === true,
    googleMeetAutoRecord: source.googleMeetAutoRecord === true,
    // An unknown value is forwarded as "" so main rejects it instead of guessing.
    autoRecordPrivacy: AUTO_RECORD_PRIVACY.has(source.autoRecordPrivacy) ? source.autoRecordPrivacy : "",
  };
}

contextBridge.exposeInMainWorld("meetingWikiSettings", {
  getIntegrationSettings: () => ipcRenderer.invoke("settings:getIntegrationSettings"),
  saveIntegrationSettings: (settings) =>
    ipcRenderer.invoke("settings:saveIntegrationSettings", pickIntegrationSettings(settings)),
  showMeetExtension: () => ipcRenderer.invoke("settings:showMeetExtension"),
  getIdentitySettings: () => ipcRenderer.invoke("settings:getIdentitySettings"),
  saveIdentitySettings: (settings) =>
    ipcRenderer.invoke("settings:saveIdentitySettings", pickIdentitySettings(settings)),
  getGeminiSettings: () => ipcRenderer.invoke("settings:getGeminiSettings"),
  saveGeminiSettings: (settings) =>
    ipcRenderer.invoke("settings:saveGeminiSettings", pickGeminiFeatureSettings(settings)),
  getRecordingSettings: () => ipcRenderer.invoke("settings:getRecordingSettings"),
  saveRecordingSettings: (settings) =>
    ipcRenderer.invoke("settings:saveRecordingSettings", pickRecordingSettings(settings)),
  rerunSetup: () => ipcRenderer.invoke("settings:rerunSetup"),
  getSettingMetadata: () => ipcRenderer.invoke("settings:getSettingMetadata"),
});
