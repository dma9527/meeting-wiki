"use strict";

// Settings renderer. It talks to the main process only through window.meetingWikiSettings
// and writes every dynamic value with textContent or input.value.
//
// Expected bridge (implemented by settings-preload.js):
//   getIdentitySettings() -> { ready: true, values, legacyUserName, limits } | { ready: false, reason } | { error }
//   saveIdentitySettings({ primaryProfileName, aliases }) -> { ok: true, values } | { error }
//   getLanguageSettings() -> { ready: true, values, choices } | { ready: false, reason } | { error }
//   saveLanguageSettings(values) -> { ok: true, values } | { error }
//   getGeminiSettings()  -> { ready: true, values, bounds } | { ready: false, reason } | { error }
//   saveGeminiSettings(values) -> { ok: true, values } | { error }
//   getRecordingSettings() -> { ready: true, values, bounds } | { ready: false, reason } | { error }
//   saveRecordingSettings({ maxDurationMinutes, defaultPrivacyMode, liveEnabled }) -> { ok: true, values } | { error }
//   getIntegrationSettings() -> { ready: true, values, readiness } | { ready: false, reason } | { error }
//   saveIntegrationSettings({ zoomAutoRecord, googleMeetAutoRecord, autoRecordPrivacy }) -> { ok: true, values, readiness } | { error }
//   showMeetExtension()  -> { ok: true } | { error }
//   rerunSetup()         -> { ok: true } | { error }
//   getSettingMetadata() -> { settings: { [key]: { form, appliesAfter, copy } }, manualEdit }

