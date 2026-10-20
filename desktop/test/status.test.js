"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatQueueLabel,
  readDoctorStatus,
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
    { stdout: JSON.stringify([{ id: 4, state: "dead" }, { id: 9, state: "dead" }]) },
    { stdout: JSON.stringify({ job_id: 4, state: "pending", retried: true }) },
    { stdout: JSON.stringify({ job_id: 9, state: "pending", retried: true }) },
  ], calls);

  assert.equal(await retryDeadJobs("/python", "/config.toml", execFile), 2);
  assert.deepEqual(calls.slice(1).map(({ args }) => args.at(-1)), ["4", "9"]);
  assert.equal(calls[0].args.includes("--verbose"), false);
});

test("doctor output remains available when a provider is unhealthy", async () => {
  const calls = [];
  const error = Object.assign(new Error("exit 1"), { code: 1 });
  const execFile = fakeExec([{ error, stdout: "OK storage: local\nFAIL llm: model not pulled\n" }], calls);

  const result = await readDoctorStatus("/python", "/config.toml", execFile);

  assert.equal(result.ok, false);
  assert.match(result.text, /FAIL llm/);
});

test("status helpers pass an optional per-child env to every CLI call", async () => {
  const env = { PATH: "/usr/bin", CHILD_ONLY: "1" };
  const calls = [];
  const execFile = fakeExec([
    { stdout: JSON.stringify({ total: 0, active: 0, action_required: 0 }) },
    { stdout: "OK storage: local\n" },
    { stdout: JSON.stringify([{ id: 4, state: "dead" }]) },
    { stdout: JSON.stringify({ job_id: 4, state: "pending", retried: true }) },
  ], calls);

  await readQueueStatus("/python", "/config.toml", execFile, env);
  await readDoctorStatus("/python", "/config.toml", execFile, env);
  assert.equal(await retryDeadJobs("/python", "/config.toml", execFile, env), 1);

  assert.equal(calls.length, 4);
  for (const { options } of calls) assert.equal(options.env, env);
});

test("status helpers inherit the parent env when none is given", async () => {
  const calls = [];
  const execFile = fakeExec([
    { stdout: JSON.stringify({ total: 0, active: 0, action_required: 0 }) },
    { stdout: "OK storage: local\n" },
    { stdout: JSON.stringify([]) },
  ], calls);

  await readQueueStatus("/python", "/config.toml", execFile);
  await readDoctorStatus("/python", "/config.toml", execFile);
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
