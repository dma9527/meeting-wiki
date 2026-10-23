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

test("startWorker passes a per-child env and schedules a bounded retry when the key is unavailable", () => {
  const body = functionBody("startWorker");
  const envAt = body.indexOf("const env = processingEnv({ background });");
  const guardAt = body.indexOf("if (!env) {", envAt);
  const retryAt = body.indexOf("scheduleWorkerStart();", guardAt);
  const spawnAt = body.indexOf("spawn(PYTHON");
  assert.ok(envAt >= 0 && guardAt > envAt && retryAt > guardAt && spawnAt > retryAt, "startWorker must guard env and retry before spawn");
  assert.match(body.slice(spawnAt), /\{\s*[^}]*\benv\b/);
  assert.match(body, /worker\.once\("exit", \(\) => \{[\s\S]*workerBackoff\.reset\(\);[\s\S]*scheduleWorkerStart\(\);/);
  const schedule = functionBody("scheduleWorkerStart");
  assert.match(schedule, /workerBackoff\.nextDelayMs\(\)/);
  assert.match(schedule, /startWorker\(\{ background: true \}\)/);
  assert.match(schedule, /\.unref\(\)/);
  assert.match(source, /const workerBackoff = new RestartBackoff\(/);
});

test("restartProcessing resets the worker backoff so recovered credentials start immediately", () => {
  const body = functionBody("restartProcessing");
  const resetAt = body.indexOf("workerBackoff.reset();");
  assert.ok(resetAt >= 0 && resetAt < body.indexOf("startWorker();"));
});

test("enqueue never needs provider credentials to create the durable job", () => {
  const body = functionBody("enqueue");
  assert.doesNotMatch(body, /processingEnv/);
  const envAt = body.indexOf("const env = ingestEnv();");
  const spawnAt = body.indexOf("spawn(PYTHON");
  assert.ok(envAt >= 0 && spawnAt > envAt, "enqueue must use the credential-free env");
  assert.match(body.slice(spawnAt), /\{\s*[^}]*\benv\b/);
  assert.match(functionBody("ingestEnv"), /credentialFreeEnv\(process\.env\)/);
});

test("finalized recordings are handed off through a durable capture manifest", () => {
  const stop = functionBody("stopRecording");
  const stopAt = stop.indexOf("await capture.stop()");
  const manifestAt = stop.indexOf("atomicWriteFile(fs, manifestPath");
  const enqueueAt = stop.indexOf('enqueue(["--capture-manifest", manifestPath]');
  assert.ok(stopAt >= 0 && manifestAt > stopAt && enqueueAt > manifestAt, "manifest must be written before enqueue");
  assert.match(stop, /recordingStartedAt/);
  assert.match(functionBody("startRecording"), /capture\.active\.recordingStartedAt = new Date\(\)\.toISOString\(\);/);
});

test("imported audio carries no source time, so it is never matched to the current event", () => {
  const body = functionBody("importAudio");
  assert.doesNotMatch(body, /recordingStartedAt|occurredAt|--occurred-at|--recording-started-at/);
});

test("startup recovers finalized captures that were never enqueued", () => {
  const body = functionBody("recoverPendingCaptures");
  assert.match(body, /execFile\(PYTHON, \["-m", "meeting_wiki\.cli", "--config", CONFIG_PATH, "recover-captures"\]/);
  assert.match(body, /env: ingestEnv\(\)/);
  assert.doesNotMatch(body, /processingEnv/);
  const ready = source.slice(source.indexOf("app.whenReady()"));
  assert.match(ready, /recoverPendingCaptures\(\);/);
});

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
  const liveAt = start.indexOf("startLiveSession(activeCapture.micPath, systemPath, isPrivate, liveDecision)");
  assert.ok(captureAt >= 0 && liveAt > captureAt, "live view must start only after capture starts");
  const live = functionBody("startLiveSession");
  assert.match(live, /if \(!pythonAvailable\(\) \|\| !micPath\) return false;/);
  assert.match(live, /if \(live\.live === "ready"\) \{\s*try \{ createLiveSidebarWindow\(\{ BrowserWindow \}, \{ uiLanguage: currentUiLanguage\(\) \}\); \} catch \(_\) \{\}\s*\}/);
  assert.match(live, /return liveSession\.start\(\{ micPath, systemPath, isPrivate \}\) === true;/);
  assert.match(functionBody("currentUiLanguage"), /readManagedLanguage\(readConfigText\(\)\)/);
  assert.match(functionBody("currentUiLanguage"), /LANGUAGE_VALUES\.uiLanguage\.includes\(languages\.uiLanguage\) \? languages\.uiLanguage : "system"/);
  assert.match(start, /const systemPath = activeCapture\.system \? activeCapture\.rawPath : null;/);
  assert.match(functionBody("stopLiveSession"), /liveSession\.stop\(\)\.catch\(\(\) => \{\}\)/);
});

test("recording notifications never expose automatic meeting codes, paths, or raw errors", () => {
  const start = functionBody("startRecording");
  const stop = functionBody("stopRecording");
  assert.match(start, /source \? "Automatic recording is running\." : title/);
  assert.doesNotMatch(start, /notify\([^\n]*error\.message/);
  assert.doesNotMatch(stop, /notify\([^\n]*files\.audioPath|notify\([^\n]*error\.message/);
  assert.match(stop, /The recording was saved and queued for processing\./);
});

test("unsupported live providers notify only once per configuration", () => {
  const body = functionBody("notifyLiveUnavailable");
  assert.match(body, /if \(issue === "no_adapter"\)/);
  assert.match(body, /if \(noAdapterNotified\) return;/);
  assert.match(functionBody("restartProcessing"), /noAdapterNotified = false;/);
});

test("live unavailability is surfaced with fixed messages while recording continues", () => {
  const start = functionBody("startRecording");
  assert.match(start, /notifyLiveUnavailable\(liveIssue\)/);
  assert.match(source, /if \(liveIssue && liveIssue !== previousIssue\) \{\s*notifyLiveUnavailable\(liveIssue\);/);
  assert.match(functionBody("updateMenu"), /Live captions, translation, and summary unavailable\. Recording continues\./);
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
  assert.match(stop, /^function stopRecording\(reason = "user"\) \{\s*autoLiveStart\.cancel\(\);\s*return recordingSession\.end\(reason, async \(\) => \{/);
  assert.match(stop, /if \(reason === "limit"\) notify\(LIMIT_NOTICE\.title, LIMIT_NOTICE\.body\);/);
  assert.match(source, /new RecordingSession\(\{ onLimit: \(\) => \{ void stopRecording\("limit"\); \} \}\)/);
  assert.match(source, /label: "Stop and process", accelerator: "CommandOrControl\+Shift\+0", click: \(\) => \{ void stopRecording\("user"\); \}/);
  assert.match(source, /if \(recordingSession\.recording\) void stopRecording\("user"\);/);
  assert.match(functionBody("enqueue"), /ingests\.track\(child\);/);
});

test("startRecording reads the limit fresh and arms it only after capture starts", () => {
  const start = functionBody("startRecording");
  assert.match(start, /if \(capture\.active \|\| !recordingSession\.idle \|\| quitRequested\) return false;/);
  const readAt = start.indexOf("readMaxDurationMinutes(fs, DATA_DIR)");
  const captureAt = start.indexOf("capture.start(timestamp())");
  const beginAt = start.indexOf("recordingSession.begin(maxDurationMinutes * 60_000)");
  assert.ok(readAt >= 0 && captureAt > readAt && beginAt > captureAt);
});

test("quit saves and queues an active recording instead of discarding it", () => {
  const willQuit = source.slice(source.indexOf('app.on("will-quit"'), source.indexOf('app.on("window-all-closed"'));
  assert.doesNotMatch(willQuit, /capture\.discard|discardRecording/);
  const beforeQuit = source.slice(source.indexOf('app.on("before-quit"'), source.indexOf('app.on("will-quit"'));
  assert.match(beforeQuit, /if \(quitPrepared \|\| \(recordingSession\.idle && ingests\.size === 0\)\) \{[^}]*destroyLiveSidebar\(\);\s*return;\s*\}\s*event\.preventDefault\(\);\s*if \(quitRequested\) return;/);
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

test("tray bulk retry confirms the job count before retrying", () => {
  const retry = functionBody("retryFailedJobs");
  const confirmAt = retry.indexOf("dialog.showMessageBox(retryConfirmation(count))");
  assert.ok(confirmAt >= 0 && retry.indexOf("retryDeadJobs(") > confirmAt, "retry must follow confirmation");
  assert.match(retry, /if \(choice\.response !== 0\) return;/);
  assert.match(functionBody("retryConfirmation"), /message: `Retry \$\{count\} failed job/);
});

test("automatic starts take privacy from the saved mode, manual starts from the panel", () => {
  const start = functionBody("startRecording");
  assert.match(start, /const auto = source \? autoRecordStartOptions\(readAutoRecordPrivacy\(fs, DATA_DIR\)\.mode\) : null;/);
  assert.match(start, /const liveEnabled = source\s*\? recordingDefaults\.configured && recordingDefaults\.values\.liveEnabled\s*:\s*requestedLive === true;/);
  assert.match(start, /const isPrivate = auto \? auto\.isPrivate : requestedPrivate === true;/);
  assert.match(start, /capture\.active\.requireCalendarMatch = Boolean\(auto && auto\.requireCalendarMatch\);/);
  const stop = functionBody("stopRecording");
  assert.match(stop, /requireCalendarMatch/);
  assert.match(functionBody("audioIngestArgs"), /if \(requireCalendarMatch\) args\.push\("--require-calendar-match"\);/);
});

test("a proceeding quit destroys the hide-on-close live sidebar so it cannot cancel the quit", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const handler = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf('app.on("will-quit"'));
  assert.match(handler, /if \(quitPrepared \|\| \(recordingSession\.idle && ingests\.size === 0\)\) \{\s*\/\/[^\n]*\n\s*destroyLiveSidebar\(\);\s*return;/);
});
