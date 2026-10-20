"use strict";

// Settings renderer. It talks to the main process only through window.meetingWikiSettings
// and writes every dynamic value with textContent or input.value.
//
// Expected bridge (implemented by settings-preload.js):
//   getIdentitySettings() -> { ready: true, values, legacyUserName, limits } | { ready: false, reason } | { error }
//   saveIdentitySettings({ primaryProfileName, aliases }) -> { ok: true, values } | { error }
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
  const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'\u2019()_-]*$/u;
  const NAME_RULE = "Use letters, numbers, spaces, and . , ' - _ ( ) starting with a letter or number.";
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
    $("panel-identity-settings").hidden = true;
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

  function reasonOf(result) {
    const error = errorOf(result);
    if (error) return error;
    return result && typeof result.reason === "string" ? result.reason : "Run setup again to manage settings here.";
  }

  const normalizeName = (value) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
  const nameKey = (value) => value.normalize("NFKC").toLowerCase();

  function fillIdentity(values) {
    const source = values && typeof values === "object" ? values : {};
    $("primary-profile-name").value = typeof source.primaryProfileName === "string" ? source.primaryProfileName : "";
    const aliases = Array.isArray(source.aliases) ? source.aliases.filter((alias) => typeof alias === "string") : [];
    $("profile-aliases").value = aliases.join("\n");
  }

  function readIdentityForm() {
    return {
      primaryProfileName: normalizeName($("primary-profile-name").value),
      aliases: $("profile-aliases").value.split("\n").map(normalizeName).filter(Boolean),
    };
  }

  function nameError(name, limits) {
    if (!name) return "Enter a name.";
    if ([...name].length > limits.nameMaxLength) return `Keep names to ${limits.nameMaxLength} characters or fewer.`;
    return NAME_PATTERN.test(name) ? "" : NAME_RULE;
  }

  // Mirrors the main-process identity checks for quick feedback; main stays authoritative.
  function identityErrors(values, limits) {
    const errors = {};
    const primary = nameError(values.primaryProfileName, limits);
    if (primary) errors.primaryProfileName = primary;
    if (values.aliases.length > limits.maxAliases) {
      errors.aliases = `Add at most ${limits.maxAliases} aliases.`;
      return errors;
    }
    const seen = new Set([nameKey(values.primaryProfileName)]);
    for (const alias of values.aliases) {
      const problem = nameError(alias, limits) || (seen.has(nameKey(alias)) ? "Each alias must differ from your name and the other aliases." : "");
      if (problem) {
        errors.aliases = `${alias.slice(0, 40)}: ${problem}`;
        break;
      }
      seen.add(nameKey(alias));
    }
    return errors;
  }

  function setIdentityStatus(message, tone) {
    const node = $("identity-status");
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  function showIdentity(result) {
    const limits = result.limits;
    const legacy = typeof result.legacyUserName === "string" ? result.legacyUserName : "";
    const values = result.values || {};
    fillIdentity(values);
    if (!values.primaryProfileName && legacy) $("primary-profile-name").value = legacy;
    $("primary-profile-name-hint").textContent = values.primaryProfileName
      ? "Shown on your microphone channel and owned action items."
      : legacy
        ? "Taken from the older user_name setting. Save to keep it as your primary name."
        : "Not set yet, so your microphone is labeled User.";
    $("profile-aliases-hint").textContent = `One per line, up to ${limits.maxAliases}. For example a nickname or how a calendar spells your name.`;
    $("panel-identity-settings").hidden = false;

    $("identity-settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const next = readIdentityForm();
      const errors = identityErrors(next, limits);
      showFieldError($("primary-profile-name"), errors.primaryProfileName || "");
      showFieldError($("profile-aliases"), errors.aliases || "");
      if (Object.keys(errors).length) {
        setIdentityStatus("Fix the highlighted fields.", "error");
        return;
      }
      busy = true;
      const button = $("identity-save");
      button.setAttribute("aria-disabled", "true");
      setIdentityStatus("Saving your name.", "");
      const saved = await call("saveIdentitySettings", next);
      busy = false;
      button.removeAttribute("aria-disabled");
      const saveError = errorOf(saved);
      if (saveError) {
        setIdentityStatus(saveError, "error");
        return;
      }
      fillIdentity(saved.values);
      $("primary-profile-name-hint").textContent = "Shown on your microphone channel and owned action items.";
      setIdentityStatus("Saved. Meeting processing restarted with your name.", "ok");
    });
  }

  async function rerunSetup() {
    const result = await call("rerunSetup");
    const error = errorOf(result);
    if (error) setStatus(error, "error");
  }

  async function load() {
    if (!bridge) $("bridge-missing").hidden = false;
    const [identity, result] = await Promise.all([call("getIdentitySettings"), call("getGeminiSettings")]);
    const identityReady = !errorOf(identity) && identity.ready === true;
    const geminiReady = !errorOf(result) && result.ready === true;
    if (!identityReady && !geminiReady) {
      showUnsupported(reasonOf(identity));
      return;
    }
    $("settings-loading").hidden = true;
    if (identityReady) showIdentity(identity);
    if (!geminiReady) {
      $("gemini-unavailable").textContent = reasonOf(result);
      $("gemini-unavailable").hidden = false;
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
