"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { atomicWriteFile } = require("../setup-window");
const recording = require("../recording-settings");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-recording-"));
}

function settingsFile(dataDir) {
  return path.join(dataDir, recording.RECORDING_SETTINGS_FILE);
}

test("the default limit is two hours inside a 15 minute to 8 hour range", () => {
  assert.equal(recording.DEFAULT_MAX_DURATION_MINUTES, 120);
  assert.deepEqual(recording.MAX_DURATION_BOUNDS, { min: 15, max: 480 });
});

test("reads fall back to the default for missing, corrupt, or out-of-range files", () => {
  const dataDir = tempDataDir();
  assert.equal(recording.readMaxDurationMinutes(fs, dataDir), 120);
  for (const text of [
    "{ not json",
    "[]",
    "null",
    JSON.stringify({ recording: { max_duration_minutes: 5 } }),
    JSON.stringify({ recording: { max_duration_minutes: 10_000 } }),
    JSON.stringify({ recording: { max_duration_minutes: "60" } }),
    JSON.stringify({ recording: "60" }),
  ]) {
    fs.writeFileSync(settingsFile(dataDir), text);
    assert.equal(recording.readMaxDurationMinutes(fs, dataDir), 120, text);
  }
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ recording: { max_duration_minutes: 45 } }));
  assert.equal(recording.readMaxDurationMinutes(fs, dataDir), 45);
});

test("validation accepts whole minutes at the bounds and rejects everything else", () => {
  for (const value of [15, 480, "60", " 90 "]) {
    assert.equal(recording.validateMaxDurationMinutes(value), Number(String(value).trim()));
  }
  for (const value of [14, 481, 60.5, "6e1", "", undefined, null, true, "-30", NaN, Infinity]) {
    assert.throws(() => recording.validateMaxDurationMinutes(value), recording.RecordingSettingsError);
  }
});

test("a failed atomic write surfaces a fixed message and leaves the previous file intact", () => {
  const dataDir = tempDataDir();
  const original = JSON.stringify({ recording: { max_duration_minutes: 30 } });
  fs.writeFileSync(settingsFile(dataDir), original);
  const failingWrite = () => { throw new Error(`disk full at ${dataDir}`); };
  assert.throws(
    () => recording.saveMaxDurationMinutes(fs, dataDir, 60, failingWrite),
    (error) => error instanceof recording.RecordingSettingsError && !error.message.includes(dataDir),
  );
  assert.equal(fs.readFileSync(settingsFile(dataDir), "utf8"), original);
});

test("saves create the file owner-only when missing", () => {
  const dataDir = tempDataDir();
  assert.equal(recording.saveMaxDurationMinutes(fs, dataDir, 240, atomicWriteFile), 240);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(dataDir), "utf8")), { recording: { max_duration_minutes: 240 } });
  assert.equal(fs.statSync(settingsFile(dataDir)).mode & 0o777, 0o600);
  assert.equal(recording.readMaxDurationMinutes(fs, dataDir), 240);
});
