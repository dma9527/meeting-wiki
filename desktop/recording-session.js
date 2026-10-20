"use strict";

// Single-flight lifecycle for one recording. The duration limit, the user, and quit all call
// end(); whichever arrives first runs its work and the others share that same promise.

const LIMIT_NOTICE = Object.freeze({
  title: "Recording stopped at the time limit",
  body: "The maximum meeting length was reached. Your recording is being saved and processed.",
});
const QUIT_NOTICE = Object.freeze({
  title: "Saving your recording",
  body: "Meeting Wiki will quit after the recording is saved and queued.",
});
const SAVING_LABEL = "Saving recording...";
const LIMIT_REACHED_LABEL = "Last recording stopped at the time limit";

class RecordingSession {
  constructor({ onLimit, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.onLimit = onLimit || (() => {});
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = "idle";
    this.startedAt = null;
    this.deadline = null;
    this.timer = null;
    this.pending = null;
    this.lastStopReason = null;
  }

  get idle() { return this.state === "idle"; }
  get recording() { return this.state === "recording"; }
  get stopping() { return this.state === "stopping"; }

  begin(maxDurationMs) {
    if (!this.idle) throw new Error("recording session already in progress");
    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new Error("invalid maximum duration");
    this.state = "recording";
    this.startedAt = this.now();
    this.deadline = this.startedAt + maxDurationMs;
    this.lastStopReason = null;
    this.timer = this.setTimer(() => this.fireLimit(), maxDurationMs);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  // Wall-clock backstop for timers delayed by sleep; safe to call on every tick.
  checkDeadline() {
    if (this.recording && this.now() >= this.deadline) this.fireLimit();
  }

  fireLimit() {
    if (this.recording) this.onLimit();
  }

  elapsedMs() {
    return this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt);
  }

  limitMs() {
    return this.deadline === null ? 0 : this.deadline - this.startedAt;
  }

  // Runs work(reason) at most once per recording. Later callers get the in-flight promise.
  end(reason, work) {
    if (this.stopping) return this.pending;
    if (!this.recording) return Promise.resolve(false);
    this.state = "stopping";
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = (async () => {
      try {
        await work(reason);
        return true;
      } finally {
        this.lastStopReason = reason;
        this.state = "idle";
        this.startedAt = null;
        this.deadline = null;
        this.pending = null;
      }
    })();
    return this.pending;
  }
}

// Tracks ingest child processes so quit can wait for queued recordings to reach the job store.
class IngestTracker {
  constructor() {
    this.pending = new Set();
  }

  get size() { return this.pending.size; }

  track(child) {
    const done = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    this.pending.add(done);
    done.then(() => this.pending.delete(done));
    return done;
  }

  // Resolves true when every tracked ingest exited, false when the timeout elapsed first.
  drain(timeoutMs, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (this.pending.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimer(() => resolve(false), timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      Promise.all([...this.pending]).then(() => {
        clearTimer(timer);
        resolve(true);
      });
    });
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function recordingLabel(session) {
  return `Recording ${formatDuration(session.elapsedMs())} of ${formatDuration(session.limitMs())}`;
}

module.exports = {
  IngestTracker,
  LIMIT_NOTICE,
  LIMIT_REACHED_LABEL,
  QUIT_NOTICE,
  RecordingSession,
  SAVING_LABEL,
  formatDuration,
  recordingLabel,
};
