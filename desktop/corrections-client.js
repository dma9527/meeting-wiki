"use strict";

// Builds and runs the Python correction commands. Mapping is validated before a
// process is spawned. Only the privacy-safe projection returned by the CLI is
// parsed here; transcript and analysis payloads never reach this layer.

const { execFile } = require("child_process");

function validateMeetingKey(meetingKey) {
  if (typeof meetingKey !== "string" || meetingKey.length === 0) {
    throw new Error("meeting key must be a non-empty string");
  }
  if (meetingKey.includes("\0")) throw new Error("meeting key has invalid characters");
  return meetingKey;
}

function validateMapping(mapping) {
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    throw new Error("mapping must be an object of OLD to NEW strings");
  }
  const entries = Object.entries(mapping);
  if (entries.length === 0) throw new Error("mapping requires at least one OLD to NEW pair");
  for (const [oldLabel, newName] of entries) {
    if (typeof oldLabel !== "string" || oldLabel.trim().length === 0) {
      throw new Error("OLD label must be a non-empty string");
    }
    if (oldLabel.includes("|") || /[\u0000-\u001f]/.test(oldLabel)) {
      throw new Error("OLD label has invalid characters");
    }
    if (typeof newName !== "string" || newName.trim().length === 0) {
      throw new Error("NEW name must be a non-empty string");
    }
    if (newName.trim().length > 200) throw new Error("NEW name must be 1-200 characters");
    if (newName.includes("|") || /[\u0000-\u001f]/.test(newName)) {
      throw new Error("NEW name has invalid characters");
    }
  }
  return entries;
}

function inboxArgs(configPath) {
  return ["-m", "meeting_wiki.cli", "--config", configPath, "correct-inbox"];
}

function correctArgs(configPath, meetingKey, mapping, options = {}) {
  const key = validateMeetingKey(meetingKey);
  const entries = validateMapping(mapping);
  const args = ["-m", "meeting_wiki.cli", "--config", configPath, "correct", "--meeting", key];
  for (const [oldLabel, newName] of entries) {
    args.push("--speaker", `${oldLabel.trim()}=${newName.trim()}`);
  }
  if (options.reprocess) args.push("--reprocess");
  return args;
}

function executeCli(python, args, execFileFn = execFile) {
  return new Promise((resolve) => {
    execFileFn(python, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: (stdout || "").trim() });
    });
  });
}

function parseJson(output, label) {
  if (!output) throw new Error(`${label} returned no output`);
  try {
    return JSON.parse(output);
  } catch (_) {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function fetchInbox(python, configPath, execFileFn = execFile) {
  const result = await executeCli(python, inboxArgs(configPath), execFileFn);
  if (!result.ok) throw new Error("Unable to read the correction inbox");
  const inbox = parseJson(result.stdout, "correct-inbox");
  if (!Array.isArray(inbox)) throw new Error("correct-inbox returned invalid data");
  return inbox;
}

async function runCorrect(python, configPath, meetingKey, mapping, options = {}, execFileFn = execFile) {
  const result = await executeCli(
    python,
    correctArgs(configPath, meetingKey, mapping, options),
    execFileFn,
  );
  return parseJson(result.stdout, "correct");
}

function planCorrection(python, configPath, meetingKey, mapping, execFileFn = execFile) {
  return runCorrect(python, configPath, meetingKey, mapping, { reprocess: false }, execFileFn);
}

function applyCorrection(python, configPath, meetingKey, mapping, execFileFn = execFile) {
  return runCorrect(python, configPath, meetingKey, mapping, { reprocess: true }, execFileFn);
}

module.exports = {
  applyCorrection,
  correctArgs,
  fetchInbox,
  inboxArgs,
  planCorrection,
  validateMapping,
  validateMeetingKey,
};
