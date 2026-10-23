"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const i18n = require("../renderer/i18n");
const localization = require("../renderer/setup-localization");

const RENDERER = path.join(__dirname, "..", "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

function fakeDocument(selectors) {
  const nodes = new Map(selectors.map((selector) => [selector, [{ textContent: `EN ${selector}` }]]));
  return {
    title: "Set up Meeting Wiki",
    documentElement: { lang: "en" },
    querySelectorAll: (selector) => nodes.get(selector) || [],
    nodes,
  };
}

test("the shared resolver maps choices and macOS Chinese variants", () => {
  assert.equal(i18n.resolveLocale("en", "zh-CN"), "en");
  assert.equal(i18n.resolveLocale("zh-CN", "en-US"), "zh-CN");
  assert.equal(i18n.resolveLocale("system", "zh-Hans-CN"), "zh-CN");
  assert.equal(i18n.resolveLocale("system", "fr-FR"), "en");
  assert.equal(i18n.joinSentences(["A.", "", "B."], "en"), "A. B.");
  assert.equal(i18n.joinSentences(["甲。", "乙。"], "zh-CN"), "甲。乙。");
});

test("setup applies Chinese to every matching node and restores English", () => {
  const selectors = ["[data-back]", "#choose-heading"];
  const documentObject = fakeDocument(selectors);
  documentObject.nodes.get("[data-back]").push({ textContent: "Back" });

  localization.applySetupLocale(documentObject, "zh-CN", "en-US");
  assert.equal(documentObject.title, "设置 Meeting Wiki");
  assert.equal(documentObject.documentElement.lang, "zh-CN");
  assert.deepEqual(documentObject.nodes.get("[data-back]").map((node) => node.textContent), ["返回", "返回"]);

  localization.applySetupLocale(documentObject, "en", "zh-CN");
  assert.equal(documentObject.title, "Set up Meeting Wiki");
  assert.equal(documentObject.nodes.get("#choose-heading")[0].textContent, "EN #choose-heading");
});

test("setup messages translate with placeholders and fall back to English", () => {
  const translate = localization.translateSetupMessage;
  assert.equal(translate("Connected to {host}.", "zh-CN", "en", { host: "api.example.test" }), "已连接到 api.example.test。");
  assert.equal(translate("Connected to {host}.", "en", "zh-CN", { host: "api.example.test" }), "Connected to api.example.test.");
  assert.equal(translate("An unknown provider message.", "zh-CN", "en"), "An unknown provider message.");
  assert.equal(translate(42, "zh-CN", "en"), "");
});

test("the setup catalog is plain text without dashes or arrows", () => {
  const texts = [...Object.values(localization.staticText), ...Object.values(localization.messages)];
  for (const text of texts) {
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, /<[^>]+>|[\u2013\u2014\u2190-\u2194]/, text);
  }
});

test("every static setup selector points at markup that exists in setup.html", () => {
  const html = read("setup.html");
  for (const selector of Object.keys(localization.staticText)) {
    if (selector === "title") continue;
    for (const [, id] of selector.matchAll(/#([a-z][a-z0-9-]*)/g)) {
      assert.match(html, new RegExp(`id="${id}"`), selector);
    }
    for (const [, target] of selector.matchAll(/label\[for='([a-z0-9-]+)'\]/g)) {
      assert.match(html, new RegExp(`<label[^>]*for="${target}"`), selector);
    }
    for (const [, name] of selector.matchAll(/\.([a-z][a-z0-9-]*)/g)) {
      assert.match(html, new RegExp(`class="[^"]*\\b${name}\\b`), selector);
    }
    for (const [, attribute] of selector.matchAll(/\[(data-[a-z-]+)\]/g)) {
      assert.match(html, new RegExp(`\\s${attribute}[=\\s>]`), selector);
    }
  }
});

test("setup offers the app language first and loads the shared localization scripts", () => {
  const html = read("setup.html");
  const choose = html.slice(html.indexOf('<section id="panel-choose"'));
  assert.ok(choose.indexOf('id="app-language"') < choose.indexOf('id="choose-heading"'));
  for (const value of ["system", "en", "zh-CN"]) {
    assert.match(choose, new RegExp(`<option value="${value}">`));
  }
  const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((match) => match[1]);
  assert.deepEqual(scripts, ["i18n.js", "setup-localization.js", "setup.js"]);
  const js = read("setup.js");
  assert.match(js, /call\("setAppLanguage", choice\)/);
  assert.match(js, /state\.languageTouched = initial\.mode !== "online" && initial\.mode !== "local";/);
});
