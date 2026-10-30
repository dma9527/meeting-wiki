"use strict";

// Live sidebar renderer. It receives display events only through window.meetingWikiLive
// and writes every dynamic value with textContent.
//
// Expected bridge (implemented by live-sidebar-preload.js):
//   subscribe(callback)  callback({ type: "state" | "transcript" | "translation" | "summary", ... })
//   unsubscribe()

(function liveSidebar() {
  const bridge = window.meetingWikiLive;
  const localization = window.meetingWikiLiveLocalization;
  const $ = (id) => document.getElementById(id);
  let locale = "system";
  let lastState = null;

  function t(message) {
    return localization ? localization.translateLiveMessage(message, locale, navigator.language) : message;
  }
  const MAX_LINES = 40;
  const PHASE_TEXT = Object.freeze({
    starting: "Starting live view.",
    listening: "Listening.",
    stopped: "Live view stopped.",
    unavailable: "Live view is unavailable. Recording continues normally.",
  });
  const ISSUE_TEXT = Object.freeze({
    audio_unavailable: "The recording audio is no longer available.",
    audio_unsupported: "The recording audio format is not supported for live view.",
    provider_unavailable: "The live provider is not ready. Run self-check from the menu bar.",
    transcription_error: "Live transcription skipped a moment of audio.",
    transcription_failed: "Live transcription could not connect to the provider. Recording continues normally.",
    provider_reconnecting: "Reconnecting to the live provider. Recording continues normally.",
    microphone_unavailable: "Your microphone is no longer captioned. Other participants still are.",
    system_audio_unavailable: "Other participants are no longer captioned. Your microphone still is.",
    system_audio_silent: "No audio from other participants yet. If they are speaking, check System Audio Recording permission in System Settings.",
    language_error: "Translation or summary is temporarily unavailable.",
    provider_session_renewing: "Renewing the live provider session. Recording continues normally.",
    provider_session_expired: "The live provider session expired and could not be renewed.",
    startup_failed: "Live view could not start.",
    connection_lost: "Live view lost its connection.",
  });
  const SPEAKER_TEXT = Object.freeze({ you: "You", others: "Others" });
  const lines = new Map();

  function setState(event) {
    renderState(event);
    if (event.phase === "starting") reset();
  }

  function renderState(event) {
    lastState = event;
    $("live-status").textContent = t(PHASE_TEXT[event.phase] || "");
    $("live-status").dataset.phase = event.phase || "";
    $("live-private").hidden = !event.private;
    const scope = $("live-scope");
    scope.hidden = !event.scope;
    scope.textContent = t(event.scope === "external" ? "External provider" : "Local only");
    scope.classList.toggle("live-badge-external", event.scope === "external");
    const issue = $("live-issue");
    const message = ISSUE_TEXT[event.issue] || "";
    issue.hidden = !message;
    issue.textContent = t(message);
  }

  function reset() {
    lines.clear();
    $("live-transcript").replaceChildren();
    $("live-summary").replaceChildren();
    $("live-transcript-empty").hidden = false;
    $("live-summary-empty").hidden = false;
  }

  function lineFor(sequence) {
    let entry = lines.get(sequence);
    if (entry) return entry;
    const item = document.createElement("li");
    item.className = "live-line";
    const speaker = document.createElement("p");
    speaker.className = "live-speaker";
    speaker.hidden = true;
    const original = document.createElement("p");
    original.className = "live-original";
    const translation = document.createElement("p");
    translation.className = "live-translation";
    translation.hidden = true;
    item.append(speaker, original, translation);
    $("live-transcript").append(item);
    entry = { item, speaker, original, translation };
    lines.set(sequence, entry);
    while (lines.size > MAX_LINES) {
      const [oldest] = lines.keys();
      lines.get(oldest).item.remove();
      lines.delete(oldest);
    }
    $("live-transcript-empty").hidden = true;
    return entry;
  }

  function setSummary(points) {
    const list = $("live-summary");
    list.replaceChildren(
      ...points.filter(Boolean).map((point) => {
        const item = document.createElement("li");
        item.textContent = point;
        return item;
      }),
    );
    $("live-summary-empty").hidden = list.childElementCount > 0;
  }

  // The saved UI language arrives first after load; re-render without clearing captions.
  function setLocale(choice) {
    locale = choice;
    if (localization) localization.applyLiveLocale(document, choice, navigator.language);
    for (const entry of lines.values()) {
      const speaker = entry.item.dataset.speaker;
      if (SPEAKER_TEXT[speaker]) entry.speaker.textContent = t(SPEAKER_TEXT[speaker]);
    }
    if (lastState) renderState(lastState);
    else $("live-status").textContent = t(PHASE_TEXT.starting);
  }

  function handle(event) {
    if (event.type === "locale") setLocale(event.uiLanguage);
    else if (event.type === "state") setState(event);
    else if (event.type === "transcript") {
      const entry = lineFor(event.sequence);
      entry.original.textContent = event.text;
      const label = SPEAKER_TEXT[event.speaker] || "";
      entry.speaker.textContent = t(label);
      entry.speaker.hidden = !label;
      entry.item.dataset.speaker = label ? event.speaker : "";
    }
    else if (event.type === "translation") {
      const entry = lines.get(event.sequence);
      if (!entry) return;
      entry.translation.textContent = event.text;
      entry.translation.hidden = !event.text;
    } else if (event.type === "summary") setSummary(event.points);
  }

  if (!bridge || typeof bridge.subscribe !== "function") {
    setState({ phase: "unavailable", issue: "startup_failed" });
    return;
  }
  bridge.subscribe(handle);
  window.addEventListener("beforeunload", () => bridge.unsubscribe());
})();
