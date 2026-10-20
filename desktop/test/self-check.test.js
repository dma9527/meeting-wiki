"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const selfCheck = require("../self-check");
const { claudeSkillStatus, installClaudeSkill } = require("../skill-installer");

const SECRET = "test-self-check-secret-0000";

function fakeCli(stdout, calls = []) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    process.nextTick(() => callback(null, stdout, ""));
  };
}

const READY_REPORT = JSON.stringify({
  version: 1,
  config: "ok",
  providers: { transcription: "gemini", llm: "gemini", live_transcription: "gemini" },
  live_scope: "external",
  capabilities: { transcription: "ready", analysis: "ready", live: "ready", storage: "ready", memory: "ready" },
});

function baseOptions(overrides = {}) {
  return {
    python: "/test/python",
    configPath: "/test/config.toml",
    pythonAvailable: true,
    env: { PATH: "/usr/bin" },
    mediaAccess: () => "granted",
    skillStatus: () => "installed",
    execFileFn: fakeCli(READY_REPORT),
    ...overrides,
  };
}

test("a ready report runs the self-check CLI with the child env and formats as info", async () => {
  const calls = [];
  const env = { PATH: "/usr/bin" };
  const report = await selfCheck.runSelfCheck(baseOptions({ env, execFileFn: fakeCli(READY_REPORT, calls) }));
  assert.deepEqual(calls[0].args, ["-m", "meeting_wiki.cli", "--config", "/test/config.toml", "self-check"]);
  assert.equal(calls[0].options.env, env);
  const dialog = selfCheck.formatSelfCheck(report);
  assert.equal(dialog.type, "info");
  assert.equal(dialog.message, "Everything Meeting Wiki needs is ready.");
  for (const label of Object.values(selfCheck.LABELS)) assert.match(dialog.detail, new RegExp(label));
  assert.match(dialog.detail, /transcribed by Google Gemini/);
  assert.match(dialog.detail, /Live captions send microphone audio to an external provider/);
});

test("unknown, injected, or extra values never reach the dialog text", async () => {
  const hostile = JSON.stringify({
    version: 1,
    config: "ok",
    providers: { transcription: `evil ${SECRET}` },
    live_scope: "/Users/test/private",
    capabilities: { transcription: `FAIL ${SECRET}`, analysis: "ready", live: "ready", storage: "/Users/test", memory: "ready" },
    detail: SECRET,
  });
  const report = await selfCheck.runSelfCheck(baseOptions({
    execFileFn: fakeCli(hostile),
    mediaAccess: () => `weird ${SECRET}`,
    skillStatus: () => SECRET,
  }));
  const dialog = selfCheck.formatSelfCheck(report);
  const text = JSON.stringify(dialog);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes("/Users/test"));
  assert.equal(report.capabilities.transcription, "unknown");
  assert.equal(report.capabilities.microphone, "unknown");
  assert.equal(dialog.type, "warning");
});

test("invalid JSON and invalid config map to fixed engine lines", async () => {
  const broken = await selfCheck.runSelfCheck(baseOptions({ execFileFn: fakeCli(`Traceback ${SECRET}`) }));
  assert.equal(broken.capabilities.transcription, "check_failed");
  assert.ok(!JSON.stringify(selfCheck.formatSelfCheck(broken)).includes(SECRET));

  const invalid = await selfCheck.runSelfCheck(baseOptions({ execFileFn: fakeCli(JSON.stringify({ version: 1, config: "invalid", capabilities: {} })) }));
  assert.equal(invalid.capabilities.memory, "config_invalid");
  assert.match(selfCheck.formatSelfCheck(invalid).detail, /configuration could not be read/);
});

test("a missing engine or unavailable key never starts the CLI", async () => {
  const calls = [];
  const missing = await selfCheck.runSelfCheck(baseOptions({ pythonAvailable: false, execFileFn: fakeCli(READY_REPORT, calls) }));
  assert.equal(missing.capabilities.transcription, "engine_missing");
  const noKey = await selfCheck.runSelfCheck(baseOptions({ env: null, execFileFn: fakeCli(READY_REPORT, calls) }));
  assert.equal(noKey.capabilities.analysis, "key_unavailable");
  assert.equal(noKey.capabilities.memory, "not_checked");
  assert.equal(calls.length, 0);
});

test("permission statuses map to fixed lines, and a denied permission needs attention", async () => {
  const report = await selfCheck.runSelfCheck(baseOptions({ mediaAccess: (type) => (type === "screen" ? "denied" : "not-determined") }));
  const dialog = selfCheck.formatSelfCheck(report);
  assert.equal(dialog.message, "1 item needs attention.");
  assert.match(dialog.detail, /Needs attention {2}System audio permission: Blocked/);
  assert.match(dialog.detail, /Note {2}Microphone permission: Not asked yet/);
});

test("every capability table entry is fixed text with a known tone", () => {
  const tables = [selfCheck.ENGINE_TEXT, ...Object.values(selfCheck.PERMISSION_TEXT), ...Object.values(selfCheck.CAPABILITY_TEXT)];
  for (const table of tables) {
    for (const [tone, text] of Object.values(table)) {
      assert.ok(["ok", "note", "attention"].includes(tone));
      assert.equal(typeof text, "string");
      assert.match(text, /\.$/);
      assert.doesNotMatch(text, /\$\{|\u2014|\u2013/);
    }
  }
});

test("claudeSkillStatus is read-only and reports missing, installed, and conflict", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-skill-"));
  assert.equal(claudeSkillStatus({ homeDir: home }), "missing");
  assert.deepEqual(fs.readdirSync(home), [], "the probe must not create folders");
  assert.equal(installClaudeSkill({ homeDir: home }).status, "installed");
  assert.equal(claudeSkillStatus({ homeDir: home }), "installed");
  const target = path.join(home, ".claude", "skills", "meeting-wiki-memory", "SKILL.md");
  fs.writeFileSync(target, "edited by hand\n");
  assert.equal(claudeSkillStatus({ homeDir: home }), "conflict");
  assert.equal(fs.readFileSync(target, "utf8"), "edited by hand\n");
});

test("self-check main-process code never logs", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "self-check.js"), "utf8");
  assert.doesNotMatch(source, /console\.|process\.stdout|process\.stderr/);
});