(function settingsWindow() {
  const bridge = window.meetingWikiSettings;
  const localization = window.meetingWikiSettingsLocalization;
  const $ = (id) => document.getElementById(id);
  const FIELDS = Object.freeze({
    batchAudioModel: "batch-audio-model",
    liveModel: "live-model",
    languageModel: "language-model",
    summaryContextCharacters: "summary-context-characters",
  });
  const LANGUAGE_FIELDS = Object.freeze({
    transcriptLanguage: "transcript-language",
    liveTranslationLanguage: "live-translation-language",
    liveSummaryLanguage: "live-summary-language",
    memoryLanguage: "memory-language",
    uiLanguage: "ui-language",
  });
  const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'\u2019()_-]*$/u;
  const NAME_RULE = "Use letters, numbers, spaces, and . , ' - _ ( ) starting with a letter or number.";
  let busy = false;
  let metadata = { settings: {}, manualEdit: "" };
  let localeChoice = "system";
  const localizedNodeMessages = new Map();
  const localeRenderers = new Set();

  function localizedMessage(message) {
    return localization && typeof localization.translateSettingsMessage === "function"
      ? localization.translateSettingsMessage(message, localeChoice, navigator.language)
      : message;
  }

  function setLocalizedNode(node, message) {
    localizedNodeMessages.set(node, message);
    node.textContent = localizedMessage(message);
  }

  function registerLocaleRenderer(renderer) {
    localeRenderers.add(renderer);
    renderer();
  }

  function copyFor(key) {
    const entry = metadata.settings[key];
    if (!entry || typeof entry.copy !== "string") return "";
    return localization && typeof localization.localizedApplies === "function"
      ? localization.localizedApplies(entry.appliesAfter, entry.copy, localeChoice, navigator.language)
      : entry.copy;
  }

  function applyMetadata(result) {
    if (result && typeof result === "object" && result.settings && typeof result.settings === "object") {
      metadata = { settings: result.settings, manualEdit: typeof result.manualEdit === "string" ? result.manualEdit : "" };
    }
    for (const node of document.querySelectorAll("[data-applies-for]")) {
      const copy = copyFor(node.dataset.appliesFor);
      node.textContent = copy;
      node.hidden = !copy;
    }
  }

  // "Saved." plus each distinct applies-after line for the keys that changed.
  function savedMessage(keys) {
    if (!keys.length) return "Saved. Nothing changed.";
    const lines = [...new Set(keys.map(copyFor).filter(Boolean))];
    return ["Saved.", ...lines].join(" ");
  }

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
    setLocalizedNode(node, message);
    node.dataset.tone = tone || "";
  }

  function showFieldError(input, message) {
    const node = $(`${input.id}-error`);
    setLocalizedNode(node, message);
    node.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function showUnsupported(reason, manualConfig) {
    $("settings-loading").hidden = true;
    $("unsupported-manual").textContent = manualConfig ? localizedMessage(metadata.manualEdit) : "";
    $("unsupported-manual").hidden = !(manualConfig && metadata.manualEdit);
    $("panel-identity-settings").hidden = true;
    $("panel-language-settings").hidden = true;
    $("panel-gemini-settings").hidden = true;
    $("panel-recording-settings").hidden = true;
    $("panel-integration-settings").hidden = true;
    $("unsupported-reason").textContent = localizedMessage(reason);
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

  function identityChanges(before, after) {
    const changed = [];
    if (before.primaryProfileName !== after.primaryProfileName) changed.push("primaryProfileName");
    if (JSON.stringify(before.aliases) !== JSON.stringify(after.aliases)) changed.push("aliases");
    return changed;
  }

  function setIdentityStatus(message, tone) {
    const node = $("identity-status");
    setLocalizedNode(node, message);
    node.dataset.tone = tone || "";
  }

  function showIdentity(result) {
    const limits = result.limits;
    const legacy = typeof result.legacyUserName === "string" ? result.legacyUserName : "";
    const values = result.values || {};
    fillIdentity(values);
    let primaryNameSaved = Boolean(values.primaryProfileName);
    if (!primaryNameSaved && legacy) $("primary-profile-name").value = legacy;
    const renderIdentityHints = () => {
      setLocalizedNode(
        $("primary-profile-name-hint"),
        primaryNameSaved
          ? "Shown on your microphone channel and owned action items."
          : legacy
            ? "Taken from the older user_name setting. Save to keep it as your primary name."
            : "Not set yet, so your microphone is labeled User.",
      );
      setLocalizedNode(
        $("profile-aliases-hint"),
        `One per line, up to ${limits.maxAliases}. For example a nickname or how a calendar spells your name.`,
      );
    };
    registerLocaleRenderer(renderIdentityHints);
    $("panel-identity-settings").hidden = false;
    let current = { primaryProfileName: values.primaryProfileName || "", aliases: Array.isArray(values.aliases) ? [...values.aliases] : [] };

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
      const before = { ...current };
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
      const changed = identityChanges(before, saved.values);
      current = { primaryProfileName: saved.values.primaryProfileName, aliases: [...saved.values.aliases] };
      primaryNameSaved = true;
      fillIdentity(saved.values);
      renderIdentityHints();
      setIdentityStatus(savedMessage(changed), "ok");
    });
  }

  function setLanguageStatus(message, tone) {
    const node = $("language-status");
    setLocalizedNode(node, message);
    node.dataset.tone = tone || "";
  }

  function readLanguages() {
    return Object.fromEntries(
      Object.entries(LANGUAGE_FIELDS).map(([field, id]) => [field, $(id).value]),
    );
  }

  function fillLanguages(values) {
    for (const [field, id] of Object.entries(LANGUAGE_FIELDS)) {
      const value = values && values[field];
      if (typeof value === "string") $(id).value = value;
    }
  }

  function applyLocale(choice) {
    localeChoice = choice;
    if (localization && typeof localization.applySettingsLocale === "function") {
      localization.applySettingsLocale(document, choice, navigator.language);
    }
    for (const node of document.querySelectorAll("[data-applies-for]")) {
      const copy = copyFor(node.dataset.appliesFor);
      node.textContent = copy;
      node.hidden = !copy;
    }
    for (const [node, message] of localizedNodeMessages) node.textContent = localizedMessage(message);
    for (const renderer of localeRenderers) renderer();
  }

  function showLanguages(result) {
    fillLanguages(result.values);
    const unsupported = Array.isArray(result.unsupportedFields) ? result.unsupportedFields : [];
    $("language-migration-notice").hidden = unsupported.length === 0;
    applyLocale(result.values.uiLanguage);
    let current = readLanguages();
    $("ui-language").addEventListener("change", () => applyLocale($("ui-language").value));
    $("panel-language-settings").hidden = false;
    $("language-settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const next = readLanguages();
      if (Object.values(next).some((value) => !value)) {
        setLanguageStatus("Choose a supported value for every language.", "error");
        return;
      }
      busy = true;
      const button = $("language-save");
      button.setAttribute("aria-disabled", "true");
      setLanguageStatus("Saving languages.", "");
      const saved = await call("saveLanguageSettings", next);
      busy = false;
      button.removeAttribute("aria-disabled");
      const saveError = errorOf(saved);
      if (saveError) {
        fillLanguages(current);
        applyLocale(current.uiLanguage);
        setLanguageStatus(saveError, "error");
        return;
      }
      $("language-migration-notice").hidden = true;
      fillLanguages(saved.values);
      applyLocale(saved.values.uiLanguage);
      const after = readLanguages();
      const changed = Object.keys(LANGUAGE_FIELDS).filter((field) => after[field] !== current[field]);
      current = after;
      setLanguageStatus(savedMessage(changed), "ok");
    });
  }

  function setRecordingStatus(message, tone) {
    const node = $("recording-status");
    setLocalizedNode(node, message);
    node.dataset.tone = tone || "";
  }

  function showRecording(result) {
    const bounds = result.bounds.maxDurationMinutes;
    const input = $("max-duration-minutes");
    const values = result.values || {};
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    input.value = String(values.maxDurationMinutes ?? "");
    if (values.defaultsConfigured === true) {
      $(values.defaultPrivacyMode === "private" ? "default-privacy-private" : "default-privacy-shared").checked = true;
    } else {
      $("default-privacy-private").checked = false;
      $("default-privacy-shared").checked = false;
    }
    $("recording-defaults-notice").hidden = values.defaultsConfigured === true;
    $("recording-live-enabled").checked = values.liveEnabled !== false;
    setLocalizedNode($("max-duration-minutes-hint"), `From ${bounds.min} to ${bounds.max} minutes.`);
    let savedValues = {
      maxDurationMinutes: values.maxDurationMinutes,
      defaultPrivacyMode: values.defaultPrivacyMode,
      liveEnabled: values.liveEnabled,
      defaultsConfigured: values.defaultsConfigured === true,
    };
    $("panel-recording-settings").hidden = false;

    $("recording-settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const raw = input.value.trim();
      const minutes = Number(raw);
      const valid = /^\d+$/.test(raw) && minutes >= bounds.min && minutes <= bounds.max;
      showFieldError(input, valid ? "" : `Enter a whole number from ${bounds.min} to ${bounds.max}.`);
      const privacy = document.querySelector('input[name="defaultPrivacyMode"]:checked');
      if (!valid || !privacy) {
        setRecordingStatus("Fix the highlighted field.", "error");
        return;
      }
      const next = {
        maxDurationMinutes: minutes,
        defaultPrivacyMode: privacy.value,
        liveEnabled: $("recording-live-enabled").checked,
        expectedDefaultsConfigured: savedValues.defaultsConfigured,
        expectedDefaultPrivacyMode: savedValues.defaultPrivacyMode,
        expectedLiveEnabled: savedValues.liveEnabled,
      };
      busy = true;
      const button = $("recording-save");
      button.setAttribute("aria-disabled", "true");
      setRecordingStatus("Saving recording defaults.", "");
      const saved = await call("saveRecordingSettings", next);
      busy = false;
      button.removeAttribute("aria-disabled");
      const saveError = errorOf(saved);
      if (saveError) {
        setRecordingStatus(saveError, "error");
        return;
      }
      input.value = String(saved.values.maxDurationMinutes);
      $(saved.values.defaultPrivacyMode === "private" ? "default-privacy-private" : "default-privacy-shared").checked = true;
      $("recording-live-enabled").checked = saved.values.liveEnabled;
      const changed = [];
      if (saved.values.maxDurationMinutes !== savedValues.maxDurationMinutes) changed.push("maxDurationMinutes");
      if (!savedValues.defaultsConfigured || saved.values.defaultPrivacyMode !== savedValues.defaultPrivacyMode) changed.push("defaultPrivacyMode");
      if (!savedValues.defaultsConfigured || saved.values.liveEnabled !== savedValues.liveEnabled) changed.push("recordingLiveEnabled");
      savedValues = { ...saved.values, defaultsConfigured: true };
      $("recording-defaults-notice").hidden = true;
      setRecordingStatus(savedMessage(changed), "ok");
    });
  }

  const ACCESS_LABELS = Object.freeze({ granted: "allowed", denied: "denied", restricted: "restricted", "not-determined": "not asked yet" });
  const ZOOM_DETECTOR = Object.freeze({
    off: "Not watching for Zoom meetings.",
    starting: "Starting to watch for Zoom meetings.",
    "zoom-closed": "Watching. Zoom is not open.",
    "zoom-open": "Watching. Zoom is open and not in a meeting.",
    "in-meeting": "Watching. A Zoom meeting is in progress.",
    unavailable: "Watching, but the last check did not finish. It retries every few seconds.",
  });
  const MEET_DETECTOR = Object.freeze({
    off: "Not watching for Google Meet calls.",
    watching: "Watching. No Google Meet call is in progress.",
    "in-meeting": "Watching. A Google Meet call is in progress.",
  });

  function setIntegrationStatus(message, tone) {
    const node = $("integration-status");
    setLocalizedNode(node, message);
    node.dataset.tone = tone || "";
  }

  function fillList(id, lines) {
    const list = $(id);
    list.replaceChildren(...lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = localizedMessage(line);
      return item;
    }));
  }

  function accessLine(label, status, consequence) {
    const text = ACCESS_LABELS[status] || "unknown";
    return status === "granted" ? `${label}: allowed.` : `${label}: ${text}. ${consequence}`;
  }

  function permissionLines(permissions) {
    const source = permissions || {};
    const microphoneFallback = accessLine(
      "Microphone access",
      source.microphone,
      "Recordings cannot start until microphone access is allowed in System Settings.",
    );
    const microphone = localization && typeof localization.microphonePermissionLine === "function"
      ? localization.microphonePermissionLine(source.microphone, localeChoice, navigator.language)
      : null;
    const systemAudioFallback = "System audio permission cannot be checked in advance. If other participants were silent, allow Meeting Wiki under System Audio Recording in System Settings.";
    const systemAudio = localization && typeof localization.systemAudioPermissionLine === "function"
      ? localization.systemAudioPermissionLine(localeChoice, navigator.language)
      : null;
    return [microphone || microphoneFallback, systemAudio || systemAudioFallback];
  }

  const PRIVACY_MODES = ["private", "calendar", "shared"];

  function selectedPrivacy() {
    const checked = document.querySelector('input[name="autoRecordPrivacy"]:checked');
    return checked && PRIVACY_MODES.includes(checked.value) ? checked.value : "";
  }

  function setPrivacy(mode, choiceNeeded) {
    const value = PRIVACY_MODES.includes(mode) ? mode : "private";
    for (const radio of document.querySelectorAll('input[name="autoRecordPrivacy"]')) radio.checked = radio.value === value;
    $("auto-record-privacy-notice").hidden = choiceNeeded !== true;
  }

  function localizedDetector(kind, state, fallback) {
    return localization && typeof localization.detectorLine === "function"
      ? localization.detectorLine(kind, state, fallback, localeChoice, navigator.language)
      : fallback;
  }

  function localizedBrowserConnection(browser) {
    const name = String(browser.name);
    if (localization && typeof localization.browserConnectionLine === "function") {
      return localization.browserConnectionLine(name, browser.connected, localeChoice, navigator.language);
    }
    return `${name}: ${browser.connected ? "connection installed." : "found, connection not installed. Turn this on and save."}`;
  }

  function renderReadiness(readiness) {
    const source = readiness && typeof readiness === "object" ? readiness : {};
    const zoom = source.zoom || {};
    const zoomDetector = ZOOM_DETECTOR[zoom.detector] || ZOOM_DETECTOR.off;
    fillList("zoom-readiness", [
      zoom.appInstalled ? "Zoom app found in Applications." : "Zoom app not found in Applications.",
      zoom.toolsAvailable ? "macOS process tools available." : "macOS process tools are missing, so Zoom meetings cannot be detected.",
      localizedDetector("zoom", zoom.detector, zoomDetector),
      ...permissionLines(source.permissions),
    ]);
    const meet = source.googleMeet || {};
    const browsers = Array.isArray(meet.browsers) ? meet.browsers.filter((browser) => browser && browser.found) : [];
    const seenAt = Number.isFinite(meet.extensionLastSeenAt) ? new Date(meet.extensionLastSeenAt).toLocaleTimeString() : "";
    const meetDetector = MEET_DETECTOR[meet.detector] || MEET_DETECTOR.off;
    fillList("google-meet-readiness", [
      meet.extensionBundled ? "Extension included with this app." : "Extension missing from this build.",
      ...(browsers.length
        ? browsers.map(localizedBrowserConnection)
        : ["No supported browser found."]),
      seenAt
        ? `Extension last checked in at ${seenAt}.`
        : "Extension not seen since Meeting Wiki started. After loading it, open or reload a Meet tab.",
      localizedDetector("meet", meet.detector, meetDetector),
      ...permissionLines(source.permissions),
    ]);
  }

  function showIntegrations(result) {
    const values = result.values || {};
    const zoom = $("zoom-auto-record");
    const meet = $("google-meet-auto-record");
    zoom.checked = values.zoomAutoRecord === true;
    meet.checked = values.googleMeetAutoRecord === true;
    setPrivacy(values.autoRecordPrivacy, values.autoRecordPrivacyChoiceNeeded);
    // A pending migration counts as unsaved, so saving records the explicit choice.
    let saved = {
      zoomAutoRecord: zoom.checked,
      googleMeetAutoRecord: meet.checked,
      autoRecordPrivacy: values.autoRecordPrivacyChoiceNeeded === true ? "" : selectedPrivacy(),
    };
    let currentReadiness = result.readiness;
    registerLocaleRenderer(() => renderReadiness(currentReadiness));
    $("panel-integration-settings").hidden = false;

    $("show-meet-extension").addEventListener("click", async () => {
      const shown = await call("showMeetExtension");
      const error = errorOf(shown);
      if (error) setIntegrationStatus(error, "error");
    });

    $("integration-settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const next = { zoomAutoRecord: zoom.checked, googleMeetAutoRecord: meet.checked, autoRecordPrivacy: selectedPrivacy() };
      if (!next.autoRecordPrivacy) {
        setIntegrationStatus("Choose where automatic recordings go.", "error");
        return;
      }
      busy = true;
      const button = $("integration-save");
      button.setAttribute("aria-disabled", "true");
      setIntegrationStatus("Saving automatic recording.", "");
      const result = await call("saveIntegrationSettings", next);
      busy = false;
      button.removeAttribute("aria-disabled");
      const saveError = errorOf(result);
      if (saveError) {
        zoom.checked = saved.zoomAutoRecord;
        meet.checked = saved.googleMeetAutoRecord;
        if (saved.autoRecordPrivacy) setPrivacy(saved.autoRecordPrivacy, false);
        setIntegrationStatus(saveError, "error");
        return;
      }
      const changed = Object.keys(next).filter((key) => result.values[key] !== saved[key]);
      saved = {
        zoomAutoRecord: result.values.zoomAutoRecord,
        googleMeetAutoRecord: result.values.googleMeetAutoRecord,
        autoRecordPrivacy: result.values.autoRecordPrivacy,
      };
      zoom.checked = saved.zoomAutoRecord;
      meet.checked = saved.googleMeetAutoRecord;
      setPrivacy(result.values.autoRecordPrivacy, result.values.autoRecordPrivacyChoiceNeeded);
      currentReadiness = result.readiness;
      renderReadiness(currentReadiness);
      setIntegrationStatus(savedMessage(changed), "ok");
    });
  }

  async function rerunSetup() {
    const result = await call("rerunSetup");
    const error = errorOf(result);
    if (error) setStatus(error, "error");
  }

  async function load() {
    applyLocale("system");
    if (!bridge) $("bridge-missing").hidden = false;
    const [identity, languages, result, recording, meta, integrationSettings] = await Promise.all([
      call("getIdentitySettings"),
      call("getLanguageSettings"),
      call("getGeminiSettings"),
      call("getRecordingSettings"),
      call("getSettingMetadata"),
      call("getIntegrationSettings"),
    ]);
    applyMetadata(errorOf(meta) ? null : meta);
    const identityReady = !errorOf(identity) && identity.ready === true;
    const languageReady = !errorOf(languages) && languages.ready === true;
    const geminiReady = !errorOf(result) && result.ready === true;
    const recordingReady = !errorOf(recording) && recording.ready === true;
    if (languageReady) {
      fillLanguages(languages.values);
      applyLocale(languages.values.uiLanguage);
    }
    if (!identityReady && !languageReady && !geminiReady && !recordingReady) {
      showUnsupported(reasonOf(identity), identity && identity.manualConfig === true);
      return;
    }
    $("settings-loading").hidden = true;
    if (identityReady) showIdentity(identity);
    if (languageReady) showLanguages(languages);
    if (recordingReady) showRecording(recording);
    if (!errorOf(integrationSettings) && integrationSettings.ready === true) showIntegrations(integrationSettings);
    if (!geminiReady) {
      const reason = reasonOf(result);
      const manual = result && result.manualConfig === true && metadata.manualEdit ? metadata.manualEdit : "";
      registerLocaleRenderer(() => {
        $("gemini-unavailable").textContent = [localizedMessage(reason), localizedMessage(manual)].filter(Boolean).join(" ");
      });
      $("gemini-unavailable").hidden = false;
      return;
    }
    const bounds = result.bounds && result.bounds.summaryContextCharacters;
    const input = $(FIELDS.summaryContextCharacters);
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    setLocalizedNode(
      $("summary-context-characters-hint"),
      `From ${bounds.min} to ${bounds.max}. Recent transcript text kept for live summaries.`,
    );
    fill(result.values);
    let geminiValues = readForm();
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
      const after = readForm();
      const changed = Object.keys(FIELDS).filter((key) => after[key] !== geminiValues[key]);
      geminiValues = after;
      setStatus(savedMessage(changed), "ok");
    });
  }

  $("settings-rerun").addEventListener("click", rerunSetup);
  $("unsupported-rerun").addEventListener("click", rerunSetup);
  void load();
})();
