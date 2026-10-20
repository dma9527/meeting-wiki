"use strict";

// Live sidebar renderer. It receives display events only through window.meetingWikiLive
// and writes every dynamic value with textContent.
//
// Expected bridge (implemented by live-sidebar-preload.js):
//   subscribe(callback)  callback({ type: "state" | "transcript" | "translation" | "summary", ... })
//   unsubscribe()

(function liveSidebar() {
  const bridge = window.meetingWikiLive;
  const $ = (id) => document.getElementById(id);
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
    provider_unavailable: "The live provider is not ready. Check system health in the menu.",
    transcription_error: "Live transcription skipped a moment of audio.",
    language_error: "Translation or summary is temporarily unavailable.",
    startup_failed: "Live view could not start.",
    connection_lost: "Live view lost its connection.",
  });
  const lines = new Map();

  function setState(event) {
    $("live-status").textContent = PHASE_TEXT[event.phase] || "";
    $("live-private").hidden = !event.private;
    const scope = $("live-scope");
    scope.hidden = !event.scope;
    scope.textContent = event.scope === "external" ? "External provider" : "Local only";
    scope.classList.toggle("live-badge-external", event.scope === "external");
    const issue = $("live-issue");
    const message = ISSUE_TEXT[event.issue] || "";
    issue.hidden = !message;
    issue.textContent = message;
    if (event.phase === "starting") reset();
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
    const original = document.createElement("p");
    original.className = "live-original";
    const translation = document.createElement("p");
    translation.className = "live-translation";
    translation.hidden = true;
    item.append(original, translation);
    $("live-transcript").append(item);
    entry = { item, original, translation };
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

  function handle(event) {
    if (event.type === "state") setState(event);
    else if (event.type === "transcript") lineFor(event.sequence).original.textContent = event.text;
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
