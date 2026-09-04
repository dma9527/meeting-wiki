"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AudioCapture, rawToWavArgs, recArgs } = require("../capture");

function fakeChild() {
  const child = new EventEmitter();
  child.kill = (signal) => process.nextTick(() => child.emit("close", 0, signal));
  return child;
}

test("recording commands use argument arrays with 16kHz mono PCM", () => {
  assert.deepEqual(recArgs("/tmp/mic.wav"), [
    "-b", "16", "/tmp/mic.wav", "rate", "16000", "channels", "1",
  ]);
  assert.deepEqual(rawToWavArgs("/tmp/system.raw", "/tmp/system.wav"), [
    "-t", "raw", "-r", "16000", "-e", "signed-integer", "-b", "16",
    "-c", "1", "/tmp/system.raw", "/tmp/system.wav",
  ]);
});

test("mic-only recording finalizes without external merge", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-capture-"));
  const spawned = [];
  const capture = new AudioCapture({
    recordingsDir: dir,
    audioTeePath: "/nonexistent/audiotee",
    recBin: "/fake/rec",
    soxBin: "/fake/sox",
    spawn: (command, args) => {
      spawned.push({ command, args });
      return fakeChild();
    },
  });
  try {
    const output = capture.start("2026-09-04-120000");
    fs.writeFileSync(path.join(dir, "2026-09-04-120000_mic.wav"), "audio");
    const result = await capture.stop();
    assert.equal(result, output);
    assert.equal(fs.readFileSync(output, "utf8"), "audio");
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, "/fake/rec");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("double start and stop-without-active fail loudly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-capture-"));
  const capture = new AudioCapture({
    recordingsDir: dir,
    audioTeePath: "/nonexistent/audiotee",
    spawn: () => fakeChild(),
  });
  try {
    capture.start("one");
    assert.throws(() => capture.start("two"), /already active/);
    await capture.discard();
    await assert.rejects(() => capture.stop(), /no active recording/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("capture process errors are surfaced through callback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-capture-"));
  const errors = [];
  const child = fakeChild();
  const capture = new AudioCapture({
    recordingsDir: dir,
    audioTeePath: "/nonexistent/audiotee",
    spawn: () => child,
    onError: (error) => errors.push(error.message),
  });
  try {
    capture.start("error-test");
    child.emit("error", new Error("rec not found"));
    assert.deepEqual(errors, ["rec not found"]);
    await capture.discard();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
