"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = require("../meet-native-host");
const { MeetSpoolWatcher } = require("../meet-bridge");
const { AutoRecordCoordinator } = require("../auto-record");
const { EXTENSION_ORIGIN } = require("../meet-protocol");

const HOST_SCRIPT = path.join(__dirname, "..", "meet-native-host.js");

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function privateSpool() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-host-"));
  const spool = path.join(root, "events");
  fs.mkdirSync(spool, { mode: 0o700 });
  fs.chmodSync(spool, 0o700);
  return { root, spool };
}

function runHostProcess(args, frames) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOST_SCRIPT, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => resolve({ code, output }));
    for (const chunk of frames) child.stdin.write(chunk);
    child.stdin.end();
  });
}

function spoolEvents(spool) {
  return fs.readdirSync(spool).sort().map((name) => {
    assert.match(name, /^\d{13}-[a-f0-9]{16}\.json$/);
    assert.equal(fs.statSync(path.join(spool, name)).mode & 0o777, 0o600);
    return JSON.parse(fs.readFileSync(path.join(spool, name), "utf8"));
  });
}

test("the host writes one private file per valid message and prints nothing", async () => {
  const { spool } = privateSpool();
  const result = await runHostProcess(["--spool", spool, EXTENSION_ORIGIN, "--parent-window=0"], [
    frame({ type: "joined", session: "11111111-2222-3333-4444-555555555555", meetingCode: "abc-defg-hij", chat: "secret" }),
    frame({ type: "transcript", session: "11111111-2222-3333-4444-555555555555" }),
    frame({ type: "left", session: "11111111-2222-3333-4444-555555555555" }),
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.output, "");
  const events = spoolEvents(spool);
  assert.deepEqual(events.map(({ type, meetingCode, chat }) => ({ type, meetingCode, chat })), [
    { type: "joined", meetingCode: "abc-defg-hij", chat: undefined },
    { type: "left", meetingCode: undefined, chat: undefined },
  ]);
});

test("same-millisecond events keep native-message order in the spool", () => {
  const { spool } = privateSpool();
  const write = host.createEventWriter(fs, spool, () => 1_700_000_000_000);

  assert.equal(write({ type: "joined", session: "11111111-2222-3333-4444-555555555555" }), true);
  assert.equal(write({ type: "left", session: "11111111-2222-3333-4444-555555555555" }), true);

  assert.deepEqual(spoolEvents(spool).map(({ type }) => type), ["joined", "left"]);
});

test("the host refuses any caller other than the paired extension", async () => {
  const { spool } = privateSpool();
  const result = await runHostProcess(["--spool", spool, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"], [
    frame({ type: "joined", session: "11111111-2222-3333-4444-555555555555" }),
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(fs.readdirSync(spool), []);
});

test("the host drops events when the spool is missing or not private", async () => {
  const { root, spool } = privateSpool();
  fs.chmodSync(spool, 0o755);
  await runHostProcess(["--spool", spool, EXTENSION_ORIGIN], [frame({ type: "hello", session: "11111111-2222-3333-4444-555555555555" })]);
  assert.deepEqual(fs.readdirSync(spool), []);
  const missing = path.join(root, "missing");
  await runHostProcess(["--spool", missing, EXTENSION_ORIGIN], [frame({ type: "hello", session: "11111111-2222-3333-4444-555555555555" })]);
  assert.ok(!fs.existsSync(missing));
});

test("an oversized frame ends the host before anything is written", async () => {
  const { spool } = privateSpool();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1 << 20, 0);
  const result = await runHostProcess(["--spool", spool, EXTENSION_ORIGIN], [header]);
  assert.equal(result.code, 1);
  assert.deepEqual(fs.readdirSync(spool), []);
});

test("frame reader handles split and joined chunks", () => {
  const seen = [];
  const read = host.createFrameReader((message) => seen.push(message), () => seen.push("invalid"));
  const both = Buffer.concat([frame({ a: 1 }), frame({ b: 2 })]);
  read(both.subarray(0, 3));
  read(both.subarray(3, 12));
  read(both.subarray(12));
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test("join and leave flow from the host through the spool into one recording start and stop", async () => {
  const { spool } = privateSpool();
  const calls = [];
  let elapsed = 0;
  const coordinator = new AutoRecordCoordinator({
    canStart: () => true,
    start: async (request) => { calls.push(["start", request]); return true; },
    stop: async () => { calls.push(["stop"]); },
    discard: async () => { calls.push(["discard"]); },
    elapsedMs: () => elapsed,
  });
  const pending = [];
  const watcher = new MeetSpoolWatcher({
    fs,
    spoolDir: spool,
    onJoin: (info) => pending.push(coordinator.join("google-meet", info)),
    onLeave: () => pending.push(coordinator.leave("google-meet")),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  watcher.start();
  const session = "11111111-2222-3333-4444-555555555555";
  await runHostProcess(["--spool", spool, EXTENSION_ORIGIN], [
    frame({ type: "hello", session }),
    frame({ type: "joined", session, meetingCode: "abc-defg-hij" }),
    frame({ type: "heartbeat", session, meetingCode: "abc-defg-hij" }),
  ]);
  watcher.poll();
  await Promise.all(pending);
  elapsed = 60_000;
  await runHostProcess(["--spool", spool, EXTENSION_ORIGIN], [frame({ type: "left", session })]);
  watcher.poll();
  await Promise.all(pending);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "start");
  assert.equal(calls[0][1].title, "Google Meet abc-defg-hij");
  assert.equal(calls[0][1].source, "google-meet");
  assert.match(calls[0][1].occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(calls[1], ["stop"]);
  watcher.stop();
});
