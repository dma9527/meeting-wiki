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
    assert.equal(result.audioPath, output);
    assert.equal(result.micAudioPath, path.join(dir, "2026-09-04-120000_mic.wav"));
    assert.equal(result.systemAudioPath, null);
    assert.equal(fs.readFileSync(output, "utf8"), "audio");
    assert.equal(fs.readFileSync(result.micAudioPath, "utf8"), "audio");
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.micAudioPath).mode & 0o777, 0o600);
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


test("silent PCM detection distinguishes all-zero system audio from audio samples", () => {
  const { isSilentPcmFile } = require("../capture");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-capture-"));
  const silent = path.join(dir, "silent.raw");
  const audible = path.join(dir, "audible.raw");
  fs.writeFileSync(silent, Buffer.alloc(3200));
  fs.writeFileSync(audible, Buffer.from([0, 0, 1, 0]));

  try {
    assert.equal(isSilentPcmFile(silent), true);
    assert.equal(isSilentPcmFile(audible), false);
    assert.equal(isSilentPcmFile(path.join(dir, "missing.raw")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capture manifest records the recording start and an explicit privacy choice", () => {
  const { buildCaptureManifest, captureManifestPath } = require("../capture");
  const files = {
    audioPath: "/data/audio/2026-09-04-150200.wav",
    micAudioPath: "/data/audio/2026-09-04-150200_mic.wav",
    systemAudioPath: null,
  };
  assert.equal(captureManifestPath(files.audioPath), "/data/audio/2026-09-04-150200.capture.json");
  assert.deepEqual(
    buildCaptureManifest(files, {
      title: "Meeting placeholder",
      titleExplicit: false,
      isPrivate: true,
      recordingStartedAt: "2026-09-04T15:02:00.000Z",
      occurredAt: null,
    }),
    {
      version: 1,
      audio_path: files.audioPath,
      mic_audio_path: files.micAudioPath,
      system_audio_path: null,
      title: "Meeting placeholder",
      title_explicit: false,
      private: true,
      recording_started_at: "2026-09-04T15:02:00.000Z",
      occurred_at: null,
    },
  );
});

test("capture manifest refuses to guess privacy or the recording start", () => {
  const { buildCaptureManifest } = require("../capture");
  const files = { audioPath: "/data/audio/a.wav", micAudioPath: null, systemAudioPath: null };
  const base = { title: "Meeting", titleExplicit: false, isPrivate: false, recordingStartedAt: "2026-09-04T15:02:00.000Z" };
  assert.throws(() => buildCaptureManifest(files, { ...base, isPrivate: undefined }), /privacy/);
  assert.throws(() => buildCaptureManifest(files, { ...base, recordingStartedAt: null }), /recording start/);
  assert.throws(() => buildCaptureManifest(files, { ...base, recordingStartedAt: "not a date" }), /recording start/);
});

test("capture manifest adds the calendar requirement only when it is set", () => {
  const { buildCaptureManifest } = require("../capture");
  const files = { audioPath: "/data/audio/a.wav", micAudioPath: null, systemAudioPath: null };
  const base = { title: "Zoom meeting", titleExplicit: false, isPrivate: false, recordingStartedAt: "2026-09-04T15:02:00.000Z" };
  assert.equal("require_calendar_match" in buildCaptureManifest(files, base), false);
  assert.equal(buildCaptureManifest(files, { ...base, requireCalendarMatch: true }).require_calendar_match, true);
});
