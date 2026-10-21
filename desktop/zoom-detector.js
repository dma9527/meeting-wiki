"use strict";

// Detects when the Zoom desktop app is in a meeting by sampling local process state only. It runs
// the built-in ps, lsof, and pmset tools against the current user's processes. It opens no sockets,
// reads no Zoom windows, files, chat, or participants, and needs no extra macOS permission.
//
// Signals, any of which counts while zoom.us is running:
//   - Zoom owns UDP sockets (meeting audio and video; Zoom keeps none open between meetings)
//   - the CptHost meeting helper process is running
//   - Zoom holds a PreventUserIdleDisplaySleep power assertion
// These are heuristics from observed Zoom behavior, not a Zoom API.

const fs = require("fs");
const path = require("path");

const TOOLS = Object.freeze({ ps: "/bin/ps", lsof: "/usr/sbin/lsof", pmset: "/usr/bin/pmset" });
const ZOOM_APP_BUNDLES = Object.freeze(["/Applications/zoom.us.app"]);
const POLL_MS = 3000;
// About 6 s of agreement before starting and 12 s before stopping, so a reconnect does not split a meeting.
const JOIN_SAMPLES = 2;
const LEAVE_SAMPLES = 4;
const EXEC_TIMEOUT_MS = 5000;

function run(execFile, file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when nothing matched; that is an empty result, not a failure.
      if (error && !(error.code === 1 && file === TOOLS.lsof)) reject(error);
      else resolve(String(stdout || ""));
    });
  });
}

function parseProcesses(stdout) {
  const processes = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), command: match[2] });
  }
  return processes;
}

function zoomProcesses(processes) {
  const inBundle = processes.filter(({ command }) => command.includes("/zoom.us.app/"));
  const base = ({ command }) => path.basename(command);
  return {
    main: inBundle.filter((entry) => base(entry) === "zoom.us").map(({ pid }) => pid),
    all: inBundle.map(({ pid }) => pid),
    cptHost: inBundle.some((entry) => base(entry) === "CptHost"),
  };
}

function countUdpSockets(stdout) {
  return stdout.split("\n").filter((line) => /\bUDP\b/.test(line)).length;
}

function holdsDisplayAssertion(stdout, pids) {
  const wanted = new Set(pids);
  return stdout.split("\n").some((line) => {
    const match = /\bpid (\d+)\([^)]*\):.*\bPreventUserIdleDisplaySleep\b/.exec(line);
    return Boolean(match) && wanted.has(Number(match[1]));
  });
}

// One sample. Throws when a tool fails so the watcher can keep its last state.
async function sampleZoom({ execFile }) {
  const zoom = zoomProcesses(parseProcesses(await run(execFile, TOOLS.ps, ["-axo", "pid=,comm="])));
  if (zoom.main.length === 0) return { running: false, inMeeting: false };
  const [lsof, pmset] = await Promise.all([
    run(execFile, TOOLS.lsof, ["-nP", "-w", "-a", "-iUDP", "-p", zoom.all.join(",")]),
    run(execFile, TOOLS.pmset, ["-g", "assertions"]),
  ]);
  const udp = countUdpSockets(lsof);
  const assertion = holdsDisplayAssertion(pmset, zoom.all);
  return { running: true, inMeeting: udp > 0 || zoom.cptHost || assertion };
}

function zoomReadiness({ existsSync = fs.existsSync } = {}) {
  return {
    appInstalled: ZOOM_APP_BUNDLES.some((bundle) => existsSync(bundle)),
    toolsAvailable: Object.values(TOOLS).every((tool) => existsSync(tool)),
  };
}

class ZoomMeetingWatcher {
  constructor({
    sample,
    onJoin = () => {},
    onLeave = () => {},
    pollMs = POLL_MS,
    joinSamples = JOIN_SAMPLES,
    leaveSamples = LEAVE_SAMPLES,
    setTimer = setInterval,
    clearTimer = clearInterval,
    now = Date.now,
  }) {
    Object.assign(this, { sample, onJoin, onLeave, pollMs, joinSamples, leaveSamples, setTimer, clearTimer, now });
    this.timer = null;
    this.inMeeting = false;
    this.streak = 0;
    this.sampling = false;
    this.lastSample = null;
    this.lastError = false;
    this.candidateSince = null;
  }

  get running() { return this.timer !== null; }

  status() {
    if (!this.running) return "off";
    if (this.lastError) return "unavailable";
    if (this.inMeeting) return "in-meeting";
    if (!this.lastSample) return "starting";
    return this.lastSample.running ? "zoom-open" : "zoom-closed";
  }

  start() {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => { void this.tick(); }, this.pollMs);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
    void this.tick();
  }

  // Stopping forgets meeting state without signalling a leave.
  stop() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.inMeeting = false;
    this.streak = 0;
    this.lastSample = null;
    this.lastError = false;
    this.candidateSince = null;
  }

  async tick() {
    if (this.sampling || this.timer === null) return;
    this.sampling = true;
    let result;
    try {
      result = await this.sample();
      this.lastError = false;
    } catch (_) {
      this.lastError = true;
    } finally {
      this.sampling = false;
    }
    if (!result || this.timer === null) return;
    this.lastSample = result;
    this.observe(result.inMeeting);
  }

  observe(inMeeting) {
    if (inMeeting === this.inMeeting) {
      this.streak = 0;
      this.candidateSince = null;
      return;
    }
    if (this.streak === 0) this.candidateSince = this.now();
    this.streak += 1;
    if (this.streak < (inMeeting ? this.joinSamples : this.leaveSamples)) return;
    const since = this.candidateSince;
    this.inMeeting = inMeeting;
    this.streak = 0;
    this.candidateSince = null;
    if (inMeeting) this.onJoin({ joinedAt: since });
    else this.onLeave();
  }
}

module.exports = {
  JOIN_SAMPLES,
  LEAVE_SAMPLES,
  TOOLS,
  ZoomMeetingWatcher,
  countUdpSockets,
  holdsDisplayAssertion,
  parseProcesses,
  sampleZoom,
  zoomProcesses,
  zoomReadiness,
};
