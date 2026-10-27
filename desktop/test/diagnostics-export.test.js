"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  EXPORT_ERRORS,
  diagnosticsFileName,
  runDiagnosticsExport,
} = require("../diagnostics-export");

const GOOD_REPORT = {
  format: "meeting-wiki-diagnostics",
  version: 1,
  generated_at: "2026-10-27T14:00:00Z",
  app: { component_version: "0.1.19" },
};

function fakeExec(outcome) {
  const calls = [];
  const execFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    process.nextTick(() => callback(outcome.error || null, outcome.stdout || "", outcome.stderr || ""));
  };
  return { execFileFn, calls };
}

test("a good report is returned as formatted text with a trailing newline", async () => {
  const { execFileFn, calls } = fakeExec({ stdout: JSON.stringify(GOOD_REPORT) });
  const result = await runDiagnosticsExport({
    python: "/fake/python",
    configPath: "/fake/config.toml",
    env: { PATH: "/usr/bin" },
    execFileFn,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.text), GOOD_REPORT);
  assert.ok(result.text.endsWith("\n"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/fake/python");
  assert.deepEqual(calls[0].args, [
    "-m", "meeting_wiki.cli", "--config", "/fake/config.toml", "diagnostics-export",
  ]);
  assert.ok(!calls[0].args.includes("--output"), "the app writes the file, so the CLI never gets a path");
  assert.deepEqual(calls[0].options.env, { PATH: "/usr/bin" });
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.maxBuffer > 0);
});

test("a CLI error code is passed on only when it is a known code", async () => {
  for (const code of ["diagnostic_report_not_privacy_safe", "internal_error"]) {
    const { execFileFn } = fakeExec({ error: new Error("exit 1"), stdout: JSON.stringify({ error: code }) });
    const result = await runDiagnosticsExport({ python: "p", configPath: "c", env: {}, execFileFn });
    assert.deepEqual(result, { ok: false, code });
  }
  const { execFileFn } = fakeExec({
    error: new Error("exit 1"),
    stdout: JSON.stringify({ error: "/Users/someone/secret/path" }),
  });
  assert.deepEqual(await runDiagnosticsExport({ python: "p", configPath: "c", env: {}, execFileFn }), {
    ok: false,
    code: "export_failed",
  });
});

test("unusable output becomes export_failed and never returns the raw output", async () => {
  const cases = [
    { stdout: "" },
    { stdout: "not json /Users/someone/secret" },
    { stdout: JSON.stringify(["a"]) },
    { stdout: JSON.stringify({ format: "something-else", version: 1 }) },
    { stdout: JSON.stringify({ ...GOOD_REPORT, version: 2 }) },
    { stdout: "x".repeat(2_000_000) },
    { error: new Error("spawn ENOENT /Users/someone/python"), stderr: "Traceback /Users/someone" },
    { error: Object.assign(new Error("timed out"), { killed: true }) },
  ];
  for (const outcome of cases) {
    const { execFileFn } = fakeExec(outcome);
    const result = await runDiagnosticsExport({ python: "p", configPath: "c", env: {}, execFileFn });
    assert.deepEqual(result, { ok: false, code: "export_failed" });
  }
});

test("an exception thrown by execFile is handled", async () => {
  const execFileFn = () => { throw new Error("EACCES /Users/someone"); };
  const result = await runDiagnosticsExport({ python: "p", configPath: "c", env: {}, execFileFn });
  assert.deepEqual(result, { ok: false, code: "export_failed" });
});

test("the suggested file name carries the local date only", () => {
  assert.equal(diagnosticsFileName(new Date(2026, 9, 7)), "meeting-wiki-diagnostics-2026-10-07.json");
  assert.match(diagnosticsFileName(), /^meeting-wiki-diagnostics-\d{4}-\d{2}-\d{2}\.json$/);
});

test("the known error codes are fixed strings", () => {
  assert.deepEqual([...EXPORT_ERRORS].sort(), ["diagnostic_report_not_privacy_safe", "internal_error"]);
});

const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

function functionBody(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.js is missing ${name}`);
  const asyncStart = main.lastIndexOf("async ", start);
  const from = asyncStart === start - 6 ? asyncStart : start;
  const next = main.indexOf("\nfunction ", start + 1);
  const nextAsync = main.indexOf("\nasync function ", start + 1);
  const ends = [next, nextAsync].filter((index) => index > 0);
  return main.slice(from, ends.length ? Math.min(...ends) : undefined);
}

test("the tray offers Export diagnostics next to the self-check", () => {
  const menu = functionBody("updateMenu");
  const selfCheckAt = menu.indexOf('{ label: "Run self-check..."');
  const exportAt = menu.indexOf('{ label: "Export diagnostics...", click: () => { void exportDiagnostics(); } }');
  assert.ok(selfCheckAt >= 0 && exportAt > selfCheckAt, "the export item follows the self-check item");
  assert.match(main, /const \{ diagnosticsFileName, runDiagnosticsExport \} = require\("\.\/diagnostics-export"\);/);
});

test("the export runs with a credential-free environment and writes only the chosen file", () => {
  const body = functionBody("exportDiagnostics");
  assert.match(body, /if \(diagnosticsExportRunning\) return;/);
  assert.match(body, /if \(!pythonAvailable\(\)\) \{\s*notifyMissingPython\(\);/);
  assert.match(body, /env: ingestEnv\(\)/);
  assert.match(body, /dialog\.showSaveDialog\(tr\.dialog\(/);
  assert.match(body, /if \(chosen\.canceled \|\| !chosen\.filePath\) return;/);
  assert.match(body, /atomicWriteFile\(fs, chosen\.filePath, result\.text\)/);
  assert.match(body, /shell\.showItemInFolder\(chosen\.filePath\)/);
  assert.doesNotMatch(body, /processingEnv|secretStore|error\.message|stderr|stdout/);
  assert.match(body, /finally \{\s*diagnosticsExportRunning = false;/);
});

test("the report is generated before the save dialog so a failure never leaves an empty file", () => {
  const body = functionBody("exportDiagnostics");
  assert.ok(body.indexOf("runDiagnosticsExport(") < body.indexOf("dialog.showSaveDialog("));
  assert.ok(body.indexOf("dialog.showSaveDialog(") < body.indexOf("atomicWriteFile("));
});
