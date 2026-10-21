"use strict";

// Settings renderer. It talks to the main process only through window.meetingWikiSettings
// and writes every dynamic value with textContent or input.value.
//
// Expected bridge (implemented by settings-preload.js):
//   getIdentitySettings() -> { ready: true, values, legacyUserName, limits } | { ready: false, reason } | { error }
//   saveIdentitySettings({ primaryProfileName, aliases }) -> { ok: true, values } | { error }
//   getGeminiSettings()  -> { ready: true, values, bounds } | { ready: false, reason } | { error }
//   saveGeminiSettings(values) -> { ok: true, values } | { error }
//   getRecordingSettings() -> { ready: true, values, bounds } | { ready: false, reason } | { error }
//   saveRecordingSettings({ maxDurationMinutes }) -> { ok: true, values } | { error }
//   getIntegrationSettings() -> { ready: true, values, readiness } | { ready: false, reason } | { error }
//   saveIntegrationSettings({ zoomAutoRecord, googleMeetAutoRecord }) -> { ok: true, values, readiness } | { error }
//   showMeetExtension()  -> { ok: true } | { error }
//   rerunSetup()         -> { ok: true } | { error }
//   getSettingMetadata() -> { settings: { [key]: { form, appliesAfter, copy } }, manualEdit }

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
  // Applies-after copy comes only from setting-metadata.js, delivered over the bridge.
  let metadata = { settings: {}, manualEdit: "" };

  function copyFor(key) {
    const entry = metadata.settings[key];
    return entry && typeof entry.copy === "string" ? entry.copy : "";
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

  function showUnsupported(reason, manualConfig) {
    $("settings-loading").hidden = true;
    $("unsupported-manual").textContent = manualConfig ? metadata.manualEdit : "";
    $("unsupported-manual").hidden = !(manualConfig && metadata.manualEdit);
    $("panel-identity-settings").hidden = true;
    $("panel-gemini-settings").hidden = true;
    $("panel-recording-settings").hidden = true;
    $("panel-integration-settings").hidden = true;
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

  function identityChanges(before, after) {
    const changed = [];
    if (before.primaryProfileName !== after.primaryProfileName) changed.push("primaryProfileName");
    if (JSON.stringify(before.aliases) !== JSON.stringify(after.aliases)) changed.push("aliases");
    return changed;
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
      fillIdentity(saved.values);
      $("primary-profile-name-hint").textContent = "Shown on your microphone channel and owned action items.";
      setIdentityStatus(savedMessage(changed), "ok");
    });
  }

  function setRecordingStatus(message, tone) {
    const node = $("recording-status");
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  function showRecording(result) {
    const bounds = result.bounds.maxDurationMinutes;
    const input = $("max-duration-minutes");
    const values = result.values || {};
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    input.value = String(values.maxDurationMinutes ?? "");
    $("max-duration-minutes-hint").textContent = `From ${bounds.min} to ${bounds.max} minutes.`;
    let savedMinutes = values.maxDurationMinutes;
    $("panel-recording-settings").hidden = false;

    $("recording-settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const raw = input.value.trim();
      const minutes = Number(raw);
      const valid = /^\d+$/.test(raw) && minutes >= bounds.min && minutes <= bounds.max;
      showFieldError(input, valid ? "" : `Enter a whole number from ${bounds.min} to ${bounds.max}.`);
      if (!valid) {
        setRecordingStatus("Fix the highlighted field.", "error");
        return;
      }
      busy = true;
      const button = $("recording-save");
      button.setAttribute("aria-disabled", "true");
      setRecordingStatus("Saving the recording limit.", "");
      const saved = await call("saveRecordingSettings", { maxDurationMinutes: minutes });
      busy = false;
      button.removeAttribute("aria-disabled");
      const saveError = errorOf(saved);
      if (saveError) {
        setRecordingStatus(saveError, "error");
        return;
      }
      input.value = String(saved.values.maxDurationMinutes);
      const changed = saved.values.maxDurationMinutes === savedMinutes ? [] : ["maxDurationMinutes"];
      savedMinutes = saved.values.maxDurationMinutes;
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
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  function fillList(id, lines) {
    const list = $(id);
    list.replaceChildren(...lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    }));
  }

  function accessLine(label, status, consequence) {
    const text = ACCESS_LABELS[status] || "unknown";
    return status === "granted" ? `${label}: allowed.` : `${label}: ${text}. ${consequence}`;
  }

  function permissionLines(permissions) {
    const source = permissions || {};
    return [
      accessLine("Microphone access", source.microphone, "Recordings will be silent until it is allowed in System Settings."),
      accessLine("Screen & System Audio Recording", source.systemAudio, "Other participants will not be recorded until it is allowed."),
    ];
  }

  function renderReadiness(readiness) {
    const source = readiness && typeof readiness === "object" ? readiness : {};
    const zoom = source.zoom || {};
    fillList("zoom-readiness", [
      zoom.appInstalled ? "Zoom app found in Applications." : "Zoom app not found in Applications.",
      zoom.toolsAvailable ? "macOS process tools available." : "macOS process tools are missing, so Zoom meetings cannot be detected.",
      ZOOM_DETECTOR[zoom.detector] || ZOOM_DETECTOR.off,
      ...permissionLines(source.permissions),
    ]);
    const meet = source.googleMeet || {};
    const browsers = Array.isArray(meet.browsers) ? meet.browsers.filter((browser) => browser && browser.found) : [];
    const seenAt = Number.isFinite(meet.extensionLastSeenAt) ? new Date(meet.extensionLastSeenAt).toLocaleTimeString() : "";
    fillList("google-meet-readiness", [
      meet.extensionBundled ? "Extension included with this app." : "Extension missing from this build.",
      ...(browsers.length
        ? browsers.map((browser) => `${String(browser.name)}: ${browser.connected ? "connection installed." : "found, connection not installed. Turn this on and save."}`)
        : ["No supported browser found."]),
      seenAt
        ? `Extension last checked in at ${seenAt}.`
        : "Extension not seen since Meeting Wiki started. After loading it, open or reload a Meet tab.",
      MEET_DETECTOR[meet.detector] || MEET_DETECTOR.off,
      ...permissionLines(source.permissions),
    ]);
  }

  function showIntegrations(result) {
    const values = result.values || {};
    const zoom = $("zoom-auto-record");
    const meet = $("google-meet-auto-record");
    zoom.checked = values.zoomAutoRecord === true;
    meet.checked = values.googleMeetAutoRecord === true;
    let saved = { zoomAutoRecord: zoom.checked, googleMeetAutoRecord: meet.checked };
    renderReadiness(result.readiness);
    $("panel-integration-settings").hidden = false;

    $("show-meet-extension").addEventListener("click", async () => {
      const shown = await call("showMeetExtension");
      const error = errorOf(shown);
      if (error) setIntegrationStatus(error, "error");
    });

    $("integration-settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const next = { zoomAutoRecord: zoom.checked, googleMeetAutoRecord: meet.checked };
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
        setIntegrationStatus(saveError, "error");
        return;
      }
      const changed = Object.keys(next).filter((key) => result.values[key] !== saved[key]);
      saved = { ...result.values };
      zoom.checked = saved.zoomAutoRecord;
      meet.checked = saved.googleMeetAutoRecord;
      renderReadiness(result.readiness);
      setIntegrationStatus(savedMessage(changed), "ok");
    });
  }

  async function rerunSetup() {
    const result = await call("rerunSetup");
    const error = errorOf(result);
    if (error) setStatus(error, "error");
  }

  async function load() {
    if (!bridge) $("bridge-missing").hidden = false;
    const [identity, result, recording, meta, integrationSettings] = await Promise.all([
      call("getIdentitySettings"),
      call("getGeminiSettings"),
      call("getRecordingSettings"),
      call("getSettingMetadata"),
      call("getIntegrationSettings"),
    ]);
    applyMetadata(errorOf(meta) ? null : meta);
    const identityReady = !errorOf(identity) && identity.ready === true;
    const geminiReady = !errorOf(result) && result.ready === true;
    const recordingReady = !errorOf(recording) && recording.ready === true;
    if (!identityReady && !geminiReady && !recordingReady) {
      showUnsupported(reasonOf(identity), identity && identity.manualConfig === true);
      return;
    }
    $("settings-loading").hidden = true;
    if (identityReady) showIdentity(identity);
    if (recordingReady) showRecording(recording);
    if (!errorOf(integrationSettings) && integrationSettings.ready === true) showIntegrations(integrationSettings);
    if (!geminiReady) {
      const manual = result && result.manualConfig === true && metadata.manualEdit ? ` ${metadata.manualEdit}` : "";
      $("gemini-unavailable").textContent = `${reasonOf(result)}${manual}`;
      $("gemini-unavailable").hidden = false;
      return;
    }
    const bounds = result.bounds && result.bounds.summaryContextCharacters;
    const input = $(FIELDS.summaryContextCharacters);
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    $("summary-context-characters-hint").textContent = `From ${bounds.min} to ${bounds.max}. Recent transcript text kept for live summaries.`;
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
