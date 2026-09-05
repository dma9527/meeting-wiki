"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const pkg = require("../package.json");

const ROOT = path.join(__dirname, "..");

test("build.files lists every runtime source file that must ship", () => {
  const files = pkg.build.files;
  const required = [
    "main.js",
    "capture.js",
    "status.js",
    "wiki-window.js",
    "wiki-store.js",
    "corrections-client.js",
    "preload.js",
    "renderer/**",
  ];
  for (const entry of required) {
    assert.ok(files.includes(entry), `build.files is missing ${entry}`);
  }
});

test("every packaged path exists on disk", () => {
  for (const entry of pkg.build.files) {
    if (entry.endsWith("/**")) {
      const dir = path.join(ROOT, entry.slice(0, -3));
      assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `missing dir ${entry}`);
    } else {
      assert.ok(fs.existsSync(path.join(ROOT, entry)), `missing file ${entry}`);
    }
  }
  for (const asset of ["renderer/index.html", "renderer/app.js", "renderer/styles.css"]) {
    assert.ok(fs.existsSync(path.join(ROOT, asset)), `missing renderer asset ${asset}`);
  }
});
