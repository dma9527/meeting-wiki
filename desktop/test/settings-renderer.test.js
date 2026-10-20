"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RENDERER = path.join(__dirname, "..", "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

function section(html, id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `settings.html is missing ${id}`);
  return html.slice(start, html.indexOf("</section>", start));
}

test("settings.html enforces a self-only CSP with no network and loads only local assets", () => {
  const html = read("settings.html");
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(csp, "settings.html is missing a CSP meta tag");
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(directive), `CSP is missing ${directive}`);
  }
  assert.match(html, /<script src="settings\.js" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="setup\.css" \/>/);
  assert.match(html, /<link rel="stylesheet" href="settings\.css" \/>/);
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//, "settings.html references an external resource");
  assert.doesNotMatch(html, /<script>|\sstyle="|\son[a-z]+="/, "settings.html has inline script or style");
});

test("the Gemini form edits exactly the five feature values and no key or chunk controls", () => {
  const panel = section(read("settings.html"), "panel-gemini-settings");
  const names = [...panel.matchAll(/<input\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, [
    "batchAudioModel",
    "liveModel",
    "languageModel",
    "translationTargetLanguage",
    "summaryContextCharacters",
  ]);
  assert.doesNotMatch(panel, /type="password"|chunk|overlap|api[_-]?key/i);
  for (const id of ["batch-audio-model", "live-model", "language-model", "translation-target-language", "summary-context-characters"]) {
    assert.match(panel, new RegExp(`<label for="${id}">`));
    assert.match(panel, new RegExp(`id="${id}-error" class="field-error"`));
  }
  assert.match(panel, /id="settings-status"[^>]*role="status"/);
  assert.match(panel, /id="settings-rerun"/);
});

test("the unsupported panel explains the reason and offers to rerun setup", () => {
  const panel = section(read("settings.html"), "panel-unsupported");
  assert.match(panel, /id="unsupported-reason"/);
  assert.match(panel, /id="unsupported-rerun"[^>]*>Run setup again</);
});

test("settings.js uses only the settings bridge and never parses markup or opens a network", () => {
  const js = read("settings.js");
  assert.match(js, /window\.meetingWikiSettings/);
  assert.match(js, /call\("getGeminiSettings"\)/);
  assert.match(js, /call\("saveGeminiSettings", values\)/);
  assert.match(js, /call\("rerunSetup"\)/);
  assert.doesNotMatch(js, /\brequire\(|\bprocess\.|ipcRenderer|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|apiKey|chunk|overlap/);
});

test("settings.css loads no external resources", () => {
  assert.doesNotMatch(read("settings.css"), /@import|url\(/);
});
