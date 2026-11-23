"use strict";

const { execFile } = require("child_process");

// `env` is an optional per-child environment; omitted means inherit the parent's.
function executeCli(python, configPath, args, execFileFn = execFile, env = undefined) {
  const commandArgs = ["-m", "meeting_wiki.cli", "--config", configPath, ...args];
  const options = { encoding: "utf8", maxBuffer: 1024 * 1024 };
  if (env) options.env = env;
  return new Promise((resolve) => {
    execFileFn(
      python,
      commandArgs,
      options,
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      },
    );
  });
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (_) {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value);
}

// Provider-neutral kinds computed by the engine (meeting_wiki/diagnostics.py).
const FAILURE_KINDS = new Set(["billing", "rate_limited", "auth", "bad_request", "server", "network"]);

function safeDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const providerFailure = value.category === "provider_request_failed";
  if (!Number.isInteger(value.version) || value.version !== 1 || !safeIdentifier(value.stage)
    || !Number.isInteger(value.attempt) || value.attempt < 0
    || !Number.isInteger(value.max_attempts) || value.max_attempts < 0
    || !safeIdentifier(value.error_type)) {
    return null;
  }
  const diagnostic = {
    version: value.version,
    stage: value.stage,
    attempt: value.attempt,
    max_attempts: value.max_attempts,
    category: providerFailure ? "provider_request_failed" : "internal_error",
    error_type: value.error_type,
  };
  if (!providerFailure) return diagnostic;
  if (!safeIdentifier(value.provider) || !safeIdentifier(value.operation)
    || !safeIdentifier(value.sdk_error_type)) return null;
  diagnostic.provider = value.provider;
  diagnostic.operation = value.operation;
  diagnostic.sdk_error_type = value.sdk_error_type;
  if (Number.isInteger(value.http_status) && value.http_status >= 400 && value.http_status <= 599) {
    diagnostic.http_status = value.http_status;
  }
  if (typeof value.provider_status === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.provider_status)) {
    diagnostic.provider_status = value.provider_status;
  }
  if (typeof value.provider_code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value.provider_code)) {
    diagnostic.provider_code = value.provider_code;
  }
  if (FAILURE_KINDS.has(value.failure_kind)) diagnostic.failure_kind = value.failure_kind;
  return diagnostic;
}

// The CLI already withholds private and unclassified titles; this only enforces shape.
const LABEL_MAX = 80;
function safeLabel(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > LABEL_MAX) return "Recording";
  return /[\u0000-\u001f\u007f-\u009f]/.test(value) ? "Recording" : value;
}

function safeTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function safeJobRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isInteger(value.id) || value.id < 1
    || !safeIdentifier(value.job_type) || !safeIdentifier(value.state)
    || !safeIdentifier(value.stage) || !Number.isInteger(value.attempts) || value.attempts < 0
    || !Number.isInteger(value.max_attempts) || value.max_attempts < 0) {
    throw new Error("Status command returned an invalid job");
  }
  const job = {
    id: value.id,
    job_type: value.job_type,
    state: value.state,
    stage: value.stage,
    attempts: value.attempts,
    max_attempts: value.max_attempts,
    error_type: safeIdentifier(value.error_type) ? value.error_type : null,
    label: safeLabel(value.label),
    captured_at: safeTimestamp(value.captured_at),
  };
  const diagnostic = safeDiagnostic(value.diagnostic);
  if (diagnostic) job.diagnostic = diagnostic;
  return job;
}

function validateJobId(jobId) {
  if (!Number.isInteger(jobId) || jobId < 1) throw new Error("Invalid job selected");
  return jobId;
}

async function listJobs(python, configPath, state, execFileFn = execFile, env = undefined) {
  const result = await executeCli(
    python,
    configPath,
    ["status", "--state", state],
    execFileFn,
    env,
  );
  if (!result.ok) throw new Error("Unable to list processing jobs");
  const jobs = parseJson(result.stdout, "Status command");
  if (!Array.isArray(jobs)) throw new Error("Status command returned invalid jobs");
  return jobs.map(safeJobRecord);
}

async function runJobAction(python, configPath, action, jobId, execFileFn = execFile, env = undefined) {
  const result = await executeCli(
    python,
    configPath,
    [action, String(validateJobId(jobId))],
    execFileFn,
    env,
  );
  if (!result.ok) throw new Error("Processing action could not be completed");
  const output = parseJson(result.stdout, "Processing action");
  if (!output || output.job_id !== jobId || output.state !== "pending" && output.state !== "dead"
    && output.state !== "dismissed") {
    throw new Error("Processing action returned an invalid result");
  }
  return output;
}

// t translates English source text with {name} placeholders; the default fills them in English.
const englishText = require("./renderer/i18n").fill;

function formatQueueLabel(summary, t = englishText) {
  if (summary.action_required > 0) return t("Action required: {count} failed", { count: summary.action_required });
  if (summary.waiting_for_credit > 0) return t("Waiting for provider credit: {count}", { count: summary.waiting_for_credit });
  if (summary.active > 0) {
    const activeStages = Object.entries(summary.stages || {})
      .filter(([, count]) => Number.isInteger(count) && count > 0)
      .map(([stage]) => t(stage));
    if (activeStages.length === 0) return t("Processing: {count}", { count: summary.active });
    return t("Processing: {count} ({stages})", { count: summary.active, stages: activeStages.join(t(", ")) });
  }
  if (summary.total > 0) return t("All meetings processed");
  return t("No meetings yet");
}

