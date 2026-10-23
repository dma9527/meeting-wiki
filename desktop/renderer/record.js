"use strict";

// Recording confirmation renderer. It talks to the main process only through
// window.meetingWikiRecord and writes every dynamic value with textContent.
//
// Expected bridge (implemented by record-preload.js):
//   getContext() -> { blockers, maxDurationMinutes, microphone, systemAudio, destination, host, live, liveStarts, liveScope, recording, formMode, defaults } | { error }
//   start({ title, privacyMode, liveEnabled }) -> { ok: true } | { error }
//   cancel() -> { ok: true }
//   openSetup() -> { ok: true }
//   openPrivacySettings("microphone" | "systemAudio") -> { ok: true } | { error }

(function recordPanel() {
  const bridge = window.meetingWikiRecord;
  const $ = (id) => document.getElementById(id);
  const TITLE_MAX = 200;
  let busy = false;
  let context = null;

  const localization = window.meetingWikiRecordLocalization;
  let statusKey = "";

  function t(message, vars = null) {
    if (localization) return localization.translateRecordMessage(message, context && context.uiLanguage, navigator.language, vars);
    return vars ? message.replace(/\{([a-zA-Z]+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : message;
  }

  function joinParts(parts) {
    return localization
      ? localization.joinSentences(parts, context && context.uiLanguage, navigator.language)
      : parts.filter(Boolean).join(" ");
  }

  const PERMISSION = {
    granted: "",
    denied: "blocked in System Settings",
    restricted: "restricted by a device policy",
    "not-determined": "macOS asks when recording starts",
    unknown: "status not reported",
  };

  const BOTH_CHANNELS = "Live captions cover your microphone and all audio played on this Mac, including other participants, each labeled.";
  const LIVE = {
    ready: ["Live captions, translation, and rolling summary start with the recording.", BOTH_CHANNELS, "They are display-only and never change saved notes."],
    no_adapter: ["Not available with this provider, so no live window opens. The recording is still processed after you stop."],
    engine_missing: ["Unavailable because the Meeting Wiki engine is missing. Reinstall the app."],
    key_unavailable: ["Unavailable because the API key could not be read. Run setup again. The audio is still saved."],
    manual: ["A live window opens only if your hand-edited configuration supports live captions.", BOTH_CHANNELS],
  };

  const BLOCKERS = {
    setup_incomplete: "Setup is not finished, so recording cannot start. Open setup to choose a provider.",
    microphone_blocked: "Microphone access is blocked, so recording cannot start. Allow Meeting Wiki in System Settings, Privacy & Security, Microphone, then reopen this window.",
  };

  const SYSTEM_AUDIO_NOTE = "Other participants are captured from all audio played on this Mac. macOS controls this with the System Audio Recording permission, which Meeting Wiki cannot check in advance. If participants were silent in an earlier recording, allow Meeting Wiki there.";

  async function call(method, ...args) {
    if (!bridge || typeof bridge[method] !== "function") {
      return { error: "The recording window cannot reach the app. Close it and use the menu bar again." };
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

  function setLine(id, text, attention) {
    const node = $(id);
    node.textContent = text;
    node.dataset.tone = attention ? "attention" : "";
  }

  function destinationName(current) {
    if (current.destination === "gemini") return t("Google Gemini");
    if (current.destination === "openai_compatible") return current.host || t("your online provider");
    return t("the providers in your configuration");
  }

  function permissionPart(label, status) {
    const note = Object.prototype.hasOwnProperty.call(PERMISSION, status) ? PERMISSION[status] : PERMISSION.unknown;
    return note ? t("{label} ({note})", { label, note: t(note) }) : label;
  }

  function privacyMode() {
    const selected = document.querySelector('input[name="privacy"]:checked');
    return selected && (selected.value === "private" || selected.value === "shared")
      ? selected.value
      : "";
  }

  function isPrivate() {
    return privacyMode() === "private";
  }

  function liveEnabled() {
    return $("record-live-enabled").checked;
  }

  function render() {
    if (!context) return;
    const blockers = Array.isArray(context.blockers) ? context.blockers.filter((code) => Object.prototype.hasOwnProperty.call(BLOCKERS, code)) : [];
    const systemBlocked = blockers.length > 0 || !Array.isArray(context.blockers);
    const privacyMissing = context.formMode === "initial" && !privacyMode();
    const micBlocked = blockers.includes("microphone_blocked");
    setLine(
      "record-capture",
      t("{microphone} and all audio played on this Mac, including other participants.", {
        microphone: permissionPart(t("Your microphone"), context.microphone),
      }),
      micBlocked,
    );
    setLine("record-system-audio", t(SYSTEM_AUDIO_NOTE), false);
    $("record-blockers-text").textContent = joinParts(blockers.map((code) => t(BLOCKERS[code])))
      || (systemBlocked ? t(BLOCKERS.setup_incomplete) : "");
    $("record-blockers").hidden = !systemBlocked;
    $("record-open-setup").hidden = !(blockers.includes("setup_incomplete") || (systemBlocked && blockers.length === 0));
    $("record-open-microphone").hidden = !micBlocked;

    const where = destinationName(context);
    const notes = isPrivate() ? "Private notes stay in the private folder on this Mac." : "Notes go to your shared wiki on this Mac.";
    setLine("record-processing", joinParts([t("After you stop, audio is processed by {where}.", { where }), t(notes)]), false);

    const minutes = Number.isInteger(context.maxDurationMinutes) ? context.maxDurationMinutes : 0;
    setLine(
      "record-duration",
      minutes
        ? t("Recording stops on its own after {minutes} minutes and is processed like a normal stop. Change this in Settings.", { minutes })
        : t("The length limit could not be read."),
      !minutes,
    );

    const parts = !liveEnabled()
      ? ["Off for this recording. Batch processing still runs after you stop."]
      : [...(Object.prototype.hasOwnProperty.call(LIVE, context.live) ? LIVE[context.live] : LIVE.manual)];
    const live = parts.map((part) => t(part));
    if (liveEnabled() && context.live === "ready") {
      const sent = isPrivate()
        ? "Microphone audio and all audio played on this Mac are sent to {where} for captions, including for this private meeting."
        : "Microphone audio and all audio played on this Mac are sent to {where} for captions.";
      live.push(context.liveScope === "external" ? t(sent, { where }) : t("They run on this Mac."));
    }
    setLine("record-live", joinParts(live), context.live === "engine_missing" || context.live === "key_unavailable");
    $("record-details").setAttribute("aria-busy", "false");

    const start = $("record-start");
    if (context.recording) {
      start.disabled = true;
      setStatus("A recording is already running. Stop it from the menu bar first.", "error");
    } else {
      start.disabled = systemBlocked || privacyMissing;
      if (privacyMissing) setStatus("Choose where the notes go before starting.", "error");
      else if (statusKey === "Choose where the notes go before starting.") setStatus("", "");
    }
  }

  // Errors from the main process can join fixed sentences, so each is looked up on its own.
  function setStatus(message, tone) {
    statusKey = message;
    const node = $("record-status");
    const whole = t(message);
    node.textContent = whole !== message || !message
      ? whole
      : joinParts(message.split(/(?<=\.)\s+/).map((sentence) => t(sentence)));
    node.dataset.tone = tone || "";
  }

  function showTitleError(message) {
    const input = $("record-title");
    const node = $("record-title-error");
    node.textContent = message ? t(message) : "";
    node.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  async function onStart(event) {
    event.preventDefault();
    if (busy || !context || context.recording || $("record-start").disabled) return;
    const title = $("record-title").value.replace(/\s+/gu, " ").trim();
    if ([...title].length > TITLE_MAX) {
      showTitleError(t("Keep the title to {max} characters or fewer.", { max: TITLE_MAX }));
      $("record-title").focus();
      return;
    }
    const selectedPrivacy = privacyMode();
    if (!selectedPrivacy) {
      setStatus("Choose where the notes go before starting.", "error");
      return;
    }
    showTitleError("");
    busy = true;
    const button = $("record-start");
    button.setAttribute("aria-disabled", "true");
    setStatus(isPrivate() ? "Starting a private recording." : "Starting the recording.", "");
    const result = await call("start", { title, privacyMode: selectedPrivacy, liveEnabled: liveEnabled() });
    busy = false;
    button.removeAttribute("aria-disabled");
    const message = errorOf(result);
    if (message) {
      setStatus(message, "error");
      if (/title/i.test(message)) $("record-title").focus();
    }
  }

  async function init() {
    if (!bridge) $("bridge-missing").hidden = false;
    $("record-form").addEventListener("submit", onStart);
    $("record-cancel").addEventListener("click", () => { void call("cancel"); });
    const open = async (method, ...args) => {
      const message = errorOf(await call(method, ...args));
      if (message) setStatus(message, "error");
    };
    $("record-open-setup").addEventListener("click", () => { void open("openSetup"); });
    $("record-open-microphone").addEventListener("click", () => { void open("openPrivacySettings", "microphone"); });
    $("record-open-system-audio").addEventListener("click", () => { void open("openPrivacySettings", "systemAudio"); });
    for (const radio of document.querySelectorAll('input[name="privacy"]')) radio.addEventListener("change", render);
    $("record-live-enabled").addEventListener("change", render);
    $("record-title").addEventListener("input", () => showTitleError(""));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") void call("cancel");
    });
    $("record-start").focus();
    const result = await call("getContext");
    const message = errorOf(result);
    if (message || !result || typeof result !== "object") {
      setStatus(message || "The recording details could not be read.", "error");
      $("record-start").disabled = true;
      return;
    }
    context = result;
    if (localization) localization.applyRecordLocale(document, context.uiLanguage, navigator.language);
    const defaults = context.defaults && typeof context.defaults === "object" ? context.defaults : {};
    if (context.formMode !== "initial") {
      $(defaults.privacyMode === "private" ? "record-private" : "record-shared").checked = true;
    }
    $("record-live-enabled").checked = context.liveStarts === true && defaults.liveEnabled === true;
    $("record-live-enabled").disabled = context.liveStarts !== true;
    if (context.formMode === "initial") {
      $("record-heading").textContent = t("Choose recording defaults");
      $("record-intro").textContent = t("Choose once. Future starts use these defaults until you change them in Settings.");
      document.title = t("Choose recording defaults");
    }
    render();
    $("record-start").focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
