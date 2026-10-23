"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const localization = require("../renderer/record-localization");

const RENDERER = path.join(__dirname, "..", "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

test("the recording catalog is plain text without dashes or arrows", () => {
  for (const text of [...Object.values(localization.staticText), ...Object.values(localization.messages)]) {
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, /<[^>]+>|[\u2013\u2014\u2190-\u2194]/, text);
  }
});

test("every static recording selector points at markup in record.html", () => {
  const html = read("record.html");
  for (const selector of Object.keys(localization.staticText)) {
    if (selector === "title") continue;
    for (const [, id] of selector.matchAll(/#([a-z][a-z0-9-]*)/g)) assert.match(html, new RegExp(`id="${id}"`), selector);
    for (const [, target] of selector.matchAll(/label\[for='([a-z0-9-]+)'\]/g)) {
      assert.match(html, new RegExp(`<label[^>]*for="${target}"`), selector);
    }
    for (const [, name] of selector.matchAll(/\.([a-z][a-z0-9-]*)/g)) assert.match(html, new RegExp(`class="[^"]*\\b${name}\\b`), selector);
  }
  assert.equal((html.match(/<dt>/g) || []).length, 5);
});

test("every English string record.js translates has Chinese copy", () => {
  const js = read("record.js");
  const keys = new Set(Object.keys(localization.messages));
  const used = [...js.matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)].map((match) => match[1]);
  const constants = [...js.matchAll(/^\s+(?:[a-z_]+|"[a-z-]+"): "([A-Z][^"]+)",$/gm)].map((match) => match[1]);
  for (const message of [...used, ...constants]) assert.ok(keys.has(message), message);
  assert.match(read("record.html"), /<script src="i18n\.js" defer><\/script>\s*<script src="record-localization\.js" defer><\/script>\s*<script src="record\.js" defer><\/script>/);
});

test("recording messages fill placeholders in both languages", () => {
  const translate = localization.translateRecordMessage;
  assert.equal(translate("Keep the title to {max} characters or fewer.", "zh-CN", "en", { max: 200 }), "标题不能超过 200 个字符。");
  assert.equal(translate("Keep the title to {max} characters or fewer.", "system", "en-US", { max: 200 }), "Keep the title to 200 characters or fewer.");
});

test("every recording error from record-window.js has Chinese copy", () => {
  const recordWindow = require("../record-window");
  const source = fs.readFileSync(path.join(__dirname, "..", "record-window.js"), "utf8");
  const keys = new Set(Object.keys(localization.messages));
  const messages = new Set(Object.values(recordWindow.BLOCKER_MESSAGES));
  for (const [, text] of source.matchAll(/RecordError\(\s*"((?:[^"\\]|\\.)+)"/g)) messages.add(text);
  messages.add(`Keep the title to ${recordWindow.TITLE_MAX} characters or fewer.`);
  messages.add("The recording could not start. Try again.");
  for (const message of messages) {
    for (const sentence of message.split(/(?<=\.)\s+/)) assert.ok(keys.has(message) || keys.has(sentence), sentence);
  }
});
