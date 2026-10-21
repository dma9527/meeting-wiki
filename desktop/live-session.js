"use strict";

// Electron-owned live session. Spawns `meeting-wiki live` for one recording, is the only
// WebSocket client of its loopback bridge, and forwards a sanitized display view. The
// session token, port, audio paths, and child environment never leave the main process.
// Live is display-only: every failure here is contained so capture and batch ingest continue.

const crypto = require("crypto");

const TOKEN_ENV = "MEETING_WIKI_LIVE_TOKEN";
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 3_000;
const MAX_STDOUT_BYTES = 4_096;
const MAX_MESSAGE_CHARS = 65_536;
const LIMITS = Object.freeze({ text: 2_000, point: 400, points: 5 });
const PHASES = new Set(["starting", "listening", "stopped", "unavailable"]);
const SCOPES = new Set(["local", "external"]);
const ISSUES = new Set([
  "audio_unavailable",
  "audio_unsupported",
  "provider_unavailable",
  "transcription_error",
  "language_error",
  "provider_session_renewing",
  "provider_session_expired",
  "startup_failed",
  "connection_lost",
]);
const ORDERED_TYPES = new Set(["transcript", "translation", "summary"]);

function liveArgs(configPath, micPath, isPrivate) {
  const args = ["-u", "-m", "meeting_wiki.cli", "--config", configPath, "live", "--mic-audio", micPath];
  if (isPrivate) args.push("--private");
  return args;
}

