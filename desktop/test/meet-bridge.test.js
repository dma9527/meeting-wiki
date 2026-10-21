"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const bridge = require("../meet-bridge");
const { EXTENSION_ORIGIN, NATIVE_HOST_NAME } = require("../meet-protocol");

const EXEC_PATH = "/Applications/Meeting Wiki's Test.app/Contents/MacOS/Meeting Wiki";
const HOST_SCRIPT = "/Applications/Meeting Wiki's Test.app/Contents/Resources/app.asar/meet-native-host.js";

function tempRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-meet-"));
  const homeDir = path.join(root, "home");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return { root, homeDir, dataDir };
}

function support(homeDir, dir) {
  const target = path.join(homeDir, "Library", "Application Support", dir);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function makeBridge({ homeDir, dataDir }) {
  return bridge.createMeetBridge({ fs, dataDir, homeDir, execPath: EXEC_PATH, hostScript: HOST_SCRIPT });
}

test("pairing installs a manifest pinned to the extension only in browsers that exist", () => {
  const roots = tempRoots();
  support(roots.homeDir, "Google/Chrome");
  support(roots.homeDir, "BraveSoftware/Brave-Browser");
  const meet = makeBridge(roots);
  assert.deepEqual(meet.pair(), ["Google Chrome", "Brave"]);
  const chromeManifest = path.join(roots.homeDir, "Library/Application Support/Google/Chrome/NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
  const manifest = JSON.parse(fs.readFileSync(chromeManifest, "utf8"));
  assert.deepEqual(manifest, {
    name: NATIVE_HOST_NAME,
    description: "Meeting Wiki Google Meet join and leave events",
    path: meet.paths.wrapper,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  });
  assert.equal(fs.statSync(chromeManifest).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(roots.homeDir, "Library/Application Support/Microsoft Edge")));
  assert.equal(fs.statSync(meet.paths.spoolDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(meet.paths.wrapper).mode & 0o777, 0o700);
  const readiness = meet.readiness();
  assert.deepEqual(readiness.browsers.filter((browser) => browser.connected).map((browser) => browser.id), ["chrome", "brave"]);
  assert.equal(readiness.spoolReady, true);
});

test("the wrapper quotes paths and carries no token or secret", () => {
  const roots = tempRoots();
  support(roots.homeDir, "Chromium");
  const meet = makeBridge(roots);
  meet.pair();
  const script = fs.readFileSync(meet.paths.wrapper, "utf8");
  assert.equal(script, bridge.wrapperScript({ execPath: EXEC_PATH, hostScript: HOST_SCRIPT, spoolDir: meet.paths.spoolDir }));
  assert.match(script, /^#!\/bin\/sh\nELECTRON_RUN_AS_NODE=1 exec '\/Applications\/Meeting Wiki'\\''s Test\.app/);
  assert.doesNotMatch(script, /token|secret|key=/i);
  assert.equal(bridge.shellQuote("a'b"), "'a'\\''b'");
});

test("pairing fails clearly when no supported browser exists and writes nothing", () => {
  const roots = tempRoots();
  const meet = makeBridge(roots);
  assert.throws(() => meet.pair(), bridge.MeetPairingError);
  assert.ok(!fs.existsSync(meet.paths.base));
});

test("a stale wrapper, foreign manifest path, or extra origin is not reported as connected", () => {
  const roots = tempRoots();
  support(roots.homeDir, "Google/Chrome");
  const meet = makeBridge(roots);
  meet.pair();
  const manifest = bridge.manifestPath(meet.paths.supportDir, bridge.BROWSERS[0]);
  fs.writeFileSync(manifest, JSON.stringify({ ...bridge.hostManifest(meet.paths.wrapper), allowed_origins: [EXTENSION_ORIGIN, "chrome-extension://other/"] }));
  assert.equal(meet.readiness().browsers[0].connected, false);
  meet.pair();
  assert.equal(meet.readiness().browsers[0].connected, true);
  const moved = bridge.createMeetBridge({ fs, dataDir: roots.dataDir, homeDir: roots.homeDir, execPath: "/Applications/Moved.app/x", hostScript: HOST_SCRIPT });
  assert.equal(moved.readiness().browsers[0].connected, false);
});

test("unpairing removes only this host's manifests, the wrapper, and queued events", () => {
  const roots = tempRoots();
  const chrome = support(roots.homeDir, "Google/Chrome");
  const meet = makeBridge(roots);
  meet.pair();
  const other = path.join(chrome, "NativeMessagingHosts", "com.example.other.json");
  fs.writeFileSync(other, JSON.stringify({ name: "com.example.other" }));
  fs.writeFileSync(path.join(meet.paths.spoolDir, "1700000000000-0123456789abcdef.json"), "{}");
  meet.unpair();
  assert.ok(fs.existsSync(other));
  assert.ok(!fs.existsSync(bridge.manifestPath(meet.paths.supportDir, bridge.BROWSERS[0])));
  assert.ok(!fs.existsSync(meet.paths.base));
  assert.equal(meet.readiness().spoolReady, false);
});

function spoolFile(dir, event, { name } = {}) {
  const fileName = name || `${event.at}-${Math.random().toString(16).slice(2, 10).padEnd(16, "0")}.json`;
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify({ v: 1, ...event }), { mode: 0o600 });
  return fileName;
}

test("draining keeps only valid, fresh events and deletes every file it saw", () => {
  const { root } = tempRoots();
  const dir = path.join(root, "events");
  fs.mkdirSync(dir, { mode: 0o700 });
  const now = 1_800_000_000_000;
  spoolFile(dir, { type: "joined", session: "session-0001", meetingCode: "abc-defg-hij", at: now - 1000 });
  spoolFile(dir, { type: "joined", session: "session-0002", at: now - bridge.STALE_EVENT_MS - 1 });
  spoolFile(dir, { type: "joined", session: "bad session!", at: now });
  spoolFile(dir, { type: "joined", session: "session-0003", transcript: "nope", at: now }, { name: "notes.txt" });
  fs.writeFileSync(path.join(dir, `${now}-ffffffffffffffff.json`), "x".repeat(2048));
  const events = bridge.drainSpool(fs, dir, { now: () => now });
  assert.deepEqual(events, [{ type: "joined", session: "session-0001", meetingCode: "abc-defg-hij", at: now - 1000 }]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("the tracker joins on the first tab, leaves after the last, and times out silent tabs", () => {
  let clock = 1_000;
  const events = [];
  const tracker = new bridge.MeetSessionTracker({
    onJoin: (info) => events.push(["join", info]),
    onLeave: () => events.push(["leave"]),
    now: () => clock,
    timeoutMs: 45_000,
  });
  tracker.apply({ type: "hello", session: "tab-a-0001", at: clock });
  assert.equal(tracker.lastSeenAt, 1_000);
  tracker.apply({ type: "joined", session: "tab-a-0001", meetingCode: "abc-defg-hij", at: 900 });
  tracker.apply({ type: "joined", session: "tab-b-0001", at: 950 });
  tracker.apply({ type: "left", session: "tab-a-0001", at: 1000 });
  assert.deepEqual(events, [["join", { meetingCode: "abc-defg-hij", joinedAt: 900 }]]);
  clock += 30_000;
  tracker.prune();
  assert.equal(events.length, 1);
  clock += 20_000;
  tracker.prune();
  assert.deepEqual(events.at(-1), ["leave"]);
  tracker.apply({ type: "heartbeat", session: "tab-c-0001", at: clock });
  assert.equal(events.at(-1)[0], "join");
  tracker.reset();
  assert.equal(tracker.joined, false);
  assert.equal(events.at(-1)[0], "join");
});

test("the spool watcher discards events queued before it started", () => {
  const { root } = tempRoots();
  const dir = path.join(root, "events");
  fs.mkdirSync(dir, { mode: 0o700 });
  const now = Date.now();
  spoolFile(dir, { type: "joined", session: "old-session-1", at: now - 5 });
  const joins = [];
  const watcher = new bridge.MeetSpoolWatcher({
    fs,
    spoolDir: dir,
    onJoin: (info) => joins.push(info),
    onLeave: () => {},
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  watcher.start();
  watcher.poll();
  assert.deepEqual(joins, []);
  spoolFile(dir, { type: "joined", session: "new-session-1", at: Date.now() });
  watcher.poll();
  assert.equal(joins.length, 1);
  watcher.stop();
  assert.equal(watcher.running, false);
});

test("the bridge opens no socket or port", () => {
  for (const file of ["meet-bridge.js", "meet-native-host.js", "meet-protocol.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /require\("(net|http|https|dgram)"\)|createServer|\.listen\(|console\./, file);
  }
});
