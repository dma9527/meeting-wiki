"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RENDERER = path.join(__dirname, "..", "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

test("setup.html enforces a self-only CSP and loads only local assets", () => {
  const html = read("setup.html");
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(csp, "setup.html is missing a CSP meta tag");
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'"]) {
    assert.ok(csp[1].includes(directive), `CSP is missing ${directive}`);
  }
  assert.match(html, /<script src="setup\.js" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="setup\.css" \/>/);
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//, "setup.html references an external resource");
  assert.doesNotMatch(html, /<script>|\sstyle="|\son[a-z]+="/, "setup.html has inline script or style");
});

test("setup.html offers both online paths and a data-boundary panel", () => {
  const html = read("setup.html");
  assert.match(html, /id="mode-online"[^>]*value="online"/);
  assert.match(html, /id="online-base-url"/);
  assert.match(html, /id="online-api-key"[^>]*type="password"/);
  assert.match(html, /<aside class="boundary"/);
});

test("Local only is shown as unavailable and can never be selected", () => {
  const html = read("setup.html");
  const card = html.match(/<label class="path-card path-card-unavailable"[^]*?<\/label>/);
  assert.ok(card, "Local only card is missing its unavailable state");
  assert.match(card[0], /id="mode-local"[^>]*value="local"[^>]*disabled/);
  assert.match(card[0], /aria-disabled="true"/);
  assert.match(card[0], /Not available in this build/);
  const js = read("setup.js");
  assert.match(js, /const SELECTABLE_MODES = new Set\(\["gemini", "online"\]\);/);
  assert.match(js, /if \(!mode \|\| !SELECTABLE_MODES\.has\(mode\)\)/);
  assert.match(js, /Choose Gemini or Other online API key to continue\./);
  assert.doesNotMatch(js, /Gemini, Other online API key, or Local only/);
});

test("setup.js uses only the setup bridge and never parses markup", () => {
  const js = read("setup.js");
  assert.match(js, /window\.meetingWikiSetup/);
  assert.doesNotMatch(js, /\brequire\(|\bprocess\.|ipcRenderer|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage/);
});

test("setup.css loads no external resources", () => {
  const css = read("setup.css");
  assert.doesNotMatch(css, /@import|url\(/);
});

function section(html, id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `setup.html is missing ${id}`);
  return html.slice(start, html.indexOf("</section>", start));
}

test("setup.html offers Gemini first as the recommended path", () => {
  const html = read("setup.html");
  const choose = section(html, "panel-choose");
  const gemini = choose.indexOf('id="mode-gemini"');
  assert.ok(gemini >= 0, "missing Gemini card");
  assert.ok(gemini < choose.indexOf('id="mode-online"') && gemini < choose.indexOf('id="mode-local"'), "Gemini is not first");
  assert.match(choose, /id="mode-gemini"[^>]*value="gemini"[^>]*aria-describedby="mode-gemini-desc"/);
  assert.match(choose, /Gemini, recommended/);
  assert.equal((choose.match(/class="tag">Recommended</g) || []).length, 0, "another card still claims Recommended");
});

test("the Gemini panel asks only for an API key and the egress acknowledgement", () => {
  const panel = section(read("setup.html"), "panel-gemini");
  const inputs = [...panel.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(inputs.length, 2);
  assert.match(inputs[0], /id="gemini-api-key"[^>]*type="password"|type="password"[^>]*id="gemini-api-key"/);
  assert.match(panel, /id="gemini-api-key"[^>]*autocomplete="off"/);
  assert.match(inputs[1], /id="gemini-egress-ack"[^>]*type="checkbox"/);
  assert.match(panel, /<label for="gemini-api-key">/);
  assert.match(panel, /<label for="gemini-egress-ack">/);
  assert.match(panel, /id="gemini-status"[^>]*role="status"/);
  assert.doesNotMatch(panel, /gemini-3|googleapis|https?:\/\/|base[_-]?url|model/i, "Gemini panel exposes endpoint or model names");
});

test("setup.js drives Gemini only through the narrow Gemini bridge actions", () => {
  const js = read("setup.js");
  assert.match(js, /call\("saveGeminiProvider", \{\s*apiKey:[^}]*acknowledgedEgress: true,?\s*\}\)/);
  assert.match(js, /call\("testGeminiProvider", \{ acknowledgedEgress: true \}\)/);
  assert.match(js, /provider: "gemini"/);
  assert.doesNotMatch(js, /gemini-3|googleapis/);
});

test("every API key field has labelled Show and Paste controls wired to it", () => {
  const html = read("setup.html");
  for (const id of ["gemini-api-key", "online-api-key"]) {
    assert.match(html, new RegExp(`data-key-toggle="${id}" aria-controls="${id}" aria-pressed="false">Show key<`));
    assert.match(html, new RegExp(`data-key-paste="${id}" aria-controls="${id}">Paste<`));
    assert.match(html, new RegExp(`id="${id}-saved" class="hint" hidden`));
    assert.match(html, new RegExp(`aria-describedby="${id}-hint ${id}-saved ${id}-error"`));
  }
});

test("a revealed key re-masks on a timer, on submit, and on step change", () => {
  const js = read("setup.js");
  assert.match(js, /const REVEAL_MS = 20_000;/);
  assert.match(js, /window\.setTimeout\(\(\) => maskKey\(input, \{ announceIt: true \}\), REVEAL_MS\)/);
  assert.match(js, /function goTo\(step\) \{\s*state\.step = step;\s*maskAllKeys\(\);/);
  assert.equal((js.match(/maskKey\(apiKey\);/g) || []).length, 2, "both submits must re-mask");
  assert.match(js, /setAttribute\("aria-pressed", "true"\)/);
});

test("Paste reads the clipboard only through the bridge and never logs or stores it", () => {
  const js = read("setup.js");
  assert.match(js, /call\("readClipboardApiKey"\)/);
  assert.doesNotMatch(js, /navigator\.clipboard|console\./);
  const paste = js.slice(js.indexOf("async function onPasteKey"), js.indexOf("function renderSavedKeyHints"));
  assert.match(paste, /input\.value = result\.value;/);
  assert.doesNotMatch(paste, /state\.|setAttribute\("value"|Storage/);
});

test("a blank key reuses the saved key and the current setup can be tested without changes", () => {
  const js = read("setup.js");
  assert.match(js, /const useSavedKey = !apiKey\.value\.trim\(\) && state\.savedKeys\.gemini;/);
  assert.match(js, /const useSavedKey = !apiKey\.value\.trim\(\) && state\.savedKeys\.openai_compatible;/);
  assert.match(js, /call\("testSavedProvider"\)/);
  const choose = section(read("setup.html"), "panel-choose");
  assert.match(choose, /id="current-setup-test"/);
  assert.match(choose, /keeps working until a new one passes its check/);
});
