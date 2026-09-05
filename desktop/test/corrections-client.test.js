"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  applyCorrection,
  correctArgs,
  fetchInbox,
  inboxArgs,
  planCorrection,
  validateMapping,
} = require("../corrections-client");

function fakeExec(responses, calls) {
  return (file, args, options, callback) => {
    calls.push({ file, args });
    const response = responses.shift();
    process.nextTick(() => callback(response.error || null, response.stdout || "", ""));
  };
}

test("inboxArgs targets the read-only correct-inbox command", () => {
  assert.deepEqual(inboxArgs("/config.toml"), [
    "-m", "meeting_wiki.cli", "--config", "/config.toml", "correct-inbox",
  ]);
});

test("correctArgs builds one --speaker per mapping pair and gates reprocess", () => {
  const key = "wiki/meetings/2026-09-04-rollout.md";
  assert.deepEqual(correctArgs("/c", key, { "Remote participant": "Sam" }), [
    "-m", "meeting_wiki.cli", "--config", "/c", "correct", "--meeting", key,
    "--speaker", "Remote participant=Sam",
  ]);
  const both = correctArgs("/c", key, { "spk_0": "Alex", "spk_1": "Sam" }, { reprocess: true });
  assert.equal(both.at(-1), "--reprocess");
  assert.equal(both.filter((arg) => arg === "--speaker").length, 2);
});

test("validateMapping rejects invalid shapes and unsafe names before spawning", () => {
  assert.throws(() => validateMapping(null), /object/);
  assert.throws(() => validateMapping([]), /object/);
  assert.throws(() => validateMapping({}), /at least one/);
  assert.throws(() => validateMapping({ "": "Sam" }), /OLD label/);
  assert.throws(() => validateMapping({ "spk_0": "" }), /NEW name/);
  assert.throws(() => validateMapping({ "spk_0": "a".repeat(201) }), /1-200/);
  assert.throws(() => validateMapping({ "spk_0": "Sam | Team" }), /invalid characters/);
  assert.throws(() => validateMapping({ "spk_0": "Sam\nRivera" }), /invalid characters/);
  assert.throws(() => validateMapping({ "spk_0|inj": "Sam" }), /OLD label has invalid characters/);
  assert.throws(() => validateMapping({ "spk_0\u0007": "Sam" }), /OLD label has invalid characters/);
  assert.deepEqual(validateMapping({ "spk_0": "Sam Rivera" }), [["spk_0", "Sam Rivera"]]);
});

test("correctArgs refuses an unsafe meeting key without calling the CLI", () => {
  assert.throws(() => correctArgs("/c", "", { "spk_0": "Sam" }), /meeting key/);
  assert.throws(() => correctArgs("/c", "wiki/x\u0000.md", { "spk_0": "Sam" }), /invalid/);
});

test("fetchInbox parses the privacy-safe array from the CLI", async () => {
  const calls = [];
  const execFile = fakeExec(
    [{ stdout: JSON.stringify([{ meeting_key: "wiki/meetings/x.md", labels: [] }]) }],
    calls,
  );
  const inbox = await fetchInbox("/python", "/c", execFile);
  assert.equal(inbox[0].meeting_key, "wiki/meetings/x.md");
  assert.deepEqual(calls[0].args, [
    "-m", "meeting_wiki.cli", "--config", "/c", "correct-inbox",
  ]);
});

test("planCorrection returns the plan and does not pass --reprocess", async () => {
  const calls = [];
  const plan = { meeting_key: "wiki/meetings/x.md", clean_surfaces: ["wiki/meetings/x.md"] };
  const execFile = fakeExec([{ stdout: JSON.stringify(plan) }], calls);
  const result = await planCorrection("/python", "/c", "wiki/meetings/x.md", { "spk_0": "Sam" }, execFile);
  assert.deepEqual(result.clean_surfaces, ["wiki/meetings/x.md"]);
  assert.equal(calls[0].args.includes("--reprocess"), false);
});

test("applyCorrection passes --reprocess and returns the job id", async () => {
  const calls = [];
  const execFile = fakeExec([{ stdout: JSON.stringify({ job_id: 7, queued: true }) }], calls);
  const result = await applyCorrection("/python", "/c", "wiki/meetings/x.md", { "spk_0": "Sam" }, execFile);
  assert.equal(result.job_id, 7);
  assert.ok(calls[0].args.includes("--reprocess"));
});

test("correction commands surface invalid JSON as an error", async () => {
  const execFile = fakeExec([{ stdout: "not json" }], []);
  await assert.rejects(
    () => planCorrection("/python", "/c", "wiki/meetings/x.md", { "spk_0": "Sam" }, execFile),
    /invalid JSON/,
  );
});
