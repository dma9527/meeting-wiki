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
    "runtime-paths.js",
    "status.js",
    "wiki-window.js",
    "wiki-store.js",
    "corrections-client.js",
    "memory-client.js",
    "preload.js",
    "secret-store.js",
    "skill-installer.js",
    "self-check.js",
    "setting-metadata.js",
    "record-window.js",
    "record-preload.js",
    "skills/meeting-wiki-memory/SKILL.md",
    "managed-config.js",
    "setup-window.js",
    "setup-preload.js",
    "settings-window.js",
    "settings-preload.js",
    "live-session.js",
    "live-sidebar-window.js",
    "live-sidebar-preload.js",
    "recording-session.js",
    "recording-settings.js",
    "auto-record.js",
    "integration-settings.js",
    "integration-service.js",
    "zoom-detector.js",
    "meet-protocol.js",
    "meet-bridge.js",
    "meet-native-host.js",
    "renderer/**",
  ];
  for (const entry of required) {
    assert.ok(files.includes(entry), `build.files is missing ${entry}`);
  }
});

test("the Google Meet extension ships as a resource the main process can find", () => {
  const entry = pkg.build.extraResources.find((resource) => resource.from === "browser-extension");
  assert.ok(entry, "build.extraResources must stage the browser extension");
  assert.equal(entry.to, "browser-extension");
  for (const file of entry.filter) assert.ok(fs.existsSync(path.join(ROOT, "browser-extension", file)), `missing ${file}`);
  const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  assert.match(main, /path\.join\(process\.resourcesPath, "browser-extension", "google-meet"\)/);
  assert.ok(!pkg.build.files.some((file) => file.startsWith("browser-extension")), "the extension must not be inside app.asar");
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
  for (const asset of ["renderer/index.html", "renderer/app.js", "renderer/styles.css", "renderer/settings.html", "renderer/settings.js", "renderer/settings.css", "renderer/live-sidebar.html", "renderer/live-sidebar.js", "renderer/live-sidebar.css", "renderer/record.html", "renderer/record.js", "renderer/record.css"]) {
    assert.ok(fs.existsSync(path.join(ROOT, asset)), `missing renderer asset ${asset}`);
  }
});

test("extraResources ships desktop/runtime at Resources/runtime", () => {
  const resources = pkg.build.extraResources;
  assert.ok(Array.isArray(resources), "build.extraResources must be an array");
  const runtime = resources.find((entry) => entry.from === "runtime");
  assert.ok(runtime, "build.extraResources must stage desktop/runtime");
  assert.equal(runtime.to, "runtime");
  assert.deepEqual(runtime.filter, ["**/*"]);
});

test("extraResources destination matches where runtime-paths looks for bundled tools", () => {
  const { resolveRuntimePaths } = require("../runtime-paths");
  const resourcesPath = "/Applications/Meeting Wiki.app/Contents/Resources";
  const runtime = pkg.build.extraResources.find((entry) => entry.from === "runtime");
  const bundled = ["python", "rec", "sox"].map((name) =>
    path.join(resourcesPath, runtime.to, "bin", name),
  );
  const resolved = resolveRuntimePaths({
    env: {},
    isPackaged: true,
    resourcesPath,
    dataDir: "/Users/test/.meeting-wiki",
    existsSync: (candidate) => bundled.includes(candidate),
  });
  assert.deepEqual([resolved.python, resolved.rec, resolved.sox], bundled);
});

test("runtime staging output is never committed or packaged as app source", () => {
  const ignore = fs.readFileSync(path.join(ROOT, "..", ".gitignore"), "utf8").split("\n");
  assert.ok(ignore.includes("desktop/runtime/"), ".gitignore must exclude desktop/runtime/");
  for (const entry of pkg.build.files) {
    assert.ok(!/^runtime(\/|$)/.test(entry), `build.files must not include ${entry}`);
  }
});
