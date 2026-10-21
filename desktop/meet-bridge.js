"use strict";

// Google Meet pairing and event intake. Pairing writes a native messaging manifest, pinned to the
// extension's fixed ID, into each detected Chromium browser and creates a private spool directory.
// The app reads that spool on a timer; nothing listens on a socket or port.

const crypto = require("crypto");
const path = require("path");

const {
  EXTENSION_ORIGIN,
  MAX_MESSAGE_BYTES,
  NATIVE_HOST_NAME,
  SPOOL_FILE_PATTERN,
  validateSpoolEvent,
} = require("./meet-protocol");

// Paths are relative to ~/Library/Application Support. Each browser documents this location.
const BROWSERS = Object.freeze([
  { id: "chrome", name: "Google Chrome", dir: "Google/Chrome" },
  { id: "chrome-beta", name: "Google Chrome Beta", dir: "Google/Chrome Beta" },
  { id: "chrome-dev", name: "Google Chrome Dev", dir: "Google/Chrome Dev" },
  { id: "chrome-canary", name: "Google Chrome Canary", dir: "Google/Chrome Canary" },
  { id: "chromium", name: "Chromium", dir: "Chromium" },
  { id: "edge", name: "Microsoft Edge", dir: "Microsoft Edge" },
  { id: "brave", name: "Brave", dir: "BraveSoftware/Brave-Browser" },
]);

const POLL_MS = 1000;
// The extension sends a heartbeat every 10 s while joined; a crash or browser quit ends after this.
const SESSION_TIMEOUT_MS = 45_000;
const STALE_EVENT_MS = 120_000;
const FUTURE_SKEW_MS = 60_000;

class MeetPairingError extends Error {}

function integrationDir(dataDir) {
  return path.join(dataDir, "integrations", "google-meet");
}

function bridgePaths(dataDir, homeDir) {
  const base = integrationDir(dataDir);
  return {
    base,
    spoolDir: path.join(base, "events"),
    wrapper: path.join(base, "meeting-wiki-meet-host"),
    supportDir: path.join(homeDir, "Library", "Application Support"),
  };
}

function manifestPath(supportDir, browser) {
  return path.join(supportDir, browser.dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Runs the app's own Electron binary as Node on the bundled host script.
function wrapperScript({ execPath, hostScript, spoolDir }) {
  return [
    "#!/bin/sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(hostScript)} --spool ${shellQuote(spoolDir)} "$@"`,
    "",
  ].join("\n");
}

function hostManifest(wrapper) {
  return {
    name: NATIVE_HOST_NAME,
    description: "Meeting Wiki Google Meet join and leave events",
    path: wrapper,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
}

// Exclusive temp file in the same directory, then rename. Unlike setup's helper it never changes
// the permissions of the directory, which for manifests belongs to the browser.
function writeFileAtomic(fs, filePath, content, mode) {
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode, flag: "wx" });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) {}
    throw error;
  }
}

