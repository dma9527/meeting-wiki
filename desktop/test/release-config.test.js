"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const desktop = path.join(__dirname, "..");
const packageJson = require("../package.json");

test("macOS release metadata matches the supported capture platform", () => {
  const mac = packageJson.build.mac;

  assert.equal(mac.minimumSystemVersion, "14.2");
  assert.equal(mac.hardenedRuntime, true);
  assert.equal(mac.entitlements, "entitlements.mac.plist");
  assert.equal(mac.entitlementsInherit, "entitlements.mac.plist");
  assert.ok(fs.existsSync(path.join(desktop, mac.entitlements)));
  const audioToolEntitlements = fs.readFileSync(
    path.join(desktop, "entitlements.audio-tool.plist"),
    "utf8",
  );
  assert.match(audioToolEntitlements, /com\.apple\.security\.device\.audio-input/);
  assert.doesNotMatch(audioToolEntitlements, /allow-jit/);
  assert.match(mac.extendInfo.NSMicrophoneUsageDescription, /Meeting Wiki/);
  assert.match(mac.extendInfo.NSScreenCaptureUsageDescription, /system audio/);
  assert.match(mac.extendInfo.NSAudioCaptureUsageDescription, /automatic recording/);
});

test("macOS release uses the product icon and packages project notices", () => {
  const icon = fs.readFileSync(path.join(desktop, packageJson.build.mac.icon));
  const resources = new Map(
    packageJson.build.extraResources.map(({ from, to }) => [from, to]),
  );

  assert.equal(icon.subarray(0, 4).toString("ascii"), "icns");
  assert.ok(icon.length > 1024);
  assert.equal(resources.get("../LICENSE"), "LICENSE");
  assert.equal(resources.get("../NOTICE"), "NOTICE");
});
