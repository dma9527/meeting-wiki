"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RENDERER = path.join(__dirname, "..", "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");
const PAGES = ["index.html", "setup.html", "settings.html", "record.html", "live-sidebar.html"];
const STYLESHEETS = fs.readdirSync(RENDERER).filter((name) => name.endsWith(".css"));

test("every window loads the shared theme before its own styles", () => {
  for (const page of PAGES) {
    const links = [...read(page).matchAll(/<link rel="stylesheet" href="([^"]+)" \/>/g)].map((match) => match[1]);
    assert.equal(links[0], "theme.css", `${page} must load theme.css first`);
  }
});

test("hidden elements stay hidden even when a component sets display", () => {
  assert.match(read("theme.css"), /\[hidden\] \{\s*display: none !important;/);
});

test("every custom property in theme.css is a named declaration", () => {
  const theme = read("theme.css");
  assert.match(theme, /^\s+--font-sans: -apple-system,/m);
  assert.doesNotMatch(theme, /;\s*:/, "a declaration lost its property name");
});

test("only theme.css defines colors, and it covers light and dark", () => {
  const theme = read("theme.css");
  assert.match(theme, /@media \(prefers-color-scheme: dark\)/);
  for (const name of STYLESHEETS.filter((file) => file !== "theme.css")) {
    const css = read(name);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${name} hard-codes a color`);
    assert.doesNotMatch(css, /prefers-color-scheme/, `${name} defines its own dark palette`);
    assert.doesNotMatch(css, /font-family: "/, `${name} sets its own font`);
  }
});

test("stylesheets load nothing external and the only image is the inline brand mark", () => {
  for (const name of STYLESHEETS) {
    const css = read(name);
    assert.doesNotMatch(css, /@import/, `${name} imports a stylesheet`);
    const urls = [...css.matchAll(/url\(("?)([^")]*)/g)].map((match) => match[2]);
    for (const url of urls) {
      if (url.startsWith("%23")) continue;
      assert.ok(url.startsWith("data:image/svg+xml,"), `${name} loads ${url.slice(0, 40)}`);
    }
  }
});

test("window background colors match the theme page color in both modes", () => {
  const { WINDOW_BACKGROUND, windowBackground } = require("../window-background");
  const theme = read("theme.css");
  const [light, dark] = [...theme.matchAll(/--bg: (#[0-9a-f]{6});/g)].map((match) => match[1]);
  assert.deepEqual([WINDOW_BACKGROUND.light, WINDOW_BACKGROUND.dark], [light, dark]);
  assert.equal(windowBackground({ shouldUseDarkColors: true }), dark);
  assert.equal(windowBackground({ shouldUseDarkColors: false }), light);
  assert.equal(windowBackground(null), light);
  for (const file of ["wiki-window.js", "setup-window.js", "settings-window.js", "record-window.js", "live-sidebar-window.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(source, /backgroundColor: windowBackground\(\)/, `${file} must use the shared background`);
  }
});
