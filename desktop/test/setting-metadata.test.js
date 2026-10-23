"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { APPLIES, SETTINGS, appliesCopy, settingMetadata } = require("../setting-metadata");
const settings = require("../settings-window");

const RENDERER = path.join(__dirname, "..", "renderer");

test("every setting maps to a known applies-after code with fixed copy", () => {
  for (const [key, entry] of Object.entries(SETTINGS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(APPLIES, entry.applies), `${key} has an unknown code`);
    assert.equal(appliesCopy(key), APPLIES[entry.applies]);
  }
  for (const copy of Object.values(APPLIES)) {
    assert.match(copy, /^[A-Z].*\.$/);
    assert.doesNotMatch(copy, /\u2014|\u2013|\u2192/);
  }
  assert.equal(appliesCopy("unknown"), "");
});

test("the codes match where each value is read", () => {
  assert.equal(SETTINGS.maxDurationMinutes.applies, "nextRecording");
  assert.equal(SETTINGS.liveModel.applies, "liveSession");
  assert.equal(SETTINGS.liveTranslationLanguage.applies, "liveSession");
  assert.equal(SETTINGS.liveSummaryLanguage.applies, "liveSession");
  assert.equal(SETTINGS.summaryContextCharacters.applies, "liveSession");
  assert.equal(SETTINGS.batchAudioModel.applies, "processing");
  assert.equal(SETTINGS.languageModel.applies, "processingAndLive");
  assert.equal(SETTINGS.primaryProfileName.applies, "processing");
  assert.equal(SETTINGS.provider.applies, "setupFinish");
});

test("every Settings field has an applies line bound to a registry key and announced to readers", () => {
  const html = fs.readFileSync(path.join(RENDERER, "settings.html"), "utf8");
  const bound = [...html.matchAll(/<p id="([a-z-]+)-applies" class="hint applies" data-applies-for="([A-Za-z]+)"><\/p>/g)];
  const keys = bound.map((match) => match[2]).sort();
  const formKeys = Object.entries(SETTINGS).filter(([, entry]) => entry.form !== "setup").map(([key]) => key).sort();
  assert.deepEqual(keys, formKeys);
  for (const [, id] of bound) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="[^"]*\\b${id}-applies\\b`));
  }
});

test("Settings serves plain registry data and the renderer uses only that copy", async () => {
  const controller = settings.createSettingsController({ fs, dataDir: "/nonexistent", configPath: "/nonexistent/config.toml" });
  const meta = controller.getSettingMetadata();
  assert.deepEqual(meta, settingMetadata());
  assert.equal(meta.settings.liveModel.copy, APPLIES.liveSession);
  assert.equal(meta.manualEdit, APPLIES.manualEdit);
  const js = fs.readFileSync(path.join(RENDERER, "settings.js"), "utf8");
  assert.match(js, /call\("getSettingMetadata"\)/);
  for (const copy of Object.values(APPLIES)) assert.ok(!js.includes(copy), "renderer duplicates registry copy");
  assert.doesNotMatch(js, /restarted with/);
});

test("a hand-edited config is flagged so Settings explains it is never changed", () => {
  const dataDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "meeting-wiki-meta-"));
  fs.writeFileSync(path.join(dataDir, "setup-state.json"), JSON.stringify({ version: 1, completed: true, mode: "online" }));
  const configPath = path.join(dataDir, "config.toml");
  fs.writeFileSync(configPath, '[providers]\nllm = "ollama"\n');
  const controller = settings.createSettingsController({ fs, dataDir, configPath });
  assert.equal(controller.getIdentitySettings().manualConfig, true);
  assert.throws(() => controller.saveIdentitySettings({ primaryProfileName: "Test Person", aliases: [] }), /edited by hand/);
  assert.equal(fs.readFileSync(configPath, "utf8"), '[providers]\nllm = "ollama"\n');
});

test("setup and the tray take their copy from the registry", () => {
  const setupJs = fs.readFileSync(path.join(RENDERER, "setup.js"), "utf8");
  assert.match(setupJs, /\["When it applies", state\.appliesAfter\]/);
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /label: "Edit configuration", toolTip: APPLIES\.manualEdit/);
});
