"use strict";

// Settings bridge. Exposes only the named Gemini settings actions. Channel names must
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

contextBridge.exposeInMainWorld("meetingWikiSettings", {
  getGeminiSettings: () => ipcRenderer.invoke("settings:getGeminiSettings"),
  saveGeminiSettings: (settings) =>
    ipcRenderer.invoke("settings:saveGeminiSettings", pickGeminiFeatureSettings(settings)),
  rerunSetup: () => ipcRenderer.invoke("settings:rerunSetup"),
});
