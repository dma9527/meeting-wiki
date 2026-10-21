"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { AutoRecordCoordinator, MIN_PROCESSED_MS, integrationTitle } = require("../auto-record");

function coordinator({ idle = true, started = true, elapsed = 60_000 } = {}) {
  const calls = [];
  const state = { idle, elapsed };
  const instance = new AutoRecordCoordinator({
    canStart: () => state.idle,
    start: async (request) => { calls.push(["start", request]); return started; },
    stop: async () => { calls.push(["stop"]); },
    discard: async () => { calls.push(["discard"]); },
    elapsedMs: () => state.elapsed,
  });
  return { instance, calls, state };
}

test("join starts the normal recording with the integration title and join time", async () => {
  const { instance, calls } = coordinator();
  assert.equal(await instance.join("zoom", { joinedAt: Date.UTC(2026, 0, 2, 3, 4, 5) }), true);
  assert.deepEqual(calls, [["start", { title: "Zoom meeting", source: "zoom", occurredAt: "2026-01-02T03:04:05.000Z" }]]);
  assert.equal(instance.owner, "zoom");
});

test("leave stops and processes only the recording this source started", async () => {
  const { instance, calls } = coordinator();
  await instance.join("google-meet", { meetingCode: "abc-defg-hij" });
  assert.equal(await instance.leave("zoom"), null);
  assert.equal(await instance.leave("google-meet"), "processed");
  assert.deepEqual(calls.map(([name]) => name), ["start", "stop"]);
  assert.equal(await instance.leave("google-meet"), null);
});

test("a meeting of 10 seconds or less is discarded instead of processed", async () => {
  for (const elapsed of [0, 9_999, MIN_PROCESSED_MS]) {
    const { instance, calls } = coordinator({ elapsed });
    await instance.join("zoom");
    assert.equal(await instance.leave("zoom"), "discarded");
    assert.deepEqual(calls.map(([name]) => name), ["start", "discard"]);
  }
  const { instance, calls } = coordinator({ elapsed: MIN_PROCESSED_MS + 1 });
  await instance.join("zoom");
  assert.equal(await instance.leave("zoom"), "processed");
  assert.deepEqual(calls.map(([name]) => name), ["start", "stop"]);
});

test("a manual recording, a second integration, or a failed start is never taken over", async () => {
  const busy = coordinator({ idle: false });
  assert.equal(await busy.instance.join("zoom"), false);
  assert.deepEqual(busy.calls, []);

  const both = coordinator();
  await both.instance.join("zoom");
  assert.equal(await both.instance.join("google-meet"), false);
  assert.equal(await both.instance.leave("google-meet"), null);
  assert.equal(both.calls.length, 1);

  const failed = coordinator({ started: false });
  assert.equal(await failed.instance.join("zoom"), false);
  assert.equal(failed.instance.owner, null);
});

test("a user stop releases ownership so the later leave does nothing", async () => {
  const { instance, calls } = coordinator();
  await instance.join("zoom");
  instance.release();
  assert.equal(await instance.leave("zoom"), null);
  assert.deepEqual(calls.map(([name]) => name), ["start"]);
  await instance.join("zoom");
  instance.release("google-meet");
  assert.equal(instance.owner, "zoom");
});

test("integration titles carry only the source and the Meet code", () => {
  assert.equal(integrationTitle("zoom"), "Zoom meeting");
  assert.equal(integrationTitle("google-meet", { meetingCode: "abc-defg-hij" }), "Google Meet abc-defg-hij");
  assert.equal(integrationTitle("google-meet"), "Google Meet meeting");
});

test("main routes integration starts through startRecording with no countdown", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /start: \(request\) => startRecording\(request\)/);
  assert.match(main, /stop: \(\) => stopRecording\("integration"\)/);
  assert.match(main, /await discardRecording\(\);\s*notify\(SHORT_DISCARD_NOTICE\.title, SHORT_DISCARD_NOTICE\.body\)/);
  assert.doesNotMatch(main, /countdown|setTimeout\([^)]*startRecording/i);
  const stopBody = main.slice(main.indexOf("function stopRecording"), main.indexOf("function discardRecording"));
  assert.match(stopBody, /autoRecord\.release\(\);/);
  const discardBody = main.slice(main.indexOf("function discardRecording"), main.indexOf("function importConfirmation"));
  assert.match(discardBody, /autoRecord\.release\(\);/);
  assert.match(main, /if \(occurredAt\) args\.push\("--occurred-at", occurredAt\);/);
});
