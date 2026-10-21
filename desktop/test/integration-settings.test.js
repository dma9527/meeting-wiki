"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { atomicWriteFile } = require("../setup-window");
const { readIntegrationSettings, saveIntegrationSettings } = require("../integration-settings");
const { readMaxDurationMinutes } = require("../recording-settings");
const { IntegrationError, createIntegrationService } = require("../integration-service");
const { MeetPairingError } = require("../meet-bridge");
const settings = require("../settings-window");

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-integrations-"));
}

function onlineDataDir() {
  const dir = dataDir();
  fs.writeFileSync(path.join(dir, "setup-state.json"), JSON.stringify({ version: 1, completed: true, mode: "online" }));
  return dir;
}

function fakeBridge({ pairError = null } = {}) {
  const calls = [];
  return {
    calls,
    pair: () => {
      calls.push("pair");
      if (pairError) throw pairError;
      return ["Google Chrome"];
    },
    unpair: () => calls.push("unpair"),
    readiness: () => ({ browsers: [{ id: "chrome", name: "Google Chrome", found: true, connected: true }], spoolReady: true }),
  };
}

function service(dir, bridge = fakeBridge(), extra = {}) {
  const changes = [];
  const instance = createIntegrationService({
    fs,
    dataDir: dir,
    atomicWriteFile,
    meetBridge: bridge,
    extensionDir: path.join(__dirname, "..", "browser-extension", "google-meet"),
    mediaAccess: (type) => (type === "microphone" ? "granted" : "denied"),
    zoomStatus: () => "zoom-closed",
    meetStatus: () => ({ state: "watching", lastSeenAt: 1234 }),
    onChanged: (values) => changes.push(values),
    ...extra,
  });
  return { instance, changes, bridge };
}

test("both integrations are off by default and on only for an explicit true", () => {
  const dir = dataDir();
  assert.deepEqual(readIntegrationSettings(fs, dir), { zoomAutoRecord: false, googleMeetAutoRecord: false });
  fs.writeFileSync(path.join(dir, "desktop-settings.json"), JSON.stringify({ integrations: { zoom: { auto_record: "true" }, google_meet: { auto_record: 1 } } }));
  assert.deepEqual(readIntegrationSettings(fs, dir), { zoomAutoRecord: false, googleMeetAutoRecord: false });
  fs.writeFileSync(path.join(dir, "desktop-settings.json"), "not json");
  assert.deepEqual(readIntegrationSettings(fs, dir), { zoomAutoRecord: false, googleMeetAutoRecord: false });
});

test("saving keeps the recording limit and unknown keys", () => {
  const dir = dataDir();
  fs.writeFileSync(path.join(dir, "desktop-settings.json"), JSON.stringify({ recording: { max_duration_minutes: 90 }, extra: 1, integrations: { zoom: { note: "kept" } } }));
  saveIntegrationSettings(fs, dir, { zoomAutoRecord: true, googleMeetAutoRecord: false }, atomicWriteFile);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "desktop-settings.json"), "utf8"));
  assert.deepEqual(saved, {
    recording: { max_duration_minutes: 90 },
    extra: 1,
    integrations: { zoom: { note: "kept", auto_record: true }, google_meet: { auto_record: false } },
  });
  assert.equal(readMaxDurationMinutes(fs, dir), 90);
  assert.equal(fs.statSync(path.join(dir, "desktop-settings.json")).mode & 0o777, 0o600);
  assert.throws(() => saveIntegrationSettings(fs, dir, { zoomAutoRecord: "yes", googleMeetAutoRecord: false }, atomicWriteFile));
});

test("turning Google Meet on pairs before saving, and off unpairs", () => {
  const dir = dataDir();
  const { instance, bridge, changes } = service(dir);
  assert.deepEqual(instance.save({ zoomAutoRecord: false, googleMeetAutoRecord: true }), { zoomAutoRecord: false, googleMeetAutoRecord: true });
  assert.deepEqual(bridge.calls, ["pair"]);
  instance.save({ zoomAutoRecord: true, googleMeetAutoRecord: false });
  assert.deepEqual(bridge.calls, ["pair", "unpair"]);
  assert.deepEqual(changes.at(-1), { zoomAutoRecord: true, googleMeetAutoRecord: false });
  assert.deepEqual(readIntegrationSettings(fs, dir), { zoomAutoRecord: true, googleMeetAutoRecord: false });
});