async function readQueueStatus(python, configPath, execFileFn = execFile, env = undefined) {
  const result = await executeCli(python, configPath, ["status", "--summary"], execFileFn, env);
  if (!result.ok) throw new Error("Unable to read processing status");
  const summary = parseJson(result.stdout, "Status command");
  for (const field of ["total", "active", "action_required"]) {
    if (!Number.isInteger(summary[field]) || summary[field] < 0) {
      throw new Error("Status command returned invalid counts");
    }
  }
  return summary;
}

function usageNumber(value, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

// Month-to-date estimate from `usage`; only numbers and flags reach the renderer.
async function readUsageReport(python, configPath, execFileFn = execFile, env = undefined) {
  const result = await executeCli(python, configPath, ["usage"], execFileFn, env);
  if (!result.ok) throw new Error("Unable to read usage");
  const report = parseJson(result.stdout, "Usage command");
  const estimatedUsd = usageNumber(report.estimated_usd, 1e9);
  const budget = report.live_budget_usd;
  if (typeof report.month !== "string" || !/^\d{4}-\d{2}$/.test(report.month) || estimatedUsd === null
    || !Number.isInteger(budget) || budget < 0 || !Array.isArray(report.items)) {
    throw new Error("Usage command returned invalid numbers");
  }
  const calls = report.items.reduce((total, item) => total + (usageNumber(item && item.calls, 1e12) || 0), 0);
  return {
    month: report.month,
    estimatedUsd,
    unpriced: report.unpriced === true,
    calls,
    liveBudgetUsd: budget,
    liveBudgetReached: report.live_budget_reached === true,
  };
}

async function listDeadJobs(python, configPath, execFileFn = execFile, env = undefined) {
  return listJobs(python, configPath, "dead", execFileFn, env);
}

async function listDismissedJobs(python, configPath, execFileFn = execFile, env = undefined) {
  return listJobs(python, configPath, "dismissed", execFileFn, env);
}

async function retryJob(python, configPath, jobId, execFileFn = execFile, env = undefined) {
  return runJobAction(python, configPath, "retry", jobId, execFileFn, env);
}

async function dismissJob(python, configPath, jobId, execFileFn = execFile, env = undefined) {
  return runJobAction(python, configPath, "dismiss", jobId, execFileFn, env);
}

async function restoreJob(python, configPath, jobId, execFileFn = execFile, env = undefined) {
  return runJobAction(python, configPath, "restore", jobId, execFileFn, env);
}

// Failed jobs whose last attempt found no provider credit; they retry on their own.
async function listCreditWaitingJobs(python, configPath, execFileFn = execFile, env = undefined) {
  const jobs = await listJobs(python, configPath, "failed", execFileFn, env);
  return jobs.filter((job) => job.diagnostic && job.diagnostic.failure_kind === "billing");
}

async function readCreditWait(python, configPath, execFileFn = execFile, env = undefined) {
  const summary = await readQueueStatus(python, configPath, execFileFn, env);
  const waiting = Number.isInteger(summary.waiting_for_credit) && summary.waiting_for_credit > 0 ? summary.waiting_for_credit : 0;
  const wait = { waiting, provider: null, nextTryAt: null };
  if (!waiting) return wait;
  if (safeIdentifier(summary.credit_provider)) wait.provider = summary.credit_provider;
  if (Number.isInteger(summary.credit_next_try_at) && summary.credit_next_try_at > 0) wait.nextTryAt = summary.credit_next_try_at;
  return wait;
}

async function retryCreditWaitingJobs(python, configPath, execFileFn = execFile, env = undefined) {
  const jobs = await listCreditWaitingJobs(python, configPath, execFileFn, env);
  for (const job of jobs) await retryJob(python, configPath, job.id, execFileFn, env);
  return jobs.length;
}

async function retryDeadJobs(python, configPath, execFileFn = execFile, env = undefined) {
  const jobs = await listDeadJobs(python, configPath, execFileFn, env);
  let retried = 0;
  for (const job of jobs) {
    await retryJob(python, configPath, job.id, execFileFn, env);
    retried += 1;
  }
  return retried;
}

// Bounded exponential delay for restarting the worker while credentials are unavailable.
class RestartBackoff {
  constructor({ baseMs = 2_000, maxMs = 60_000 } = {}) {
    if (!(baseMs > 0) || !(maxMs >= baseMs)) throw new Error("RestartBackoff requires 0 < baseMs <= maxMs");
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.current = baseMs;
  }

  nextDelayMs() {
    const delay = this.current;
    this.current = Math.min(this.maxMs, this.current * 2);
    return delay;
  }

  reset() {
    this.current = this.baseMs;
  }
}

module.exports = {
  RestartBackoff,
  formatQueueLabel,
  readQueueStatus,
  readUsageReport,
  listDeadJobs,
  listCreditWaitingJobs,
  readCreditWait,
  retryCreditWaitingJobs,
  listDismissedJobs,
  retryJob,
  dismissJob,
  restoreJob,
  retryDeadJobs,
};