function readJson(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function exists(fs, target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (_) {
    return false;
  }
}

function createMeetBridge({ fs, dataDir, homeDir, execPath, hostScript }) {
  const paths = bridgePaths(dataDir, homeDir);

  function detectedBrowsers() {
    return BROWSERS.filter((browser) => exists(fs, path.join(paths.supportDir, browser.dir)));
  }

  function hostInstalled(browser) {
    const manifest = readJson(fs, manifestPath(paths.supportDir, browser));
    return Boolean(
      manifest &&
        manifest.name === NATIVE_HOST_NAME &&
        manifest.path === paths.wrapper &&
        Array.isArray(manifest.allowed_origins) &&
        manifest.allowed_origins.length === 1 &&
        manifest.allowed_origins[0] === EXTENSION_ORIGIN,
    );
  }

  function wrapperCurrent() {
    try {
      const text = fs.readFileSync(paths.wrapper, "utf8");
      const mode = fs.statSync(paths.wrapper).mode;
      return text === wrapperScript({ execPath, hostScript, spoolDir: paths.spoolDir }) && (mode & 0o100) !== 0 && (mode & 0o022) === 0;
    } catch (_) {
      return false;
    }
  }

  // Idempotent; startup calls it again so a moved or updated app keeps a working host path.
  function pair() {
    const browsers = detectedBrowsers();
    if (browsers.length === 0) {
      throw new MeetPairingError("No supported Chromium browser was found. Install Chrome, Edge, Brave, or Chromium first.");
    }
    try {
      fs.mkdirSync(paths.spoolDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(paths.base, 0o700);
      fs.chmodSync(paths.spoolDir, 0o700);
      writeFileAtomic(fs, paths.wrapper, wrapperScript({ execPath, hostScript, spoolDir: paths.spoolDir }), 0o700);
      for (const browser of browsers) {
        const target = manifestPath(paths.supportDir, browser);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writeFileAtomic(fs, target, `${JSON.stringify(hostManifest(paths.wrapper), null, 2)}\n`, 0o600);
      }
    } catch (_) {
      throw new MeetPairingError("Meeting Wiki could not install the browser connection.");
    }
    return browsers.map((browser) => browser.name);
  }

  // Removes only manifests that carry this host name, then the wrapper and any queued events.
  function unpair() {
    for (const browser of BROWSERS) {
      const target = manifestPath(paths.supportDir, browser);
      const manifest = readJson(fs, target);
      if (manifest && manifest.name === NATIVE_HOST_NAME) {
        try { fs.unlinkSync(target); } catch (_) {}
      }
    }
    try { fs.rmSync(paths.base, { recursive: true, force: true }); } catch (_) {}
  }

  function readiness() {
    const detected = new Set(detectedBrowsers().map((browser) => browser.id));
    return {
      browsers: BROWSERS.map((browser) => ({
        id: browser.id,
        name: browser.name,
        found: detected.has(browser.id),
        connected: detected.has(browser.id) && hostInstalled(browser) && wrapperCurrent(),
      })),
      spoolReady: exists(fs, paths.spoolDir),
    };
  }

  return { paths, pair, unpair, readiness, wrapperCurrent };
}

// Turns join/heartbeat/leave events from any number of Meet tabs into one joined/left signal.
class MeetSessionTracker {
  constructor({ onJoin = () => {}, onLeave = () => {}, now = Date.now, timeoutMs = SESSION_TIMEOUT_MS } = {}) {
    this.onJoin = onJoin;
    this.onLeave = onLeave;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
    this.lastSeenAt = null;
  }

  get joined() { return this.sessions.size > 0; }

  apply(event) {
    this.lastSeenAt = this.now();
    if (event.type === "hello") return;
    const wasJoined = this.joined;
    if (event.type === "left") {
      this.sessions.delete(event.session);
      if (wasJoined && !this.joined) this.onLeave();
      return;
    }
    const previous = this.sessions.get(event.session);
    this.sessions.set(event.session, {
      seenAt: this.now(),
      joinedAt: previous ? previous.joinedAt : event.at,
      meetingCode: event.meetingCode || (previous && previous.meetingCode) || null,
    });
    if (!wasJoined) {
      const session = this.sessions.get(event.session);
      this.onJoin({ meetingCode: session.meetingCode, joinedAt: session.joinedAt });
    }
  }

  prune() {
    if (!this.joined) return;
    const cutoff = this.now() - this.timeoutMs;
    for (const [id, session] of this.sessions) if (session.seenAt < cutoff) this.sessions.delete(id);
    if (!this.joined) this.onLeave();
  }

  // Used when the integration is turned off: forget sessions without signalling a leave.
  reset() {
    this.sessions.clear();
  }
}

// Reads, validates, and deletes spool files. Files that are not exactly what the host writes are deleted unread.
function drainSpool(fs, spoolDir, { now = Date.now } = {}) {
  let names;
  try {
    names = fs.readdirSync(spoolDir);
  } catch (_) {
    return [];
  }
  const events = [];
  for (const name of names.sort()) {
    const file = path.join(spoolDir, name);
    if (!SPOOL_FILE_PATTERN.test(name)) {
      if (!name.startsWith(".tmp-")) {
        try { fs.rmSync(file, { recursive: true, force: true }); } catch (_) {}
      }
      continue;
    }
    let event = null;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.size <= MAX_MESSAGE_BYTES) event = validateSpoolEvent(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (_) {}
    try { fs.unlinkSync(file); } catch (_) {}
    const current = now();
    if (event && current - event.at <= STALE_EVENT_MS && event.at - current <= FUTURE_SKEW_MS) events.push(event);
  }
  return events;
}

class MeetSpoolWatcher {
  constructor({ fs, spoolDir, onJoin, onLeave, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
    this.fs = fs;
    this.spoolDir = spoolDir;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.tracker = new MeetSessionTracker({ onJoin, onLeave, now });
    this.timer = null;
  }

  get running() { return this.timer !== null; }
  get lastSeenAt() { return this.tracker.lastSeenAt; }

  start() {
    if (this.timer !== null) return;
    // Anything queued before this start is from an earlier run and is discarded.
    drainSpool(this.fs, this.spoolDir, { now: () => Number.MAX_SAFE_INTEGER });
    this.timer = this.setTimer(() => this.poll(), POLL_MS);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.tracker.reset();
  }

  poll() {
    for (const event of drainSpool(this.fs, this.spoolDir, { now: this.now })) this.tracker.apply(event);
    this.tracker.prune();
  }
}

module.exports = {
  BROWSERS,
  MeetPairingError,
  MeetSessionTracker,
  MeetSpoolWatcher,
  SESSION_TIMEOUT_MS,
  STALE_EVENT_MS,
  bridgePaths,
  createMeetBridge,
  drainSpool,
  hostManifest,
  manifestPath,
  shellQuote,
  wrapperScript,
};