test("a pairing failure leaves Google Meet off and saves nothing", () => {
  const dir = dataDir();
  const { instance, changes } = service(dir, fakeBridge({ pairError: new MeetPairingError("No supported Chromium browser was found.") }));
  assert.throws(() => instance.save({ zoomAutoRecord: true, googleMeetAutoRecord: true }), (error) => error instanceof IntegrationError && /No supported/.test(error.message));
  assert.deepEqual(readIntegrationSettings(fs, dir), { zoomAutoRecord: false, googleMeetAutoRecord: false });
  assert.deepEqual(changes, []);
});

test("readiness reports permissions, Zoom, and every Meet browser", () => {
  const { instance } = service(dataDir());
  const readiness = instance.readiness();
  assert.deepEqual(readiness.permissions, { microphone: "granted", systemAudio: "denied" });
  assert.equal(readiness.zoom.detector, "zoom-closed");
  assert.equal(typeof readiness.zoom.appInstalled, "boolean");
  assert.equal(readiness.googleMeet.extensionBundled, true);
  assert.equal(readiness.googleMeet.extensionLastSeenAt, 1234);
  assert.equal(readiness.googleMeet.browsers[0].connected, true);
});

test("Settings serves integrations only after setup and returns readiness with each save", () => {
  const notReady = settings.createSettingsController({ fs, dataDir: dataDir(), configPath: "/nonexistent", integrations: service(dataDir()).instance });
  assert.deepEqual(notReady.getIntegrationSettings(), { ready: false, reason: settings.NOT_ONLINE_INTEGRATIONS });
  assert.throws(() => notReady.saveIntegrationSettings({ zoomAutoRecord: true, googleMeetAutoRecord: false }), settings.SettingsError);

  const dir = onlineDataDir();
  const controller = settings.createSettingsController({ fs, dataDir: dir, configPath: path.join(dir, "config.toml"), integrations: service(dir).instance });
  const current = controller.getIntegrationSettings();
  assert.equal(current.ready, true);
  assert.deepEqual(current.values, { zoomAutoRecord: false, googleMeetAutoRecord: false });
  const saved = controller.saveIntegrationSettings({ zoomAutoRecord: true, googleMeetAutoRecord: false });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.values, { zoomAutoRecord: true, googleMeetAutoRecord: false });
  assert.ok(saved.readiness.zoom);
  assert.throws(() => controller.saveIntegrationSettings({ zoomAutoRecord: 1 }), /Choose on or off/);

  const missing = settings.createSettingsController({ fs, dataDir: dir, configPath: path.join(dir, "config.toml") });
  assert.deepEqual(missing.getIntegrationSettings(), { ready: false, reason: settings.NO_INTEGRATIONS });
});

test("the extension folder reveal goes through the injected opener", () => {
  const revealed = [];
  const { instance } = service(dataDir(), fakeBridge(), { revealPath: (target) => revealed.push(target) });
  instance.showExtensionFolder();
  assert.equal(revealed.length, 1);
  const { instance: broken } = service(dataDir(), fakeBridge(), { extensionDir: "/nonexistent/extension" });
  assert.throws(() => broken.showExtensionFolder(), IntegrationError);
});

test("the Settings panel explains boundaries and shows no countdown", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "settings.html"), "utf8");
  assert.match(html, /There is no countdown before it starts\./);
  assert.match(html, /A meeting that ends within 10 seconds is discarded, not processed\./);
  assert.match(html, /opens no network port/);
  assert.match(html, /cannot read captions, transcripts,\s+chat, participants, or browsing history/);
  assert.match(html, /<input id="zoom-auto-record" name="zoomAutoRecord" type="checkbox"/);
  assert.doesNotMatch(html, /id="(zoom|google-meet)-auto-record"[^>]*checked/);
});
