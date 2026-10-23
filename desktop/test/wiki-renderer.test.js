"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RENDERER = path.join(__dirname, "..", "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

function body(js, signature) {
  const start = js.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const next = js.indexOf("\nfunction ", start + 1);
  const nextAsync = js.indexOf("\nasync function ", start + 1);
  const ends = [next, nextAsync].filter((index) => index > 0);
  return js.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test("the recovery view has a last-updated line and a persistent inline error with Retry", () => {
  const html = read("index.html");
  const view = html.slice(html.indexOf('<section id="view-recovery"'), html.indexOf("</main>"));
  assert.match(view, /id="recovery-updated"[^>]*role="status"/);
  assert.match(view, /id="recovery-error"[^>]*role="alert"[^>]*hidden/);
  assert.match(view, /id="recovery-error-retry"[^>]*type="button"[^>]*>Retry</);
});

test("opening recovery always refreshes and failures stay inline instead of a toast", () => {
  const js = read("app.js");
  assert.match(js, /if \(view === "recovery"\) loadRecovery\(true\);/);
  const load = body(js, "async function loadRecovery");
  assert.match(load, /showRecoveryError\(/);
  assert.doesNotMatch(load, /failed\(/, "recovery load errors must not be transient toasts");
  assert.match(load, /recovery-updated/);
  assert.match(js, /getElementById\("recovery-error-retry"\)\.addEventListener\("click", \(\) => \{ void loadRecovery\(true\); \}\)/);
});

test("recovery cards show the privacy-safe label and capture time, never payload fields", () => {
  const js = read("app.js");
  const card = body(js, "function recoveryCard");
  assert.match(card, /job\.label/);
  assert.match(body(js, "function recoveryMeta"), /job\.captured_at/);
  const recovery = js.slice(js.indexOf("function diagnosticText"), js.indexOf("async function refreshBadge"));
  assert.doesNotMatch(recovery, /\.payload\b|job\.title\b/);
});

test("bulk retry confirms with the exact number of jobs", () => {
  const js = read("app.js");
  const retryAll = body(js, "async function retryAllRecoveryJobs");
  assert.match(retryAll, /window\.confirm\(retryAllPrompt\(count\)\)/);
  assert.match(js, /function retryAllPrompt\(count\) \{\s*const question = count === 1 \? "Retry 1 failed job\?" : "Retry \{count\} failed jobs\?";/);
  assert.match(retryAll, /showRecoveryError\(/);
});
