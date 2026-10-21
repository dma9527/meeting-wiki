"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const zoom = require("../zoom-detector");

const PS_IDLE = [
  "  708 Core Audio Driver (ZoomAudioDevice.driver)",
  " 2272 /Applications/zoom.us.app/Contents/MacOS/zoom.us",
  " 2601 /Applications/zoom.us.app/Contents/Frameworks/caphost.app/Contents/MacOS/caphost",
  " 4349 /Applications/zoom.us.app/Contents/Frameworks/ZoomCefHelper (Renderer).app/Contents/MacOS/ZoomCefHelper (Renderer)",
  "  900 /System/Applications/Mail.app/Contents/MacOS/Mail",
].join("\n");
const LSOF_MEETING = [
  "COMMAND  PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
  "zoom.us 2272 test 40u IPv4 0x01 0t0 UDP 192.0.2.10:53000->198.51.100.20:8801",
  "zoom.us 2272 test 41u IPv4 0x02 0t0 UDP 192.0.2.10:53001->198.51.100.20:8801",
].join("\n");
const PMSET_MEETING = '   pid 2272(zoom.us): [0x000a] 00:03:10 PreventUserIdleDisplaySleep named: "test"';
const PMSET_OTHER = '   pid 3302(Amphetamine): [0x000b] 01:00:00 PreventUserIdleDisplaySleep named: "test"';

function fakeExecFile(outputs, calls = []) {
  return (file, args, options, callback) => {
    calls.push({ file, args });
    const output = outputs[file];
    if (output instanceof Error) callback(output, "");
    else callback(null, output ?? "");
  };
}

test("process parsing finds Zoom's main process and helpers only inside the app bundle", () => {
  const found = zoom.zoomProcesses(zoom.parseProcesses(PS_IDLE));
  assert.deepEqual(found.main, [2272]);
  assert.deepEqual(found.all, [2272, 2601, 4349]);
  assert.equal(found.cptHost, false);
  const withCpt = zoom.zoomProcesses(zoom.parseProcesses(`${PS_IDLE}\n 5000 /Applications/zoom.us.app/Contents/Frameworks/cpthost.app/Contents/MacOS/CptHost`));
  assert.equal(withCpt.cptHost, true);
});

test("UDP and display-sleep signals are counted only for Zoom pids", () => {
  assert.equal(zoom.countUdpSockets(LSOF_MEETING), 2);
  assert.equal(zoom.countUdpSockets(""), 0);
  assert.equal(zoom.holdsDisplayAssertion(PMSET_MEETING, [2272]), true);
  assert.equal(zoom.holdsDisplayAssertion(PMSET_OTHER, [2272]), false);
});

test("a sample is not in a meeting when Zoom is idle and skips lsof when Zoom is closed", async () => {
  const calls = [];
  const idle = await zoom.sampleZoom({ execFile: fakeExecFile({ [zoom.TOOLS.ps]: PS_IDLE, [zoom.TOOLS.pmset]: PMSET_OTHER }, calls) });
  assert.deepEqual(idle, { running: true, inMeeting: false });
  const lsofCall = calls.find((call) => call.file === zoom.TOOLS.lsof);
  assert.deepEqual(lsofCall.args, ["-nP", "-w", "-a", "-iUDP", "-p", "2272,2601,4349"]);

  const closedCalls = [];
  const closed = await zoom.sampleZoom({ execFile: fakeExecFile({ [zoom.TOOLS.ps]: "  900 /System/Applications/Mail.app/Contents/MacOS/Mail" }, closedCalls) });
  assert.deepEqual(closed, { running: false, inMeeting: false });
  assert.deepEqual(closedCalls.map((call) => call.file), [zoom.TOOLS.ps]);
});

test("any one meeting signal makes the sample in-meeting", async () => {
  const udp = await zoom.sampleZoom({ execFile: fakeExecFile({ [zoom.TOOLS.ps]: PS_IDLE, [zoom.TOOLS.lsof]: LSOF_MEETING }) });
  assert.equal(udp.inMeeting, true);
  const assertion = await zoom.sampleZoom({ execFile: fakeExecFile({ [zoom.TOOLS.ps]: PS_IDLE, [zoom.TOOLS.pmset]: PMSET_MEETING }) });
  assert.equal(assertion.inMeeting, true);
});

test("lsof exit 1 means no sockets, while other tool failures reject", async () => {
  const noMatch = Object.assign(new Error("no match"), { code: 1 });
  const sample = await zoom.sampleZoom({ execFile: fakeExecFile({ [zoom.TOOLS.ps]: PS_IDLE, [zoom.TOOLS.lsof]: noMatch }) });
  assert.equal(sample.inMeeting, false);
  await assert.rejects(zoom.sampleZoom({ execFile: fakeExecFile({ [zoom.TOOLS.ps]: new Error("ps failed") }) }));
});

function manualWatcher(samples, events) {
  let clock = 1000;
  const watcher = new zoom.ZoomMeetingWatcher({
    sample: async () => {
      const next = samples.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onJoin: (info) => events.push(["join", info]),
    onLeave: () => events.push(["leave"]),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    now: () => (clock += 3000),
  });
  return watcher;
}

test("the watcher debounces join and leave and ignores failed samples", async () => {
  const inMeeting = { running: true, inMeeting: true };
  const idle = { running: true, inMeeting: false };
  const events = [];
  const samples = [idle, inMeeting, idle, inMeeting, inMeeting, new Error("x"), idle, idle, idle, inMeeting, idle, idle, idle, idle];
  const watcher = manualWatcher(samples, events);
  assert.equal(watcher.status(), "off");
  watcher.start();
  await new Promise((resolve) => setImmediate(resolve));
  while (samples.length) await watcher.tick();
  assert.deepEqual(events.map(([name]) => name), ["join", "leave"]);
  assert.ok(Number.isFinite(events[0][1].joinedAt));
  assert.equal(watcher.status(), "zoom-open");
});

test("a single blip does not start a recording and stop forgets state without a leave", async () => {
  const events = [];
  const samples = [{ running: true, inMeeting: true }, { running: true, inMeeting: false }, { running: true, inMeeting: true }, { running: true, inMeeting: true }];
  const watcher = manualWatcher(samples, events);
  watcher.start();
  await new Promise((resolve) => setImmediate(resolve));
  await watcher.tick();
  await watcher.tick();
  assert.deepEqual(events, []);
  await watcher.tick();
  assert.equal(events.length, 1);
  assert.equal(watcher.status(), "in-meeting");
  watcher.stop();
  assert.equal(events.length, 1);
  assert.equal(watcher.status(), "off");
});

test("the detector opens no sockets and reads no Zoom windows or files", () => {
  const source = require("fs").readFileSync(require.resolve("../zoom-detector"), "utf8");
  assert.doesNotMatch(source, /require\("(net|http|https|dgram)"\)|createServer|listen\(|osascript|System Events|CGWindowList|readFileSync/);
});

test("readiness reports the app bundle and the three tools", () => {
  const present = new Set(["/Applications/zoom.us.app", ...Object.values(zoom.TOOLS)]);
  assert.deepEqual(zoom.zoomReadiness({ existsSync: (file) => present.has(file) }), { appInstalled: true, toolsAvailable: true });
  assert.deepEqual(zoom.zoomReadiness({ existsSync: () => false }), { appInstalled: false, toolsAvailable: false });
});
