"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  IngestTracker,
  LIMIT_NOTICE,
  QUIT_NOTICE,
  RecordingSession,
  formatDuration,
  recordingLabel,
} = require("../recording-session");

function fakeClock() {
  const timers = new Map();
  let nextId = 1;
  let current = 1_000;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    setTimer: (callback, ms) => { const id = nextId++; timers.set(id, { callback, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fire: () => { for (const [id, { callback }] of [...timers]) { timers.delete(id); callback(); } },
    timers,
  };
}

function sessionWith(clock, onLimit = () => {}) {
  return new RecordingSession({ onLimit, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("begin arms one timer for the configured limit and rejects overlapping sessions", () => {
  const clock = fakeClock();
  const session = sessionWith(clock);
  session.begin(120 * 60_000);
  assert.equal(session.recording, true);
  assert.deepEqual([...clock.timers.values()].map(({ ms }) => ms), [7_200_000]);
  assert.throws(() => session.begin(60_000), /already in progress/);
  assert.throws(() => new RecordingSession().begin(0), /invalid maximum duration/);
});

test("the limit timer fires onLimit once while recording", () => {
  const clock = fakeClock();
  let fired = 0;
  const session = sessionWith(clock, () => { fired += 1; });
  session.begin(60_000);
  clock.fire();
  assert.equal(fired, 1);
});

test("checkDeadline stops a recording whose timer was delayed by sleep", () => {
  const clock = fakeClock();
  let fired = 0;
  const session = sessionWith(clock, () => { fired += 1; });
  session.begin(60_000);
  clock.advance(59_999);
  session.checkDeadline();
  assert.equal(fired, 0);
  clock.advance(1);
  session.checkDeadline();
  assert.equal(fired, 1);
});

test("limit, user, and quit stops race into one stop that runs its work exactly once", async () => {
  const clock = fakeClock();
  const session = sessionWith(clock);
  session.begin(60_000);
  const gate = deferred();
  const reasons = [];
  const work = async (reason) => { reasons.push(reason); await gate.promise; };
  const fromLimit = session.end("limit", work);
  const fromUser = session.end("user", work);
  const fromQuit = session.end("quit", work);
  const fromDiscard = session.end("discard", work);
  assert.equal(session.stopping, true);
  assert.equal(clock.timers.size, 0, "the limit timer is cleared once a stop begins");
  assert.equal(fromUser, fromLimit);
  assert.equal(fromQuit, fromLimit);
  assert.equal(fromDiscard, fromLimit, "a discard during a stop never deletes the recording");
  gate.resolve();
  assert.deepEqual(await Promise.all([fromLimit, fromUser, fromQuit, fromDiscard]), [true, true, true, true]);
  assert.deepEqual(reasons, ["limit"]);
  assert.equal(session.idle, true);
  assert.equal(session.lastStopReason, "limit");
  assert.equal(await session.end("user", work), false, "a late stop after completion is a no-op");
  assert.deepEqual(reasons, ["limit"]);
});

test("a timer that fires after a user stop does nothing", async () => {
  const clock = fakeClock();
  let fired = 0;
  const session = sessionWith(clock, () => { fired += 1; });
  session.begin(60_000);
  const gate = deferred();
  const stop = session.end("user", () => gate.promise);
  session.fireLimit();
  session.checkDeadline();
  gate.resolve();
  await stop;
  session.fireLimit();
  assert.equal(fired, 0);
  assert.equal(session.lastStopReason, "user");
});

test("a failing stop still returns the session to idle so the next recording can start", async () => {
  const clock = fakeClock();
  const session = sessionWith(clock);
  session.begin(60_000);
  await assert.rejects(session.end("limit", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(session.idle, true);
  session.begin(60_000);
  assert.equal(session.recording, true);
});

test("the tray label shows elapsed time against the limit", () => {
  const clock = fakeClock();
  const session = sessionWith(clock);
  session.begin(120 * 60_000);
  clock.advance(65 * 60_000 + 3_000);
  assert.equal(recordingLabel(session), "Recording 1:05:03 of 2:00:00");
  assert.equal(formatDuration(59_999), "0:59");
  assert.equal(formatDuration(-5), "0:00");
});

test("limit and quit notices are fixed text with no titles, paths, or names", () => {
  for (const notice of [LIMIT_NOTICE, QUIT_NOTICE]) {
    assert.ok(Object.isFrozen(notice));
    assert.doesNotMatch(`${notice.title} ${notice.body}`, /\/|\$\{|\.wav/);
  }
});

test("IngestTracker drains when every ingest exits and reports a timeout otherwise", async () => {
  const tracker = new IngestTracker();
  assert.equal(await tracker.drain(10), true);
  const first = new EventEmitter();
  const second = new EventEmitter();
  tracker.track(first);
  tracker.track(second);
  assert.equal(tracker.size, 2);
  const waiting = tracker.drain(5_000);
  first.emit("exit", 0);
  second.emit("error", new Error("spawn failed"));
  assert.equal(await waiting, true);
  assert.equal(tracker.size, 0);
  tracker.track(new EventEmitter());
  assert.equal(await tracker.drain(5), false);
});
