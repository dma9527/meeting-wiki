"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const localization = require("../renderer/settings-localization");

function fakeDocument() {
  const nodes = new Map([
    [".wordmark-sub", { textContent: "settings" }],
    ["#language-settings-heading", { textContent: "Languages" }],
  ]);
  return {
    title: "Meeting Wiki Settings",
    documentElement: { lang: "en" },
    querySelector: (selector) => nodes.get(selector) || null,
    nodes,
  };
}

test("Settings locale resolves fixed choices and macOS Chinese variants", () => {
  assert.equal(localization.resolveSettingsLocale("en", "zh-CN"), "en");
  assert.equal(localization.resolveSettingsLocale("zh-CN", "en-US"), "zh-CN");
  assert.equal(localization.resolveSettingsLocale("system", "zh-Hans"), "zh-CN");
  assert.equal(localization.resolveSettingsLocale("system", "fr-FR"), "en");
  assert.equal(localization.resolveSettingsLocale("unknown", "zh-TW"), "zh-CN");
});

test("Settings locale switches to Chinese and restores original English text", () => {
  const documentObject = fakeDocument();

  assert.equal(localization.applySettingsLocale(documentObject, "zh-CN", "en-US"), "zh-CN");
  assert.equal(documentObject.documentElement.lang, "zh-CN");
  assert.equal(documentObject.title, "Meeting Wiki 设置");
  assert.equal(documentObject.nodes.get(".wordmark-sub").textContent, "设置");
  assert.equal(documentObject.nodes.get("#language-settings-heading").textContent, "语言");

  assert.equal(localization.applySettingsLocale(documentObject, "en", "zh-CN"), "en");
  assert.equal(documentObject.documentElement.lang, "en");
  assert.equal(documentObject.title, "Meeting Wiki Settings");
  assert.equal(documentObject.nodes.get(".wordmark-sub").textContent, "settings");
  assert.equal(documentObject.nodes.get("#language-settings-heading").textContent, "Languages");
});

test("Chinese catalog contains no markup and covers the main Settings panels", () => {
  for (const text of Object.values(localization.zh)) {
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, /<[^>]+>|[\u2013\u2014\u2190-\u2194]/);
  }
  for (const selector of [
    "#identity-settings-heading",
    "#language-settings-heading",
    "#language-migration-notice",
    "#recording-settings-heading",
    "#recording-live-enabled-hint",
    "#integration-settings-heading",
    "#auto-record-privacy-notice",
    "#auto-record-privacy-hint",
    "#zoom-auto-record-boundary",
    "#zoom-heading",
    "#google-meet-auto-record-boundary",
    "#google-meet-heading",
    "#meet-load-instructions",
    "#gemini-settings-heading",
    "#gemini-models-heading",
    "#gemini-live-heading",
    "#gemini-rerun-hint",
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(localization.zh, selector));
  }
});

test("Chinese Settings localizes statuses, errors, and applies-after copy", () => {
  assert.equal(
    localization.translateSettingsMessage("Saving languages.", "zh-CN", "en"),
    "正在保存语言。",
  );
  assert.equal(
    localization.translateSettingsMessage(
      "Recording defaults changed. Close and reopen Settings before saving.",
      "zh-CN",
      "en",
    ),
    "录音默认值已经改变。请关闭并重新打开“设置”后再保存。",
  );
  assert.equal(
    localization.localizedApplies("liveSession", "English fallback", "zh-CN", "en"),
    "从下一次录音的 live 功能开始应用。当前已打开的 live view 保持原设置。",
  );
  assert.equal(
    localization.translateSettingsMessage("Saving languages.", "en", "zh-CN"),
    "Saving languages.",
  );
});

test("Chinese Settings distinguishes every microphone permission state", () => {
  assert.equal(localization.microphonePermissionLine("granted", "zh-CN", "en"), "麦克风权限：已允许。");
  for (const status of ["denied", "restricted", "not-determined", "unknown"]) {
    const line = localization.microphonePermissionLine(status, "zh-CN", "en");
    assert.doesNotMatch(line, /已允许/);
  }
  assert.match(localization.microphonePermissionLine("denied", "zh-CN", "en"), /已拒绝/);
  assert.match(localization.microphonePermissionLine("restricted", "zh-CN", "en"), /限制/);
  assert.match(localization.microphonePermissionLine("not-determined", "zh-CN", "en"), /尚未询问/);
  assert.equal(localization.microphonePermissionLine("denied", "en", "zh-CN"), null);
});

test("Chinese Settings localizes system audio and detector readiness", () => {
  assert.match(localization.systemAudioPermissionLine("zh-CN", "en"), /系统音频权限/);
  assert.equal(localization.systemAudioPermissionLine("en", "zh-CN"), null);
  assert.equal(
    localization.detectorLine("zoom", "in-meeting", "fallback", "zh-CN", "en"),
    "正在监控，Zoom 会议正在进行。",
  );
  assert.equal(
    localization.detectorLine("meet", "watching", "fallback", "zh-CN", "en"),
    "正在监控，当前没有 Google Meet 通话。",
  );
  assert.equal(localization.detectorLine("zoom", "unknown", "fallback", "zh-CN", "en"), "fallback");
});

test("Chinese Settings localizes browser connections and critical errors", () => {
  assert.equal(
    localization.browserConnectionLine("Chrome", true, "zh-CN", "en"),
    "Chrome：连接已安装。",
  );
  assert.match(
    localization.browserConnectionLine("Edge", false, "zh-CN", "en"),
    /连接未安装/,
  );
  for (const message of [
    "Settings cannot reach the app. Close this window and reopen Meeting Wiki.",
    "Settings could not complete this step.",
    "This request did not come from the settings window.",
    "Automatic recording is not available in this build.",
    "Enter a valid model name.",
    "Enter a whole number from 15 to 480.",
    "Enter a valid recording transcription model name.",
    "Add at most 20 aliases.",
    "Extension not seen since Meeting Wiki started. After loading it, open or reload a Meet tab.",
  ]) {
    assert.notEqual(localization.translateSettingsMessage(message, "zh-CN", "en"), message, message);
  }
});

test("Chinese automatic recording copy preserves privacy and visibility disclosures", () => {
  const integration = localization.zh["#panel-integration-settings > .lede"];
  assert.match(integration, /没有倒计时/);
  assert.match(integration, /托盘图标/);
  assert.match(integration, /通知/);
  assert.match(integration, /10 秒/);

  const privacy = localization.zh["#auto-record-privacy-hint"];
  assert.match(privacy, /重试/);
  assert.match(privacy, /手动录音/);
  assert.match(privacy, /“带选项开始”/);

  const zoom = localization.zh["#zoom-auto-record-boundary"];
  assert.match(zoom, /每 3 秒/);
  assert.match(zoom, /浏览器中的 Zoom/);
  assert.match(zoom, /不打开网络端口/);

  const meet = localization.zh["#google-meet-auto-record-boundary"];
  assert.match(localization.zh["#google-meet-heading"], /Chrome.*Edge.*Brave.*Chromium/);
  assert.match(meet, /meet\.google\.com/);
  assert.match(meet, /仅供该 extension 使用/);
  assert.match(meet, /私密文件夹/);
  assert.match(meet, /不会打开网络端口/);
});