"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { BUTTONS, MESSAGES, createMainTranslator, localizeText } = require("../main-localization");
const selfCheck = require("../self-check");
const { formatQueueLabel } = require("../status");
const session = require("../recording-session");
const { SHORT_DISCARD_NOTICE } = require("../auto-record");
const { missingRuntimeMessage } = require("../runtime-paths");
const { skillInstallMessage } = require("../skill-installer");
const cli = require("../cli-installer");
const { APPLIES } = require("../setting-metadata");

const DESKTOP = path.join(__dirname, "..");
const readSource = (name) => fs.readFileSync(path.join(DESKTOP, name), "utf8");
const main = readSource("main.js");

function zh(choice = "zh-CN", systemLocale = "en-US") {
  return createMainTranslator({ readChoice: () => choice, systemLocale: () => systemLocale });
}

// A message is covered when the whole text, or every sentence of every line, has Chinese copy.
function assertCovered(message, ignoredLines = []) {
  if (Object.prototype.hasOwnProperty.call(MESSAGES, message)) return;
  for (const line of message.split("\n")) {
    if (!line || ignoredLines.includes(line)) continue;
    for (const sentence of line.split(/(?<=\.)\s+/)) {
      assert.ok(Object.prototype.hasOwnProperty.call(MESSAGES, sentence), `missing Chinese copy: ${sentence}`);
    }
  }
}

test("the main catalog is plain text without dashes or arrows", () => {
  for (const text of [...Object.values(MESSAGES), ...Object.values(BUTTONS)]) {
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, /<[^>]+>|[\u2013\u2014\u2190-\u2194]/, text);
  }
});

