"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  LiveSessionManager,
  TOKEN_ENV,
  liveArgs,
  parseReadyLine,
  sanitizeLiveEvent,
} = require("../live-session");

const TEST_KEY = "test-online-key-not-real-0000";
const FIXED_TOKEN = "ab".repeat(32);

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    process.nextTick(() => child.emit("exit", 0, signal));
    return true;
  };
  return child;
}

class FakeSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    this.on(name, listener);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }

  deliver(message) {
    this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) });
  }
}
FakeSocket.instances = [];

function harness(overrides = {}) {
  FakeSocket.instances = [];
  const spawned = [];
  const events = [];
  const manager = new LiveSessionManager({
    spawn: (command, args, options) => {
      const child = fakeChild();
      spawned.push({ command, args, options, child });
      return child;
    },
    python: "/fake/python",
    configPath: "/fake/config.toml",
    buildEnv: () => ({ PATH: "/usr/bin", MEETING_WIKI_ONLINE_API_KEY: TEST_KEY }),
    WebSocketImpl: FakeSocket,
    randomBytes: () => Buffer.from(FIXED_TOKEN, "hex"),
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { manager, spawned, events };
}

async function readySession(options) {
  const context = harness(options);
  assert.equal(context.manager.start({ micPath: "/fake/audio/mic.wav", isPrivate: true }), true);
  context.spawned[0].child.stdout.write(`${JSON.stringify({ type: "ready", port: 45_678 })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeSocket.instances[0];
  socket.emit("open");
  return { ...context, socket };
}

test("live args are an argument array and never carry the token", () => {
  assert.deepEqual(liveArgs("/c.toml", "/a/mic.wav", false), [
    "-u", "-m", "meeting_wiki.cli", "--config", "/c.toml", "live", "--mic-audio", "/a/mic.wav",
  ]);
  assert.deepEqual(liveArgs("/c.toml", "/a/mic.wav", true).slice(-1), ["--private"]);
});

test("start spawns one child with the token only in its environment", () => {
  const { manager, spawned, events } = harness();
  assert.equal(manager.start({ micPath: "/fake/audio/mic.wav", isPrivate: false }), true);
  assert.equal(manager.start({ micPath: "/fake/audio/mic.wav", isPrivate: false }), false);
  assert.equal(spawned.length, 1);
  const [{ command, args, options }] = spawned;
  assert.equal(command, "/fake/python");
  assert.ok(!args.join(" ").includes(FIXED_TOKEN));
  assert.equal(options.env[TOKEN_ENV], FIXED_TOKEN);
  assert.equal(options.env.MEETING_WIKI_ONLINE_API_KEY, TEST_KEY);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
  assert.deepEqual(events, [{ type: "state", phase: "starting", private: false }]);
  manager.stop();
});

test("ready connects only to loopback and authenticates with the session token", async () => {
  const { socket, manager } = await readySession();
  assert.equal(socket.url, "ws://127.0.0.1:45678");
  assert.deepEqual(socket.sent.map((data) => JSON.parse(data)), [
    { type: "authenticate", token: FIXED_TOKEN },
  ]);
  await manager.stop();
});

test("received events are sanitized, ordered, and never carry token, paths, or keys", async () => {
  const { socket, events, manager } = await readySession();
  events.length = 0;
  socket.deliver({ type: "state", payload: { phase: "listening", private: false, scope: "external", path: "/fake/audio/mic.wav" } });
  socket.deliver({ type: "transcript", payload: { sequence: 1, text: "  Hello\n team  ", extra: TEST_KEY } });
  socket.deliver({ type: "transcript", payload: { sequence: 1, text: "Replayed" } });
  socket.deliver({ type: "translation", payload: { sequence: 1, text: "你好团队" } });
  socket.deliver({ type: "summary", payload: { sequence: 1, points: ["One", 7, "", "Two"] } });
  socket.deliver({ type: "raw_audio", payload: { sequence: 2, text: "nope" } });
  socket.deliver("not json");
  socket.deliver({ type: "transcript", payload: { sequence: 0, text: "bad sequence" } });
  assert.deepEqual(events, [
    { type: "state", phase: "listening", private: true, scope: "external" },
    { type: "transcript", sequence: 1, text: "Hello team" },
    { type: "translation", sequence: 1, text: "你好团队" },
    { type: "summary", sequence: 1, points: ["One", "Two"] },
  ]);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(FIXED_TOKEN));
  assert.ok(!serialized.includes(TEST_KEY));
  assert.ok(!serialized.includes("/fake/"));
  await manager.stop();
});

test("a child-reported terminal state is kept once and later close signals are ignored", async () => {
  const context = await readySession();
  context.events.length = 0;
  context.socket.deliver({
    type: "state",
    payload: { phase: "unavailable", issue: "provider_unavailable" },
  });
  context.socket.close();
  context.spawned[0].child.emit("exit", 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(context.manager.active, false);
  assert.deepEqual(context.events, [
    {
      type: "state",
      phase: "unavailable",
      private: true,
      issue: "provider_unavailable",
    },
  ]);
});

test("stop closes the socket, terminates the child, and ignores late events", async () => {
  const { socket, events, spawned, manager } = await readySession();
  await manager.stop();
  assert.equal(manager.active, false);
  assert.equal(socket.closed, true);
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  assert.deepEqual(events.at(-1), { type: "state", phase: "stopped", private: true });
  const count = events.length;
  socket.deliver({ type: "transcript", payload: { sequence: 9, text: "late" } });
  assert.equal(events.length, count);
  await manager.stop();
  assert.equal(spawned[0].child.signals.length, 1);
});

test("an unexpected child exit or socket close ends the session as unavailable", async () => {
  const exited = await readySession();
  exited.spawned[0].child.emit("exit", 1);
  assert.deepEqual(exited.events.at(-1), { type: "state", phase: "unavailable", private: true, issue: "connection_lost" });
  assert.equal(exited.manager.active, false);
  assert.equal(exited.socket.closed, true);

  const closed = await readySession();
  closed.socket.close();
  assert.equal(closed.events.at(-1).issue, "connection_lost");
  assert.equal(closed.manager.active, false);
});

test("a bad ready line, a startup timeout, or a spawn error fails closed without throwing", async () => {
  for (const line of ["oops\n", `${JSON.stringify({ type: "ready", port: 80 })}\n`, `${JSON.stringify({ type: "ready", port: "1" })}\n`]) {
    const { manager, spawned, events } = harness();
    manager.start({ micPath: "/fake/mic.wav", isPrivate: false });
    spawned[0].child.stdout.write(line);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.active, false);
    assert.equal(events.at(-1).issue, "startup_failed");
    assert.equal(FakeSocket.instances.length, 0);
    assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  }

  const timed = harness({ readyTimeoutMs: 10 });
  timed.manager.start({ micPath: "/fake/mic.wav", isPrivate: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timed.manager.active, false);
  assert.equal(timed.events.at(-1).issue, "startup_failed");

  const throwing = harness({ spawn: () => { throw new Error("ENOENT /fake/python"); } });
  assert.equal(throwing.manager.start({ micPath: "/fake/mic.wav", isPrivate: false }), false);
  assert.deepEqual(throwing.events, [{ type: "state", phase: "unavailable", private: false, issue: "startup_failed" }]);
});

test("a missing environment or audio path never spawns", () => {
  for (const overrides of [{ buildEnv: () => null }, { buildEnv: () => { throw new Error("locked"); } }, { python: null }]) {
    const { manager, spawned, events } = harness(overrides);
    assert.equal(manager.start({ micPath: "/fake/mic.wav", isPrivate: false }), false);
    assert.equal(spawned.length, 0);
    assert.equal(events.at(-1).phase, "unavailable");
  }
  const { manager, spawned } = harness();
  assert.equal(manager.start({ micPath: "", isPrivate: false }), false);
  assert.equal(spawned.length, 0);
});

test("parseReadyLine and sanitizeLiveEvent accept only known shapes", () => {
  assert.equal(parseReadyLine('{"type":"ready","port":50000}'), 50000);
  assert.equal(parseReadyLine('{"type":"error","port":50000}'), null);
  assert.equal(sanitizeLiveEvent({ type: "state", payload: { phase: "hacked" } }), null);
  assert.deepEqual(
    sanitizeLiveEvent({ type: "state", payload: { phase: "unavailable", issue: "Traceback /Users/x" } }),
    { type: "state", phase: "unavailable", private: false },
  );
  const long = sanitizeLiveEvent({ type: "transcript", payload: { sequence: 3, text: "x".repeat(5000) } });
  assert.equal(long.text.length, 2000);
  assert.equal(sanitizeLiveEvent({ type: "transcript", payload: { sequence: 3, text: "   " } }), null);
});

test("sanitizeLiveEvent keeps provider renewal and expiry as distinct fixed issues", () => {
  assert.deepEqual(
    sanitizeLiveEvent({ type: "state", payload: { phase: "listening", issue: "provider_session_renewing" } }),
    { type: "state", phase: "listening", private: false, issue: "provider_session_renewing" },
  );
  assert.deepEqual(
    sanitizeLiveEvent({ type: "state", payload: { phase: "unavailable", issue: "provider_session_expired" } }),
    { type: "state", phase: "unavailable", private: false, issue: "provider_session_expired" },
  );
});