function clip(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function stateView(source) {
  const payload = source && typeof source === "object" ? source : {};
  if (!PHASES.has(payload.phase)) return null;
  const view = { type: "state", phase: payload.phase, private: payload.private === true };
  if (SCOPES.has(payload.scope)) view.scope = payload.scope;
  if (ISSUES.has(payload.issue)) view.issue = payload.issue;
  return view;
}

// Returns a renderer-safe event built from known fields only, or null.
function sanitizeLiveEvent(message) {
  if (!message || typeof message !== "object") return null;
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  if (message.type === "state") return stateView(payload);
  if (!ORDERED_TYPES.has(message.type)) return null;
  const sequence = payload.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  if (message.type === "summary") {
    if (!Array.isArray(payload.points)) return null;
    const points = payload.points
      .map((point) => clip(point, LIMITS.point))
      .filter(Boolean)
      .slice(0, LIMITS.points);
    return { type: "summary", sequence, points };
  }
  const text = clip(payload.text, LIMITS.text);
  return text ? { type: message.type, sequence, text } : null;
}

function parseReadyLine(line) {
  try {
    const message = JSON.parse(line);
    const port = message && message.type === "ready" ? message.port : null;
    return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : null;
  } catch (_) {
    return null;
  }
}

class LiveSessionManager {
  constructor(options) {
    this.spawn = options.spawn;
    this.python = options.python;
    this.configPath = options.configPath;
    this.buildEnv = options.buildEnv;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.onEvent = options.onEvent || (() => {});
    this.readyTimeoutMs = options.readyTimeoutMs || READY_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs || STOP_TIMEOUT_MS;
    this.session = null;
  }

  get active() {
    return Boolean(this.session);
  }

  emit(session, event) {
    if (this.session !== session || !event) return;
    try { this.onEvent(event); } catch (_) {}
  }

  // Ends a session after a failure; the child and socket are always torn down.
  fail(session, issue) {
    if (this.session !== session) return;
    this.emit(session, { type: "state", phase: "unavailable", private: session.private, issue });
    this.session = null;
    this.teardown(session);
  }

  start({ micPath, isPrivate }) {
    if (this.session) return false;
    const isPrivateSession = isPrivate === true;
    let env;
    try {
      env = this.python && micPath && this.WebSocketImpl ? this.buildEnv() : null;
    } catch (_) {
      env = null;
    }
    if (!env) {
      this.notifyUnavailable(isPrivateSession);
      return false;
    }
    const token = this.randomBytes(32).toString("hex");
    let child;
    try {
      child = this.spawn(this.python, liveArgs(this.configPath, micPath, isPrivateSession), {
        detached: false,
        env: { ...env, [TOKEN_ENV]: token },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (_) {
      this.notifyUnavailable(isPrivateSession);
      return false;
    }
    const session = {
      child,
      token,
      private: isPrivateSession,
      socket: null,
      stdout: "",
      lastSequence: {},
      readyTimer: null,
      exited: false,
    };
    this.session = session;
    this.emit(session, { type: "state", phase: "starting", private: isPrivateSession });
    session.readyTimer = setTimeout(() => this.fail(session, "startup_failed"), this.readyTimeoutMs);
    if (session.readyTimer.unref) session.readyTimer.unref();
    child.once("error", () => this.fail(session, "startup_failed"));
    child.once("exit", () => {
      session.exited = true;
      this.fail(session, session.socket ? "connection_lost" : "startup_failed");
    });
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      const onData = (chunk) => {
        session.stdout += chunk;
        const newline = session.stdout.indexOf("\n");
        if (newline < 0) {
          if (session.stdout.length > MAX_STDOUT_BYTES) this.fail(session, "startup_failed");
          return;
        }
        child.stdout.removeListener("data", onData);
        child.stdout.resume();
        const port = parseReadyLine(session.stdout.slice(0, newline));
        session.stdout = "";
        if (port === null) this.fail(session, "startup_failed");
        else this.connect(session, port);
      };
      child.stdout.on("data", onData);
    }
    return true;
  }

  notifyUnavailable(isPrivate) {
    try {
      this.onEvent({ type: "state", phase: "unavailable", private: isPrivate, issue: "startup_failed" });
    } catch (_) {}
  }

  connect(session, port) {
    if (this.session !== session) return;
    clearTimeout(session.readyTimer);
    let socket;
    try {
      socket = new this.WebSocketImpl(`ws://127.0.0.1:${port}`);
    } catch (_) {
      this.fail(session, "startup_failed");
      return;
    }
    session.socket = socket;
    socket.addEventListener("open", () => {
      if (this.session !== session) return;
      socket.send(JSON.stringify({ type: "authenticate", token: session.token }));
    });
    socket.addEventListener("message", (event) => this.receive(session, event && event.data));
    socket.addEventListener("error", () => this.fail(session, "connection_lost"));
    socket.addEventListener("close", () => this.fail(session, "connection_lost"));
  }

  receive(session, data) {
    if (this.session !== session) return;
    if (typeof data !== "string" || data.length > MAX_MESSAGE_CHARS) return;
    let message;
    try { message = JSON.parse(data); } catch (_) { return; }
    const event = sanitizeLiveEvent(message);
    if (!event) return;
    if (event.type === "state") {
      // The session's privacy is fixed by main at start, never by the child.
      this.emit(session, { ...event, private: session.private });
      return;
    }
    const last = session.lastSequence[event.type] || 0;
    if (event.sequence <= last) return;
    session.lastSequence[event.type] = event.sequence;
    this.emit(session, event);
  }

  teardown(session) {
    clearTimeout(session.readyTimer);
    if (session.socket) {
      try { session.socket.close(1000); } catch (_) {}
    }
    if (session.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        try { session.child.kill("SIGKILL"); } catch (_) {}
        resolve();
      }, this.stopTimeoutMs);
      if (timer.unref) timer.unref();
      session.child.once("exit", finish);
      try { session.child.kill("SIGTERM"); } catch (_) { finish(); }
    });
  }

  async stop() {
    const session = this.session;
    if (!session) return;
    this.emit(session, { type: "state", phase: "stopped", private: session.private });
    this.session = null;
    await this.teardown(session);
  }
}

module.exports = {
  LIMITS,
  LiveSessionManager,
  TOKEN_ENV,
  liveArgs,
  parseReadyLine,
  sanitizeLiveEvent,
};
