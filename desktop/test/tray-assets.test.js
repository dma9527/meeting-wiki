"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DESKTOP = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(DESKTOP, "main.js"), "utf8");
const pkg = require("../package.json");

test("tray status icons are bundled PNG template assets", () => {
  for (const state of ["idle", "recording", "processing", "attention"]) {
    const asset = `assets/tray-${state}@2x.png`;
    assert.ok(fs.existsSync(path.join(DESKTOP, asset)), `missing ${asset}`);
    assert.ok(pkg.build.files.includes(asset), `package is missing ${asset}`);
  }
  assert.match(main, /nativeImage\.createFromPath/);
  assert.doesNotMatch(main, /nativeImage\.createFromDataURL/);
});
