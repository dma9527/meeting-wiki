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

test("setup.html offers both paths and a data-boundary panel", () => {
  const html = read("setup.html");
  assert.match(html, /id="mode-online"[^>]*value="online"/);
  assert.match(html, /id="mode-local"[^>]*value="local"/);
  assert.match(html, /id="online-base-url"/);
  assert.match(html, /id="online-api-key"[^>]*type="password"/);
  assert.match(html, /<aside class="boundary"/);
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
