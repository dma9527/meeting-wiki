"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.js is missing ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  const nextAsync = source.indexOf("\nasync function ", start + 1);
  const ends = [next, nextAsync].filter((index) => index > 0);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test("main never mutates process.env", () => {
  assert.doesNotMatch(source, /process\.env(\.\w+|\[[^\]]+\])\s*=[^=]/);
  assert.doesNotMatch(source, /Object\.assign\(\s*process\.env/);
  assert.doesNotMatch(source, /delete\s+process\.env/);
});

test("main reads the key only through resolveProcessEnv and never names or logs it", () => {
  assert.doesNotMatch(source, /MEETING_WIKI_ONLINE_API_KEY|API_KEY_ENV/);
  assert.doesNotMatch(source, /secretStore\.read\(/);
  assert.doesNotMatch(source, /console\./);
  assert.match(functionBody("processingEnv"), /resolveProcessEnv\(\{ fs, dataDir: DATA_DIR, secretStore, baseEnv: process\.env \}\)/);
  assert.match(functionBody("processingEnv"), /notify\("Meeting processing paused", result\.error\)/);
});

for (const name of ["startWorker", "enqueue"]) {
  test(`${name} passes a per-child env and stops before spawning when the key is unavailable`, () => {
    const body = functionBody(name);
    const envAt = body.indexOf("const env = processingEnv();");
    const guardAt = body.indexOf("if (!env) return;");
    const spawnAt = body.indexOf("spawn(PYTHON");
    assert.ok(envAt >= 0 && guardAt > envAt && spawnAt > guardAt, `${name} must resolve and guard env before spawn`);
    assert.match(body.slice(spawnAt), /\{\s*[^}]*\benv\b/);
  });
}

for (const [name, call] of [
  ["refreshQueueStatus", "readQueueStatus("],
  ["showSystemHealth", "readDoctorStatus("],
  ["retryFailedJobs", "retryDeadJobs("],
]) {
  test(`${name} passes processingEnv to ${call.slice(0, -1)} and stops when the key is unavailable`, () => {
    const body = functionBody(name);
    const envAt = body.search(/const env = processingEnv\((\{ background: true \})?\);/);
    const guardAt = body.indexOf("if (!env)", envAt);
    const callAt = body.indexOf(call);
    assert.ok(envAt >= 0 && guardAt > envAt && callAt > guardAt, `${name} must resolve and guard env before ${call}`);
    assert.match(body.slice(callAt), /^\w+\(PYTHON, CONFIG_PATH, execFile, env\)/);
    assert.match(body.slice(guardAt, callAt), /return;/);
  });
}

test("background status polling notifies once per key outage", () => {
  const body = functionBody("processingEnv");
  assert.match(body, /if \(!background \|\| !keyUnavailableNotified\) notify\(/);
  assert.match(functionBody("refreshQueueStatus"), /processingEnv\(\{ background: true \}\)/);
  for (const name of ["startWorker", "enqueue", "showSystemHealth", "retryFailedJobs"]) {
    assert.doesNotMatch(functionBody(name), /background: true/);
  }
});


test("updateMenu updates the tray image from derived status state", () => {
  assert.match(source, /trayIconState/);
  const body = functionBody("updateMenu");
  assert.match(body, /updateTrayIcon\(\);/);
  assert.match(functionBody("updateTrayIcon"), /tray\.setImage\(icon\(state\)\)/);
});

test("missing Python marks the tray status as attention before returning", () => {
  const body = functionBody("refreshQueueStatus");
  const unavailable = body.indexOf("!pythonAvailable()");
  const statusError = body.indexOf("queueStatusError = true", unavailable);
  const menuUpdate = body.indexOf("updateMenu()", statusError);
  assert.ok(unavailable >= 0 && statusError > unavailable && menuUpdate > statusError);
});

test("startWorker runs Python unbuffered so worker.log receives job events", () => {
  assert.match(functionBody("startWorker"), /spawn\(PYTHON, \["-u", "-m", "meeting_wiki\.cli", "--config", CONFIG_PATH, "worker"\]/);
});

test("the tray menu opens the sandboxed Settings window next to setup", () => {
  const body = functionBody("updateMenu");
  const settingsAt = body.indexOf('{ label: "Settings...", click: openSettingsWindow }');
  assert.ok(settingsAt >= 0, "tray menu is missing Settings...");
  assert.ok(body.indexOf('{ label: "Run setup...", click: openSetupWindow }') > settingsAt);
  assert.match(source, /const \{ createSettingsWindow \} = require\("\.\/settings-window"\);/);
});

test("Settings never receives the secret store, restarts processing on save, and can reopen setup", () => {
  const body = functionBody("openSettingsWindow");
  assert.match(body, /createSettingsWindow\(/);
  assert.doesNotMatch(body, /secretStore|python|spawn/);
  assert.match(body, /onSaved: restartProcessing/);
  assert.match(body, /onRerunSetup: openSetupWindow/);
  assert.match(functionBody("openSetupWindow"), /onComplete: restartProcessing/);
  const restart = functionBody("restartProcessing");
  assert.match(restart, /if \(worker\) worker\.kill\("SIGTERM"\); else startWorker\(\);/);
  assert.match(restart, /void refreshQueueStatus\(\);/);
});

test("live view starts after capture succeeds and cannot break recording", () => {
  const start = functionBody("startRecording");
  const captureAt = start.indexOf("capture.start(timestamp())");
  const liveAt = start.indexOf("startLiveSession(capture.active.micPath, isPrivate)");
  assert.ok(captureAt >= 0 && liveAt > captureAt, "live view must start only after capture starts");
  const live = functionBody("startLiveSession");
  assert.match(live, /if \(!pythonAvailable\(\) \|\| !micPath\) return;/);
  assert.match(live, /try \{[\s\S]*liveSession\.start\(\{ micPath, isPrivate \}\);[\s\S]*\} catch \(_\) \{\}/);
  assert.match(functionBody("stopLiveSession"), /liveSession\.stop\(\)\.catch\(\(\) => \{\}\)/);
});

test("stop, discard, and quit end the live session while batch ingest still runs", () => {
  const stop = functionBody("stopRecording");
  const liveStopAt = stop.indexOf("stopLiveSession();");
  const enqueueAt = stop.indexOf("enqueue(");
  assert.ok(liveStopAt >= 0 && enqueueAt > liveStopAt, "batch ingest must follow live shutdown");
  assert.doesNotMatch(stop, /await\s+liveSession|await\s+stopLiveSession/);
  assert.match(source, /label: "Stop and discard", click: async \(\) => \{ stopLiveSession\(\); await capture\.discard\(\);/);
  const quit = source.slice(source.indexOf('app.on("will-quit"'));
  assert.match(quit, /stopLiveSession\(\);/);
  assert.match(source, /buildEnv: \(\) => processingEnv\(\{ background: true \}\)/);
});
