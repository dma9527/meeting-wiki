"use strict";

// Recording confirmation renderer. It talks to the main process only through
// window.meetingWikiRecord and writes every dynamic value with textContent.
//
// Expected bridge (implemented by record-preload.js):
//   getContext() -> { maxDurationMinutes, microphone, systemAudio, destination, host, live, liveScope, recording } | { error }
//   start({ title, private }) -> { ok: true } | { error }
//   cancel() -> { ok: true }

(function recordPanel() {
  const bridge = window.meetingWikiRecord;
  const $ = (id) => document.getElementById(id);
  const TITLE_MAX = 200;
  let busy = false;
  let context = null;

  const PERMISSION = {
    granted: "",
    denied: "blocked in System Settings",
    restricted: "restricted by a device policy",
    "not-determined": "macOS asks when recording starts",
    unknown: "status not reported",
  };

  const LIVE = {
    ready: "Live captions start with the recording. They are display-only and never change saved notes.",
    no_adapter: "Not available with this provider. The recording is still processed after you stop.",
    engine_missing: "Unavailable because the Meeting Wiki engine is missing. Reinstall the app.",
    key_unavailable: "Unavailable because the API key could not be read. Run setup again. The audio is still saved.",
    manual: "Start if your hand-edited configuration supports them.",
  };

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
    if (current.destination === "gemini") return "Google Gemini";
    if (current.destination === "openai_compatible") return current.host || "your online provider";
    return "the providers in your configuration";
  }

  function permissionPart(label, status) {
    const note = Object.prototype.hasOwnProperty.call(PERMISSION, status) ? PERMISSION[status] : PERMISSION.unknown;
    return note ? `${label} (${note})` : label;
  }

  function isPrivate() {
    return $("record-private").checked;
  }

  function render() {
    if (!context) return;
    const blocked = context.microphone === "denied" || context.microphone === "restricted";
    const silent = context.systemAudio === "denied" || context.systemAudio === "restricted";
    const capture = [
      `${permissionPart("Your microphone", context.microphone)} and ${permissionPart("system audio from the other participants", context.systemAudio)}.`,
    ];
    if (silent) capture.push("Remote participants will be silent.");
    setLine("record-capture", capture.join(" "), blocked || silent);

    const where = destinationName(context);
    const notes = isPrivate() ? "Private notes stay in the private folder on this Mac." : "Notes go to your shared wiki on this Mac.";
    setLine("record-processing", `After you stop, audio is processed by ${where}. ${notes}`, false);

    const minutes = Number.isInteger(context.maxDurationMinutes) ? context.maxDurationMinutes : 0;
    setLine(
      "record-duration",
      minutes
        ? `Recording stops on its own after ${minutes} minutes and is processed like a normal stop. Change this in Settings.`
        : "The length limit could not be read.",
      !minutes,
    );

    let live = Object.prototype.hasOwnProperty.call(LIVE, context.live) ? LIVE[context.live] : LIVE.manual;
    if (context.live === "ready") {
      live += context.liveScope === "external"
        ? ` Microphone audio is sent to ${where} for captions${isPrivate() ? ", including for this private meeting" : ""}.`
        : " They run on this Mac.";
    }
    setLine("record-live", live, context.live === "engine_missing" || context.live === "key_unavailable");
    $("record-details").setAttribute("aria-busy", "false");

    const start = $("record-start");
    if (context.recording) {
      start.disabled = true;
      setStatus("A recording is already running. Stop it from the menu bar first.", "error");
    } else {
      start.disabled = false;
    }
  }

  function setStatus(message, tone) {
    const node = $("record-status");
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  function showTitleError(message) {
    const input = $("record-title");
    const node = $("record-title-error");
    node.textContent = message;
    node.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  async function onStart(event) {
    event.preventDefault();
    if (busy || !context || context.recording) return;
    const title = $("record-title").value.replace(/\s+/gu, " ").trim();
    if ([...title].length > TITLE_MAX) {
      showTitleError(`Keep the title to ${TITLE_MAX} characters or fewer.`);
      $("record-title").focus();
      return;
    }
    showTitleError("");
    busy = true;
    const button = $("record-start");
    button.setAttribute("aria-disabled", "true");
    setStatus(isPrivate() ? "Starting a private recording." : "Starting the recording.", "");
    const result = await call("start", { title, private: isPrivate() });
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
    for (const radio of document.querySelectorAll('input[name="privacy"]')) radio.addEventListener("change", render);
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
    render();
    $("record-start").focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
