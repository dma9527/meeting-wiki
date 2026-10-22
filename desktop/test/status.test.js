"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatQueueLabel,
  readQueueStatus,
  retryDeadJobs,
} = require("../status");

function fakeExec(responses, calls) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    const response = responses.shift();
    process.nextTick(() => callback(response.error || null, response.stdout || "", response.stderr || ""));
  };
}

test("queue labels prioritize action required over active work", () => {
  assert.equal(formatQueueLabel({ total: 0, active: 0, action_required: 0 }), "No meetings yet");
  assert.equal(
    formatQueueLabel({
      total: 3,
      active: 2,
      action_required: 0,
      stages: { transcribing: 1, analyzing: 1, rendering: 0, integrating: 0 },
    }),
    "Processing: 2 (transcribing, analyzing)",
  );
  assert.equal(formatQueueLabel({ total: 3, active: 1, action_required: 2 }), "Action required: 2 failed");
  assert.equal(formatQueueLabel({ total: 3, active: 0, action_required: 0 }), "All meetings processed");
});

test("readQueueStatus invokes privacy-safe summary", async () => {
  const calls = [];
  const execFile = fakeExec([
    { stdout: JSON.stringify({ total: 2, pending: 1, running: 0, failed: 0, dead: 0, done: 1, active: 1, action_required: 0 }) },
  ], calls);

  const status = await readQueueStatus("/python", "/config.toml", execFile);

  assert.equal(status.active, 1);
  assert.deepEqual(calls[0].args, [
    "-m", "meeting_wiki.cli", "--config", "/config.toml", "status", "--summary",
  ]);
});

test("retryDeadJobs fetches redacted rows and retries each id", async () => {
  const calls = [];
  const execFile = fakeExec([
    { stdout: JSON.stringify([
      { id: 4, job_type: "ingest", state: "dead", stage: "analyzing", attempts: 5, max_attempts: 5, error_type: "RuntimeError" },
      { id: 9, job_type: "ingest", state: "dead", stage: "rendering", attempts: 5, max_attempts: 5, error_type: "RuntimeError" },
    ]) },
    { stdout: JSON.stringify({ job_id: 4, state: "pending", retried: true }) },
    { stdout: JSON.stringify({ job_id: 9, state: "pending", retried: true }) },
  ], calls);

  assert.equal(await retryDeadJobs("/python", "/config.toml", execFile), 2);
  assert.deepEqual(calls.slice(1).map(({ args }) => args.at(-1)), ["4", "9"]);
  assert.equal(calls[0].args.includes("--verbose"), false);
});

test("status helpers pass an optional per-child env to every CLI call", async () => {
  const env = { PATH: "/usr/bin", CHILD_ONLY: "1" };
  const calls = [];
  const execFile = fakeExec([
    { stdout: JSON.stringify({ total: 0, active: 0, action_required: 0 }) },
    { stdout: JSON.stringify([{ id: 4, job_type: "ingest", state: "dead", stage: "analyzing", attempts: 5, max_attempts: 5, error_type: "RuntimeError" }]) },
    { stdout: JSON.stringify({ job_id: 4, state: "pending", retried: true }) },
  ], calls);

  await readQueueStatus("/python", "/config.toml", execFile, env);
  assert.equal(await retryDeadJobs("/python", "/config.toml", execFile, env), 1);

  assert.equal(calls.length, 3);
  for (const { options } of calls) assert.equal(options.env, env);
});

test("status helpers inherit the parent env when none is given", async () => {
  const calls = [];
  const execFile = fakeExec([
    { stdout: JSON.stringify({ total: 0, active: 0, action_required: 0 }) },
    { stdout: JSON.stringify([]) },
  ], calls);

  await readQueueStatus("/python", "/config.toml", execFile);
  await retryDeadJobs("/python", "/config.toml", execFile);

  for (const { options } of calls) assert.equal("env" in options, false);
});


test("tray icon state reflects recording, attention, processing, and idle priority", () => {
  const { trayIconState } = require("../status");

  assert.equal(
    trayIconState({ isRecording: true, queueStatusError: true, queueSummary: { active: 1, action_required: 1 } }),
    "recording",
  );
  assert.equal(
    trayIconState({ isRecording: false, queueStatusError: true, queueSummary: { active: 1, action_required: 0 } }),
    "attention",
  );
  assert.equal(
    trayIconState({ isRecording: false, queueStatusError: false, queueSummary: { active: 0, action_required: 1 } }),
    "attention",
  );
  assert.equal(
    trayIconState({ isRecording: false, queueStatusError: false, queueSummary: { active: 1, action_required: 0 } }),
    "processing",
  );
  assert.equal(
    trayIconState({ isRecording: false, queueStatusError: false, queueSummary: { active: 0, action_required: 0 } }),
    "idle",
  );
});

test("worker restart backoff doubles to a bounded ceiling and resets after recovery", () => {
  const { RestartBackoff } = require("../status");
  const backoff = new RestartBackoff({ baseMs: 1_000, maxMs: 8_000 });
  const delays = Array.from({ length: 6 }, () => backoff.nextDelayMs());
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  for (let index = 0; index < 2_000; index += 1) backoff.nextDelayMs();
  assert.equal(backoff.nextDelayMs(), 8_000);
  backoff.reset();
  assert.equal(backoff.nextDelayMs(), 1_000);
});

test("worker restart backoff rejects a ceiling below the base delay", () => {
  const { RestartBackoff } = require("../status");
  assert.throws(() => new RestartBackoff({ baseMs: 5_000, maxMs: 1_000 }), /maxMs/);
});
