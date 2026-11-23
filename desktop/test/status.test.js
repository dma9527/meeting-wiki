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

test("job records keep only a clipped printable label and a valid capture time", async () => {
  const { listDeadJobs } = require("../status");
  const base = { job_type: "ingest", state: "dead", stage: "analyzing", attempts: 5, max_attempts: 5, error_type: "RuntimeError" };
  const execFile = fakeExec([{ stdout: JSON.stringify([
    { ...base, id: 1, label: "Private recording", captured_at: "2026-09-04T15:05:00+00:00" },
    { ...base, id: 2, label: "Bad\u0007label" + "x".repeat(200), captured_at: "not a date" },
    { ...base, id: 3 },
  ]) }], []);
  const jobs = await listDeadJobs("/python", "/config.toml", execFile);
  assert.equal(jobs[0].label, "Private recording");
  assert.equal(jobs[0].captured_at, "2026-09-04T15:05:00+00:00");
  assert.equal(jobs[1].label, "Recording");
  assert.equal(jobs[1].captured_at, null);
  assert.equal(jobs[2].label, "Recording");
  assert.equal(jobs[2].captured_at, null);
});

test("dead job diagnostics keep a known failure kind and a safe provider code only", async () => {
  const { listDeadJobs } = require("../status");
  const diagnostic = {
    version: 1, stage: "transcribing", attempt: 1, max_attempts: 5, category: "provider_request_failed",
    error_type: "SafeProviderError", provider: "openai_compatible", operation: "transcription",
    sdk_error_type: "HTTPStatusError", http_status: 429,
  };
  const base = { job_type: "ingest", state: "dead", stage: "transcribing", attempts: 1, max_attempts: 5, error_type: "SafeProviderError" };
  const execFile = fakeExec([{ stdout: JSON.stringify([
    { ...base, id: 1, diagnostic: { ...diagnostic, provider_code: "insufficient_quota", failure_kind: "billing" } },
    { ...base, id: 2, diagnostic: { ...diagnostic, provider_code: "Has Text", failure_kind: "made_up" } },
  ]) }], []);
  const [known, unknown] = await listDeadJobs("/python", "/config.toml", execFile);
  assert.equal(known.diagnostic.failure_kind, "billing");
  assert.equal(known.diagnostic.provider_code, "insufficient_quota");
  assert.equal(unknown.diagnostic.failure_kind, undefined);
  assert.equal(unknown.diagnostic.provider_code, undefined);
});

test("jobs waiting for credit get their own tray label, summary, and retry list", async () => {
  const { formatQueueLabel, readCreditWait, listCreditWaitingJobs } = require("../status");
  assert.equal(formatQueueLabel({ total: 3, active: 2, action_required: 0, waiting_for_credit: 2, stages: {} }), "Waiting for provider credit: 2");
  assert.equal(formatQueueLabel({ total: 3, active: 2, action_required: 1, waiting_for_credit: 2, stages: {} }), "Action required: 1 failed");

  const summary = { total: 2, active: 2, action_required: 0, waiting_for_credit: 2, credit_provider: "gemini", credit_next_try_at: 1800000000 };
  assert.deepEqual(await readCreditWait("/python", "/config.toml", fakeExec([{ stdout: JSON.stringify(summary) }], [])), { waiting: 2, provider: "gemini", nextTryAt: 1800000000 });
  const unsafe = { ...summary, credit_provider: "not safe!", credit_next_try_at: -1 };
  assert.deepEqual(await readCreditWait("/python", "/config.toml", fakeExec([{ stdout: JSON.stringify(unsafe) }], [])), { waiting: 2, provider: null, nextTryAt: null });

  const diagnostic = {
    version: 1, stage: "transcribing", attempt: 1, max_attempts: 5, category: "provider_request_failed",
    error_type: "SafeProviderError", provider: "gemini", operation: "transcription", sdk_error_type: "ClientError", http_status: 402,
  };
  const base = { job_type: "ingest", state: "failed", stage: "transcribing", attempts: 0, max_attempts: 5, error_type: "SafeProviderError" };
  const jobs = await listCreditWaitingJobs("/python", "/config.toml", fakeExec([{ stdout: JSON.stringify([
    { ...base, id: 1, diagnostic: { ...diagnostic, failure_kind: "billing" } },
    { ...base, id: 2, diagnostic: { ...diagnostic, http_status: 503, failure_kind: "server" } },
  ]) }], []));
  assert.deepEqual(jobs.map((job) => job.id), [1]);
});

test("readUsageReport passes only numbers and flags from the usage command", async () => {
  const { readUsageReport } = require("../status");
  const calls = [];
  const report = {
    month: "2026-11",
    items: [
      { provider: "gemini", model: "test-model", operation: "analysis", calls: 4, input_tokens: 10, output_tokens: 2 },
      { provider: "gemini", model: "test-live", operation: "live_transcription", calls: 2, audio_seconds: 60 },
    ],
    estimated_usd: 3.21,
    unpriced: false,
    live_budget_usd: 20,
    live_budget_reached: false,
  };
  const values = await readUsageReport("/python", "/config.toml", fakeExec([{ stdout: JSON.stringify(report) }], calls));
  assert.deepEqual(values, {
    month: "2026-11",
    estimatedUsd: 3.21,
    unpriced: false,
    calls: 6,
    liveBudgetUsd: 20,
    liveBudgetReached: false,
  });
  assert.deepEqual(calls[0].args.slice(-1), ["usage"]);
  for (const bad of [
    { ...report, month: "../x" },
    { ...report, estimated_usd: "3" },
    { ...report, live_budget_usd: -1 },
    { ...report, items: null },
  ]) {
    await assert.rejects(readUsageReport("/python", "/config.toml", fakeExec([{ stdout: JSON.stringify(bad) }], [])));
  }
  await assert.rejects(readUsageReport("/python", "/config.toml", fakeExec([{ error: new Error("exit 1") }], [])));
});
