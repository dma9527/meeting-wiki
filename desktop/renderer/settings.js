"use strict";

// Settings renderer. It talks to the main process only through window.meetingWikiSettings
// and writes every dynamic value with textContent or input.value.
//
// Expected bridge (implemented by settings-preload.js):
//   getGeminiSettings()  -> { ready: true, values, bounds } | { ready: false, reason } | { error }
//   saveGeminiSettings(values) -> { ok: true, values } | { error }
//   rerunSetup()         -> { ok: true } | { error }

(function settingsWindow() {
  const bridge = window.meetingWikiSettings;
  const $ = (id) => document.getElementById(id);
  const FIELDS = Object.freeze({
    batchAudioModel: "batch-audio-model",
    liveModel: "live-model",
    languageModel: "language-model",
    translationTargetLanguage: "translation-target-language",
    summaryContextCharacters: "summary-context-characters",
  });
  let busy = false;

  async function call(method, ...args) {
    if (!bridge || typeof bridge[method] !== "function") {
      return { error: "Settings cannot reach the app. Close this window and reopen Meeting Wiki." };
    }
    try {
      const result = await bridge[method](...args);
      return result === undefined ? { ok: true } : result;
    } catch (_) {
      return { error: "The app did not respond. Try again." };
    }
  }

  function errorOf(result) {
    return result && typeof result === "object" && typeof result.error === "string" ? result.error : "";
  }

  function setStatus(message, tone) {
    const node = $("settings-status");
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  function showFieldError(input, message) {
    const node = $(`${input.id}-error`);
    node.textContent = message;
    node.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function showUnsupported(reason) {
    $("settings-loading").hidden = true;
    $("panel-gemini-settings").hidden = true;
    $("unsupported-reason").textContent = reason;
    $("panel-unsupported").hidden = false;
    $("panel-unsupported").focus();
  }

  function fill(values) {
    for (const [key, id] of Object.entries(FIELDS)) {
      const value = values && values[key];
      $(id).value = typeof value === "string" || typeof value === "number" ? String(value) : "";
    }
  }

  function readForm() {
    const values = {};
    for (const [key, id] of Object.entries(FIELDS)) values[key] = $(id).value.trim();
    return values;
  }

  // Mirrors the main-process checks for quick feedback; main stays authoritative.
  function localErrors(values, bounds) {
    const errors = {};
    const model = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
    if (!model.test(values.batchAudioModel)) errors.batchAudioModel = "Enter a valid model name.";
    if (!model.test(values.liveModel)) errors.liveModel = "Enter a valid model name.";
    if (!model.test(values.languageModel)) errors.languageModel = "Enter a valid model name.";
    if (!/^[A-Za-z][A-Za-z0-9 -]{0,39}$/.test(values.translationTargetLanguage)) {
      errors.translationTargetLanguage = "Use a code such as zh or a name such as Japanese.";
    }
    const characters = Number(values.summaryContextCharacters);
    if (!/^\d+$/.test(values.summaryContextCharacters) || characters < bounds.min || characters > bounds.max) {
      errors.summaryContextCharacters = `Enter a whole number from ${bounds.min} to ${bounds.max}.`;
    }
    return errors;
  }

  async function rerunSetup() {
    const result = await call("rerunSetup");
    const error = errorOf(result);
    if (error) setStatus(error, "error");
  }

  async function load() {
    if (!bridge) $("bridge-missing").hidden = false;
    const result = await call("getGeminiSettings");
    const error = errorOf(result);
    if (error) {
      showUnsupported(error);
      return;
    }
    if (!result.ready) {
      showUnsupported(typeof result.reason === "string" ? result.reason : "Run setup again to manage settings here.");
      return;
    }
    const bounds = result.bounds && result.bounds.summaryContextCharacters;
    const input = $(FIELDS.summaryContextCharacters);
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    $("summary-context-characters-hint").textContent = `From ${bounds.min} to ${bounds.max}. Recent transcript text kept for live summaries.`;
    fill(result.values);
    $("settings-loading").hidden = true;
    $("panel-gemini-settings").hidden = false;

    $("gemini-settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const values = readForm();
      const errors = localErrors(values, bounds);
      for (const [key, id] of Object.entries(FIELDS)) showFieldError($(id), errors[key] || "");
      if (Object.keys(errors).length) {
        setStatus("Fix the highlighted fields.", "error");
        return;
      }
      busy = true;
      const button = $("settings-save");
      button.setAttribute("aria-disabled", "true");
      setStatus("Saving settings.", "");
      const saved = await call("saveGeminiSettings", values);
      busy = false;
      button.removeAttribute("aria-disabled");
      const saveError = errorOf(saved);
      if (saveError) {
        setStatus(saveError, "error");
        return;
      }
      fill(saved.values);
      setStatus("Saved. Meeting processing restarted with the new settings.", "ok");
    });
  }

  $("settings-rerun").addEventListener("click", rerunSetup);
  $("unsupported-rerun").addEventListener("click", rerunSetup);
  void load();
})();
