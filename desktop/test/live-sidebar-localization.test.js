"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const i18n = require("../renderer/i18n");
const localization = require("../renderer/live-sidebar-localization");

const RENDERER = path.join(__dirname, "..", "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

test("the live catalog is plain text without dashes or arrows", () => {
  for (const text of [...Object.values(localization.staticText), ...Object.values(localization.messages)]) {
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, /<[^>]+>|[\u2013\u2014\u2190-\u2194]/, text);
  }
});

test("every static live selector points at markup in live-sidebar.html", () => {
  const html = read("live-sidebar.html");
  for (const selector of Object.keys(localization.staticText)) {
    if (selector === "title") continue;
    for (const [, id] of selector.matchAll(/#([a-z][a-z0-9-]*)/g)) assert.match(html, new RegExp(`id="${id}"`), selector);
    for (const [, name] of selector.matchAll(/\.([a-z][a-z0-9-]*)/g)) assert.match(html, new RegExp(`class="[^"]*\\b${name}\\b`), selector);
  }
  const footer = html.match(/<footer class="live-foot">([\s\S]*?)<\/footer>/);
  assert.ok(footer);
  assert.equal((footer[1].match(/<p>/g) || []).length, 3);
});

test("every English string live-sidebar.js shows has Chinese copy", () => {
  const js = read("live-sidebar.js");
  const keys = new Set(Object.keys(localization.messages));
  const constants = [...js.matchAll(/^\s+[a-z_]+: "([A-Z][^"]+)",$/gm)].map((match) => match[1]);
  const inline = [...js.matchAll(/\bt\(event\.scope === "external" \? "([^"]+)" : "([^"]+)"\)/g)].flatMap((match) => [match[1], match[2]]);
  const speakers = [...js.matchAll(/you: "([^"]+)", others: "([^"]+)"/g)].flatMap((match) => [match[1], match[2]]);
  assert.equal(inline.length, 2);
  assert.equal(speakers.length, 2);
  assert.ok(constants.length >= 18);
  for (const message of [...constants, ...inline, ...speakers]) assert.ok(keys.has(message), message);
  assert.match(read("live-sidebar.html"), /<script src="i18n\.js" defer><\/script>\s*<script src="live-sidebar-localization\.js" defer><\/script>\s*<script src="live-sidebar\.js" defer><\/script>/);
});

function fakeElement(id, text = "") {
  const classes = new Set();
  return {
    id,
    hidden: false,
    textContent: text,
    className: "",
    dataset: {},
    children: [],
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    get childElementCount() { return this.children.length; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    remove() {},
  };
}

function loadSidebar(navigatorLanguage = "en-US") {
  const ids = ["live-status", "live-private", "live-scope", "live-issue", "live-summary-heading", "live-summary",
    "live-summary-empty", "live-transcript-heading", "live-transcript", "live-transcript-empty"];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement(id, id)]));
  const footer = [1, 2, 3].map((index) => fakeElement(`foot-${index}`, `English footer ${index}`));
  const documentObject = {
    title: "Meeting Wiki Live",
    documentElement: { lang: "en" },
    getElementById: (id) => elements[id],
    createElement: () => fakeElement(""),
    querySelectorAll(selector) {
      const footMatch = selector.match(/^\.live-foot p:nth-child\((\d)\)$/);
      if (footMatch) return [footer[Number(footMatch[1]) - 1]];
      const idMatch = selector.match(/^#([a-z-]+)$/);
      return idMatch && elements[idMatch[1]] ? [elements[idMatch[1]]] : [];
    },
  };
  let handler = null;
  const window = {
    meetingWikiLive: { subscribe: (callback) => { handler = callback; return true; }, unsubscribe() {} },
    addEventListener() {},
  };
  const context = { window, document: documentObject, navigator: { language: navigatorLanguage } };
  vm.createContext(context);
  for (const file of ["i18n.js", "live-sidebar-localization.js", "live-sidebar.js"]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  return { elements, footer, documentObject, send: (event) => handler(event) };
}

test("a Chinese locale translates the window and keeps captions that already arrived", () => {
  const sidebar = loadSidebar();
  sidebar.send({ type: "state", phase: "listening", private: true, scope: "external", issue: "system_audio_silent" });
  sidebar.send({ type: "transcript", sequence: 1, text: "Hello there", speaker: "others" });
  sidebar.send({ type: "locale", uiLanguage: "zh-CN" });
  const { elements } = sidebar;
  assert.equal(sidebar.documentObject.documentElement.lang, "zh-CN");
  assert.equal(sidebar.documentObject.title, "Meeting Wiki 实时");
  assert.equal(elements["live-status"].textContent, "正在聆听。");
  assert.equal(elements["live-status"].dataset.phase, "listening");
  assert.equal(elements["live-scope"].textContent, "外部 provider");
  assert.match(elements["live-issue"].textContent, /^还没有收到其他参会者的声音/);
  assert.equal(elements["live-summary-heading"].textContent, "总结");
  assert.match(sidebar.footer[0].textContent, /^实时字幕包括你的麦克风/);
  const [line] = elements["live-transcript"].children;
  assert.equal(line.children[0].textContent, "其他人");
  assert.equal(line.children[1].textContent, "Hello there");
  sidebar.send({ type: "transcript", sequence: 2, text: "Next", speaker: "you" });
  assert.equal(elements["live-transcript"].children[1].children[0].textContent, "你");
});

test("English and system locales keep the English copy", () => {
  const english = loadSidebar("zh-CN");
  english.send({ type: "locale", uiLanguage: "en" });
  english.send({ type: "state", phase: "listening", scope: "local" });
  assert.equal(english.elements["live-status"].textContent, "Listening.");
  assert.equal(english.elements["live-scope"].textContent, "Local only");
  assert.equal(english.footer[1].textContent, "English footer 2");

  const system = loadSidebar("zh-TW");
  system.send({ type: "locale", uiLanguage: "system" });
  assert.equal(system.elements["live-status"].textContent, "正在启动实时视图。");
  assert.equal(i18n.resolveLocale("system", "fr-FR"), "en");
});

test("live messages translate only in Chinese", () => {
  const translate = localization.translateLiveMessage;
  assert.equal(translate("Listening.", "zh-CN", "en"), "正在聆听。");
  assert.equal(translate("Listening.", "system", "en-US"), "Listening.");
  assert.equal(translate("", "zh-CN", "en"), "");
});
