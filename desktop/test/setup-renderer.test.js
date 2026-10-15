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
