"use strict";

// Maps integration join/leave signals onto the normal recording lifecycle. It starts a recording
// only when nothing is recording, and stops only the recording it started. A user stop, the time
// limit, or quit releases ownership, so a later leave never touches a recording it did not start.
// On leave the recording is saved and processed, unless it lasted 10 s or less, which is discarded.

const SOURCES = Object.freeze({
  zoom: Object.freeze({ id: "zoom", label: "Zoom" }),
  googleMeet: Object.freeze({ id: "google-meet", label: "Google Meet" }),
});
const MIN_PROCESSED_MS = 10_000;
const AUTO_LIVE_DELAY_MS = MIN_PROCESSED_MS + 1_000;
const SHORT_DISCARD_NOTICE = Object.freeze({
  title: "Short meeting not kept",
  body: "The meeting ended within 10 seconds, so the recording was discarded and not processed.",
});

function integrationTitle(source, { meetingCode = null } = {}) {
  if (source === SOURCES.googleMeet.id) return meetingCode ? `Google Meet ${meetingCode}` : "Google Meet meeting";
  return "Zoom meeting";
}

class AutoLiveStartGate {
  constructor({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.token = null;
  }

  get pending() {
    return this.token !== null;
  }

  schedule(start) {
    if (typeof start !== "function") return false;
    this.cancel();
    const token = {};
    const run = () => {
      if (this.token !== token) return;
      this.token = null;
      start();
    };
    token.timer = this.setTimer(run, AUTO_LIVE_DELAY_MS);
    this.token = token;
    if (token.timer && typeof token.timer.unref === "function") token.timer.unref();
    return true;
  }

  cancel() {
    const token = this.token;
    this.token = null;
    if (token && token.timer) this.clearTimer(token.timer);
  }
}

class AutoRecordCoordinator {
  constructor({ canStart, start, stop, discard, elapsedMs }) {
    this.canStart = canStart;
    this.startRecording = start;
    this.stopRecording = stop;
    this.discardRecording = discard;
    this.elapsedMs = elapsedMs;
    this.owner = null;
  }

  // Returns true when a recording was started for this source.
  async join(source, { meetingCode = null, joinedAt = null } = {}) {
    if (this.owner !== null || !this.canStart()) return false;
    const occurredAt = Number.isFinite(joinedAt) ? new Date(joinedAt).toISOString() : null;
    const started = await this.startRecording({
      title: integrationTitle(source, { meetingCode }),
      source,
      occurredAt,
    });
    if (started) this.owner = source;
    return Boolean(started);
  }

  // Returns "processed", "discarded", or null when this source did not own the recording.
  async leave(source) {
    if (this.owner !== source) return null;
    this.owner = null;
    if (this.elapsedMs() <= MIN_PROCESSED_MS) {
      await this.discardRecording();
      return "discarded";
    }
    await this.stopRecording();
    return "processed";
  }

  // Called whenever a recording ends for any reason, and when a source is turned off.
  release(source = null) {
    if (source === null || this.owner === source) this.owner = null;
  }
}

module.exports = {
  AUTO_LIVE_DELAY_MS,
  AutoLiveStartGate,
  AutoRecordCoordinator,
  MIN_PROCESSED_MS,
  SHORT_DISCARD_NOTICE,
  SOURCES,
  integrationTitle,
};
