"use strict";

const { execFile } = require("child_process");

function executeCli(python, configPath, args, execFileFn = execFile) {
  const commandArgs = ["-m", "meeting_wiki.cli", "--config", configPath, ...args];
  return new Promise((resolve) => {
    execFileFn(
      python,
      commandArgs,
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
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

function formatQueueLabel(summary) {
  if (summary.action_required > 0) return `Action required: ${summary.action_required} failed`;
  if (summary.active > 0) {
    const activeStages = Object.entries(summary.stages || {})
      .filter(([, count]) => Number.isInteger(count) && count > 0)
      .map(([stage]) => stage);
    const detail = activeStages.length > 0 ? ` (${activeStages.join(", ")})` : "";
    return `Processing: ${summary.active}${detail}`;
  }
  if (summary.total > 0) return "All meetings processed";
  return "No meetings yet";
}

async function readQueueStatus(python, configPath, execFileFn = execFile) {
  const result = await executeCli(python, configPath, ["status", "--summary"], execFileFn);
  if (!result.ok) throw new Error("Unable to read processing status");
  const summary = parseJson(result.stdout, "Status command");
  for (const field of ["total", "active", "action_required"]) {
    if (!Number.isInteger(summary[field]) || summary[field] < 0) {
      throw new Error("Status command returned invalid counts");
    }
  }
  return summary;
}

async function retryDeadJobs(python, configPath, execFileFn = execFile) {
  const listResult = await executeCli(
    python,
    configPath,
    ["status", "--state", "dead"],
    execFileFn,
  );
  if (!listResult.ok) throw new Error("Unable to list failed jobs");
  const jobs = parseJson(listResult.stdout, "Status command");
  if (!Array.isArray(jobs)) throw new Error("Status command returned invalid jobs");
  let retried = 0;
  for (const job of jobs) {
    if (!Number.isInteger(job.id)) throw new Error("Status command returned an invalid job id");
    const retryResult = await executeCli(
      python,
      configPath,
      ["retry", String(job.id)],
      execFileFn,
    );
    if (!retryResult.ok) throw new Error(`Unable to retry job ${job.id}`);
    retried += 1;
  }
  return retried;
}

async function readDoctorStatus(python, configPath, execFileFn = execFile) {
  const result = await executeCli(python, configPath, ["doctor"], execFileFn);
  return {
    ok: result.ok,
    text: result.stdout || result.stderr || "No health details available.",
  };
}

module.exports = {
  formatQueueLabel,
  readDoctorStatus,
  readQueueStatus,
  retryDeadJobs,
};
