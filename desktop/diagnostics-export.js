"use strict";

// Runs the privacy-safe diagnostics export for the tray. Only a validated report or a fixed
// error code leaves this module; stderr, exit messages, and paths are never returned.

const { execFile } = require("child_process");

const EXPORT_TIMEOUT_MS = 30_000;
const MAX_REPORT_BYTES = 1_000_000;
const EXPORT_ERRORS = Object.freeze(["diagnostic_report_not_privacy_safe", "internal_error"]);
const FAILED = Object.freeze({ ok: false, code: "export_failed" });

function parseReport(stdout) {
  try {
    return JSON.parse(String(stdout || "").trim());
  } catch (_) {
    return null;
  }
}

function runDiagnosticsExport({ python, configPath, env, execFileFn = execFile }) {
  return new Promise((resolve) => {
    const finish = (stdout) => {
      const parsed = parseReport(stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return resolve({ ...FAILED });
      if (typeof parsed.error === "string") {
        return resolve({ ok: false, code: EXPORT_ERRORS.includes(parsed.error) ? parsed.error : FAILED.code });
      }
      if (parsed.format !== "meeting-wiki-diagnostics" || parsed.version !== 1) return resolve({ ...FAILED });
      return resolve({ ok: true, text: `${JSON.stringify(parsed, null, 2)}\n` });
    };
    try {
      execFileFn(
        python,
        ["-m", "meeting_wiki.cli", "--config", configPath, "diagnostics-export"],
        { encoding: "utf8", maxBuffer: MAX_REPORT_BYTES, timeout: EXPORT_TIMEOUT_MS, env },
        (error, stdout) => {
          // The CLI prints a fixed error object on stdout and exits 1, so stdout is read either way.
          if (error && !stdout) return resolve({ ...FAILED });
          if (error && error.killed) return resolve({ ...FAILED });
          return finish(stdout);
        },
      );
    } catch (_) {
      resolve({ ...FAILED });
    }
  });
}

function diagnosticsFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `meeting-wiki-diagnostics-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

module.exports = { EXPORT_ERRORS, diagnosticsFileName, runDiagnosticsExport };