test("every tray label and literal notification in main.js has Chinese copy", () => {
  const menu = main.slice(main.indexOf("function updateMenu("), main.indexOf("app.whenReady()"));
  const labels = [...menu.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(labels.length >= 18, `found ${labels.length} labels`);
  for (const [, constant] of main.matchAll(/^const INSTALL_SKILL_(?:LABEL|TOOLTIP) = "([^"]+)";$/gm)) labels.push(constant);
  for (const label of labels) assertCovered(label);
  assertCovered(APPLIES.manualEdit);
  const notices = [...main.matchAll(/notify\(\s*"([^"]+)",\s*"([^"]+)"/g)].flatMap((match) => [match[1], match[2]]);
  const ternaries = [...main.matchAll(/\? "([A-Z0-9][^"]+)" : "([A-Z{][^"]+)"/g)].flatMap((match) => [match[1], match[2]]);
  assert.ok(notices.length >= 20 && ternaries.length >= 6);
  const statusLines = [...main.matchAll(/\? "(Processing status unavailable)"|: "(Checking processing status\.\.\.)"/g)].flatMap((match) => [match[1] || match[2]]);
  assert.equal(statusLines.length, 2);
  for (const line of statusLines) assertCovered(line);
  const titles = [...main.matchAll(/notify\(\s*"([^"]+)",/g)].map((match) => match[1]);
  // "Imported meeting" is an ingest title for Python, never shown by main.
  const fields = [...main.matchAll(/(?:detail|checkboxLabel|title|name): "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((text) => text !== "Imported meeting");
  const tails = [...main.matchAll(/`\$\{body\} ([^`]+)`/g)].map((match) => match[1]);
  assert.ok(titles.length > notices.length / 2 && fields.length >= 6 && tails.length === 1);
  for (const message of [...notices, ...ternaries, ...titles, ...fields, ...tails, "Meeting {time}"]) assertCovered(message);
});

test("every message from the shared main-process modules has Chinese copy", () => {
  const messages = [
    SHORT_DISCARD_NOTICE.title, SHORT_DISCARD_NOTICE.body,
    session.LIMIT_NOTICE.title, session.LIMIT_NOTICE.body, session.QUIT_NOTICE.title, session.QUIT_NOTICE.body,
    session.SAVING_LABEL, session.LIMIT_REACHED_LABEL,
    "Run setup again.",
  ];
  for (const name of ["python", "sox", "rec"]) {
    const notice = missingRuntimeMessage(name, { packaged: true });
    messages.push(notice.title, notice.body);
  }
  messages.push(missingRuntimeMessage("python").title);
  for (const status of ["installed", "already_installed", "conflict", "unsafe_path", "error"]) {
    const notice = skillInstallMessage({ status });
    messages.push(notice.title, notice.body);
    const result = cli.resultDialog({ status });
    messages.push(result.message, result.detail);
  }
  messages.push(cli.CONFIRM_DIALOG.message, cli.CONFIRM_DIALOG.detail);
  const record = readSource("record-window.js");
  const live = record.slice(record.indexOf("const LIVE_UNAVAILABLE_MESSAGES"), record.indexOf("function liveUnavailableMessage"));
  messages.push(...[...live.matchAll(/: "([^"]+)",?$/gm)].map((match) => match[1]));
  for (const [, text] of readSource("status.js").matchAll(/new Error\("([^"]+)"\)/g)) {
    if (!text.startsWith("RestartBackoff")) messages.push(text);
  }
  messages.push("Status command returned invalid JSON", "Processing action returned invalid JSON");
  const setupWindow = readSource("setup-window.js");
  for (const [, text] of setupWindow.matchAll(/^const (?:GEMINI_)?KEY_UNAVAILABLE = "([^"]+)";$/gm)) messages.push(text);
  for (const message of messages) assertCovered(message, [cli.PATH_LINE]);
});

test("every self-check sentence has Chinese copy", () => {
  const tables = [selfCheck.ENGINE_TEXT, ...Object.values(selfCheck.PERMISSION_TEXT), ...Object.values(selfCheck.CAPABILITY_TEXT)];
  const texts = tables.flatMap((table) => Object.values(table).map(([, text]) => text));
  texts.push(...Object.values(selfCheck.LABELS), ...Object.values(selfCheck.PROVIDER_NAMES), ...Object.values(selfCheck.TONE_PREFIX));
  for (const text of texts) assertCovered(text);
});

test("the Chinese self-check keeps the codes and translates every fixed part", () => {
  const report = {
    capabilities: { microphone: "granted", systemAudio: "not_checkable", transcription: "ready", analysis: "ready", live: "connection_failed", storage: "ready", memory: "empty", claudeSkill: "installed" },
    providers: { transcription: "gemini" },
    liveScope: "external",
    liveError: { closeCode: 1011, providerStatus: "RESOURCE_EXHAUSTED" },
  };
  const translator = zh();
  const dialog = translator.buttons(selfCheck.formatSelfCheck(report, translator.text));
  assert.equal(dialog.title, "Meeting Wiki 自检");
  assert.equal(dialog.message, "有 1 项需要处理。");
  assert.deepEqual(dialog.buttons, ["好"]);
  const lines = dialog.detail.split("\n");
  assert.equal(lines[0], "正常  麦克风权限：已允许。");
  assert.match(lines[1], /^提示  系统音频权限：macOS 不允许 App 预先检查这项权限。.*“仅系统录音”/);
  assert.ok(lines.includes("录音由 Google Gemini 转写。"));
  assert.ok(lines.includes("Live 连接错误：关闭码 1011, RESOURCE_EXHAUSTED。详情也记录在“打开日志”中的 live.log。"));
  const english = selfCheck.formatSelfCheck(report);
  assert.equal(english.message, "1 item needs attention.");
  assert.equal(english.detail.split("\n")[0], "OK  Microphone permission: Allowed.");
});

test("tray status lines translate their fixed words and keep counts and times", () => {
  const t = zh().text;
  assert.equal(formatQueueLabel({ total: 3, active: 2, action_required: 0, stages: { transcribing: 1, analyzing: 1 } }, t), "正在处理：2（转写中、分析中）");
  assert.equal(formatQueueLabel({ total: 3, active: 0, action_required: 2 }, t), "需要处理：2 个失败");
  assert.equal(formatQueueLabel({ total: 0, active: 0, action_required: 0 }, t), "还没有会议");
  assert.equal(formatQueueLabel({ total: 3, active: 2, action_required: 0, stages: { transcribing: 1, analyzing: 1 } }), "Processing: 2 (transcribing, analyzing)");
  const fake = { elapsedMs: () => 65_000, limitMs: () => 7_200_000 };
  assert.equal(session.recordingLabel(fake, t), "录音中 1:05 / 2:00:00");
  assert.equal(session.recordingLabel(fake), "Recording 1:05 of 2:00:00");
});

test("menus, dialogs, and notices follow the language and fall back to English", () => {
  const items = [{ label: "Quit", click: () => {} }, { type: "separator" }, { label: "Edit configuration", toolTip: APPLIES.manualEdit }];
  const [quit, separator, edit] = zh().menuItems(items);
  const [nested] = zh().snapshot().menuItems([{ label: "Open logs", submenu: [{ label: "Quit" }] }]);
  assert.equal(nested.label, "打开日志");
  assert.equal(nested.submenu[0].label, "退出");
  assert.equal(quit.label, "退出");
  assert.equal(typeof quit.click, "function");
  assert.deepEqual(separator, { type: "separator" });
  assert.match(edit.toolTip, /^“设置”不会修改手动编辑的配置。你自己的修改/);
  assert.equal(items[0].label, "Quit", "the source template is not mutated");

  const confirm = { title: "Meeting Wiki", message: "Import {count} audio files?", checkboxLabel: "Keep private: notes stay only in the private folder on this Mac", buttons: ["Import", "Cancel"], filters: [{ name: "Audio", extensions: ["wav"] }] };
  const chinese = zh().dialog(confirm, { count: 3 });
  assert.equal(chinese.message, "要导入 3 个音频文件吗？");
  assert.deepEqual(chinese.buttons, ["导入", "取消"]);
  assert.equal(chinese.filters[0].name, "音频");
  assert.deepEqual(chinese.filters[0].extensions, ["wav"]);
  const english = zh("en", "zh-CN").dialog(confirm, { count: 3 });
  assert.equal(english.message, "Import 3 audio files?");
  assert.deepEqual(english.buttons, ["Import", "Cancel"]);

  assert.equal(zh("system", "zh-Hans-CN").text("Quit"), "退出");
  assert.equal(zh("system", "fr-FR").text("Quit"), "Quit");
  const broken = createMainTranslator({ readChoice: () => { throw new Error("no config"); }, systemLocale: () => "zh-CN" });
  assert.equal(broken.text("Quit"), "退出");

  assert.equal(
    localizeText("1 saved recording could not be queued. Import the audio to process it.", "zh-CN"),
    "1 个已保存的录音无法加入队列。请导入音频进行处理。",
  );
  assert.equal(localizeText("Unknown provider text. Run setup again.", "zh-CN"), "Unknown provider text. 请重新运行设置向导。");
  const help = cli.resultDialog({ status: "installed" }).detail;
  assert.match(localizeText(help, "zh-CN"), new RegExp(`\\n${cli.PATH_LINE.replace(/[$.*+?()[\]{}|\\^]/g, "\\$&")}$`));
});

test("main routes every tray, notification, and dialog through the translator", () => {
  assert.match(main, /const tr = createMainTranslator\(\{ readChoice: \(\) => currentUiLanguage\(\), systemLocale: \(\) => app\.getLocale\(\) \}\);/);
  assert.match(main, /const menuText = tr\.snapshot\(\);/);
  assert.match(main, /const localized = tr\.snapshot\(\);\s*await dialog\.showMessageBox\(localized\.buttons\(formatSelfCheck\(report, localized\.text\)\)\);/);
  assert.match(main, /tray\.setContextMenu\(Menu\.buildFromTemplate\(menuText\.menuItems\(items\)\)\);/);
  assert.match(main, /new Notification\(\{ title: t\(title\), body: translateBody \? t\(body, vars\) : body \}\)/);
  assert.equal((main.match(/showDialog: \(options\) => dialog\.showMessageBox\(tr\.dialog\(options\)\)/g) || []).length, 2);
  assert.match(main, /dialog\.showOpenDialog\(tr\.dialog\(\{/);
  assert.match(main, /dialog\.showMessageBox\(tr\.dialog\(importConfirmation\(count\), \{ count \}\)\)/);
  assert.match(main, /source \? "Automatic recording is running\." : requestedTitle \? title : "Meeting \{time\}",\s*\{ vars: \{ time: startedAt \}, translateBody: Boolean\(source\) \|\| !requestedTitle \},/);
  assert.match(main, /notify\(code === 0 \? "Meeting queued" : "Meeting queue failed", label, \{ translateBody: false \}\);/);
  assert.match(main, /recordingLabel\(recordingSession, menuText\.text\)/);
  assert.match(main, /formatQueueLabel\(queueSummary, menuText\.text\)/);
  assert.doesNotMatch(main, /dialog\.showMessageBox\((?!tr\.|localized\.buttons\()/);
  const restart = main.slice(main.indexOf("function restartProcessing("), main.indexOf("function openSettingsWindow("));
  assert.match(restart, /if \(tray\) updateMenu\(\);\s*void refreshQueueStatus\(\);/);
});
