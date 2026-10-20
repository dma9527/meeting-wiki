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
  for (const name of ["startWorker", "enqueue", "showSelfCheck", "retryFailedJobs"]) {
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
  const discard = functionBody("discardRecording");
  assert.match(discard, /recordingSession\.end\("discard", async \(\) => \{\s*stopLiveSession\(\);\s*await capture\.discard\(\);/);
  assert.match(source, /label: "Stop and discard", click: \(\) => \{ void discardRecording\(\); \}/);
  const quit = source.slice(source.indexOf('app.on("will-quit"'));
  assert.match(quit, /stopLiveSession\(\);/);
  assert.match(source, /buildEnv: \(\) => processingEnv\(\{ background: true \}\)/);
});

test("the limit, user, and quit stops share one single-flight stop with the same batch path", () => {
  const stop = functionBody("stopRecording");
  assert.match(stop, /^function stopRecording\(reason = "user"\) \{\s*return recordingSession\.end\(reason, async \(\) => \{/);
  assert.match(stop, /if \(reason === "limit"\) notify\(LIMIT_NOTICE\.title, LIMIT_NOTICE\.body\);/);
  assert.match(source, /new RecordingSession\(\{ onLimit: \(\) => \{ void stopRecording\("limit"\); \} \}\)/);
  assert.match(source, /label: "Stop and process", accelerator: "CommandOrControl\+Shift\+0", click: \(\) => \{ void stopRecording\("user"\); \}/);
  assert.match(source, /if \(recordingSession\.recording\) void stopRecording\("user"\);/);
  assert.match(functionBody("enqueue"), /ingests\.track\(child\);/);
});

test("startRecording reads the limit fresh and arms it only after capture starts", () => {
  const start = functionBody("startRecording");
  assert.match(start, /if \(capture\.active \|\| !recordingSession\.idle \|\| quitRequested\) return;/);
  const readAt = start.indexOf("readMaxDurationMinutes(fs, DATA_DIR)");
  const captureAt = start.indexOf("capture.start(timestamp())");
  const beginAt = start.indexOf("recordingSession.begin(maxDurationMinutes * 60_000)");
  assert.ok(readAt >= 0 && captureAt > readAt && beginAt > captureAt);
});

test("quit saves and queues an active recording instead of discarding it", () => {
  const willQuit = source.slice(source.indexOf('app.on("will-quit"'), source.indexOf('app.on("window-all-closed"'));
  assert.doesNotMatch(willQuit, /capture\.discard|discardRecording/);
  const beforeQuit = source.slice(source.indexOf('app.on("before-quit"'), source.indexOf('app.on("will-quit"'));
  assert.match(beforeQuit, /if \(quitPrepared \|\| \(recordingSession\.idle && ingests\.size === 0\)\) return;\s*event\.preventDefault\(\);\s*if \(quitRequested\) return;/);
  assert.match(beforeQuit, /notify\(QUIT_NOTICE\.title, QUIT_NOTICE\.body\)/);
  const prepare = functionBody("prepareQuit");
  const stopAt = prepare.indexOf('await stopRecording("quit");');
  const drainAt = prepare.indexOf("await ingests.drain(QUIT_INGEST_TIMEOUT_MS);");
  const quitAt = prepare.indexOf("app.quit();");
  assert.ok(stopAt >= 0 && drainAt > stopAt && quitAt > drainAt);
  assert.ok(prepare.indexOf("quitPrepared = true;") < quitAt);
});

test("the recording settings save does not restart processing", () => {
  assert.doesNotMatch(functionBody("openSettingsWindow"), /onRecordingSaved|maxDuration/);
});

test("the tray self-check shows only formatted fixed text and never doctor output", () => {
  assert.doesNotMatch(source, /readDoctorStatus|showSystemHealth|Check system health/);
  assert.match(source, /\{ label: "Run self-check\.\.\.", click: \(\) => \{ void showSelfCheck\(\); \} \}/);
  const body = functionBody("showSelfCheck");
  assert.match(body, /const env = available \? processingEnv\(\) : null;/);
  assert.match(body, /await dialog\.showMessageBox\(formatSelfCheck\(report\)\);/);
  assert.match(body, /skillStatus: \(\) => claudeSkillStatus\(\)/);
  assert.doesNotMatch(body, /error\.message|stdout|detail:/);
});
