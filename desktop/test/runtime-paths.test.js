"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  missingRuntimeMessage,
  resolveAudioBinary,
  resolvePython,
  resolveRuntimePaths,
} = require("../runtime-paths");
const { AudioCapture } = require("../capture");

const RESOURCES = "/Applications/Meeting Wiki.app/Contents/Resources";
const DATA_DIR = "/Users/test/.meeting-wiki";
const BUNDLED = (name) => path.join(RESOURCES, "runtime", "bin", name);

function existsOnly(paths) {
  const present = new Set(paths);
  return (candidate) => present.has(candidate);
}

test("explicit overrides win in packaged and development modes", () => {
  const env = {
    MEETING_WIKI_PYTHON: "/custom/python",
    MEETING_WIKI_REC_BIN: "/custom/rec",
    MEETING_WIKI_SOX_BIN: "/custom/sox",
  };
  for (const isPackaged of [true, false]) {
    const runtime = resolveRuntimePaths({
      env,
      isPackaged,
      resourcesPath: RESOURCES,
      dataDir: DATA_DIR,
      existsSync: existsOnly([BUNDLED("python"), BUNDLED("rec"), BUNDLED("sox"), "/opt/homebrew/bin/rec"]),
    });
    assert.deepEqual(runtime, {
      packaged: isPackaged,
      python: "/custom/python",
      rec: "/custom/rec",
      sox: "/custom/sox",
    });
  }
});

test("packaged mode prefers the bundled runtime over venv and Homebrew", () => {
  const runtime = resolveRuntimePaths({
    env: {},
    isPackaged: true,
    resourcesPath: RESOURCES,
    dataDir: DATA_DIR,
    existsSync: existsOnly([
      BUNDLED("python"),
      BUNDLED("rec"),
      BUNDLED("sox"),
      path.join(DATA_DIR, "venv", "bin", "python"),
      "/opt/homebrew/bin/rec",
      "/opt/homebrew/bin/sox",
    ]),
  });
  assert.deepEqual(runtime, {
    packaged: true,
    python: BUNDLED("python"),
    rec: BUNDLED("rec"),
    sox: BUNDLED("sox"),
  });
});

test("packaged mode fails closed with null when the bundled runtime is absent", () => {
  const runtime = resolveRuntimePaths({
    env: {},
    isPackaged: true,
    resourcesPath: RESOURCES,
    dataDir: DATA_DIR,
    existsSync: existsOnly([
      path.join(DATA_DIR, "venv", "bin", "python"),
      "/opt/homebrew/bin/rec",
      "/opt/homebrew/bin/sox",
      "/usr/local/bin/rec",
      "/usr/local/bin/sox",
    ]),
  });
  assert.deepEqual(runtime, { packaged: true, python: null, rec: null, sox: null });
});

test("packaged mode without resourcesPath fails closed", () => {
  const deps = { env: {}, isPackaged: true, resourcesPath: undefined, dataDir: DATA_DIR, existsSync: () => true };
  assert.equal(resolvePython(deps), null);
  assert.equal(resolveAudioBinary("rec", deps), null);
  assert.equal(resolveAudioBinary("sox", deps), null);
});

test("development mode keeps data-dir venv and Homebrew discovery", () => {
  const deps = {
    env: {},
    isPackaged: false,
    resourcesPath: RESOURCES,
    dataDir: DATA_DIR,
    existsSync: existsOnly([BUNDLED("python"), BUNDLED("rec"), "/opt/homebrew/bin/rec", "/usr/local/bin/sox"]),
  };
  assert.equal(resolvePython(deps), path.join(DATA_DIR, "venv", "bin", "python"));
  assert.equal(resolveAudioBinary("rec", deps), "/opt/homebrew/bin/rec");
  assert.equal(resolveAudioBinary("sox", deps), "/usr/local/bin/sox");
  assert.equal(resolveAudioBinary("sox", { ...deps, existsSync: () => false }), "sox");
});

test("unknown audio binary names are rejected", () => {
  assert.throws(() => resolveAudioBinary("python", { env: {}, existsSync: () => true }), /unknown audio binary/);
});

test("missing-runtime messages distinguish damaged install from development setup", () => {
  for (const name of ["python", "rec", "sox"]) {
    const packaged = missingRuntimeMessage(name, { packaged: true });
    assert.equal(packaged.title, "Meeting Wiki installation damaged");
    assert.match(packaged.body, /Reinstall Meeting Wiki/);
    assert.doesNotMatch(packaged.body, /setup\.sh|brew/);

    const dev = missingRuntimeMessage(name, { packaged: false, resolvedPath: "/dev/python" });
    assert.equal(dev.title, "Meeting Wiki setup required");
    assert.doesNotMatch(dev.body, /Reinstall/);
  }
  assert.match(missingRuntimeMessage("python", { resolvedPath: "/dev/python" }).body, /setup\.sh.*MEETING_WIKI_PYTHON/);
  assert.match(missingRuntimeMessage("sox").body, /brew install sox.*MEETING_WIKI_SOX_BIN/);
});

test("packaged capture refuses to start when bundled rec is absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-runtime-"));
  const spawned = [];
  const capture = new AudioCapture({
    recordingsDir: dir,
    audioTeePath: "/nonexistent/audiotee",
    recBin: null,
    soxBin: null,
    packaged: true,
    spawn: (command) => {
      spawned.push(command);
      throw new Error("spawn must not run");
    },
  });
  try {
    assert.throws(() => capture.start("missing-rec"), /bundled rec audio tool is missing.*Reinstall/);
    assert.equal(capture.active, null);
    assert.deepEqual(spawned, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
