"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");

const localization = require("../renderer/wiki-localization");
const { registerHandlers, savedUiLanguage } = require("../wiki-window");
const { RESOURCE_ERRORS } = require("../memory-client");

const RENDERER = path.join(__dirname, "..", "renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

test("the Wiki catalog is plain text without dashes or arrows", () => {
  for (const text of [...Object.values(localization.staticText), ...Object.values(localization.messages)]) {
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, /<[^>]+>|[\u2013\u2014\u2190-\u2194]/, text);
  }
});

test("every static Wiki selector points at markup in index.html", () => {
  const html = read("index.html");
  for (const selector of Object.keys(localization.staticText)) {
    for (const [, id] of selector.matchAll(/#([a-z][a-z0-9-]*)/g)) assert.match(html, new RegExp(`id="${id}"`), selector);
    for (const [, target] of selector.matchAll(/label\[for='([a-z0-9-]+)'\]/g)) assert.match(html, new RegExp(`<label[^>]*for="${target}"`), selector);
    for (const [, view] of selector.matchAll(/data-view='([a-z]+)'/g)) assert.match(html, new RegExp(`data-view="${view}"`), selector);
    for (const [, name] of selector.matchAll(/\.([a-z][a-z0-9-]*)/g)) assert.match(html, new RegExp(`class="[^"]*\\b${name}\\b`), selector);
  }
  assert.match(html, /<script src="i18n\.js" defer><\/script>\s*<script src="wiki-localization\.js" defer><\/script>\s*<script src="app\.js" defer><\/script>/);
  for (const { selector, attribute, english } of localization.attributes) {
    assert.ok(Object.prototype.hasOwnProperty.call(localization.messages, english), english);
    assert.ok(html.includes(attribute === "aria-label" ? `aria-label="${english}"` : `placeholder="${english}"`), `${selector} ${attribute}`);
  }
});

// Wrapping every checkbox text in a span keeps the translated label from removing the control.
test("labels that hold a control translate only their own text span", () => {
  const html = read("index.html");
  assert.equal((html.match(/<input type="checkbox" name="memory-type"[^>]*\/> <span id="type-label-/g) || []).length, 7);
  assert.match(html, /<input id="memory-include-private" type="checkbox" \/>\s*<span id="memory-private-label">/);
  assert.match(html, /<code>Remote participant<\/code> <span id="corrections-intro-b">or<\/span> <code>spk_1<\/code>/);
});

// Brand name, monogram, example labels from the data, and the memory scope line set by app.js.
const UNTRANSLATED_TEXT = ["Meeting Wiki", "Meeting Wiki", "MW", "Remote participant", "spk_1", "Showing shared memory only."];

test("every visible text node in index.html has a Chinese selector or is exempt", () => {
  const html = read("index.html").replace(/<script[\s\S]*?<\/script>/g, "");
  const nodes = [...html.matchAll(/>([^<>]+)</g)].map((match) => match[1].replace(/\s+/g, " ").trim()).filter((text) => /[A-Za-z]/.test(text));
  const remaining = [...nodes];
  for (const exempt of UNTRANSLATED_TEXT) {
    const at = remaining.indexOf(exempt);
    assert.ok(at >= 0, `exempt text is missing from index.html: ${exempt}`);
    remaining.splice(at, 1);
  }
  assert.equal(remaining.length, Object.keys(localization.staticText).length, `text nodes without a selector: ${remaining.length}`);
});

test("every English string app.js shows has Chinese copy", () => {
  const js = read("app.js").replace(/"\s*\+\s*"/g, "");
  const keys = new Set(Object.keys(localization.messages));
  const literals = new Set();
  for (const [, text] of js.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)+)"/g)) literals.add(text);
  for (const [, first, second] of js.matchAll(/\? "([^"]+)"\s*:\s*"([^"]+)"/g)) { literals.add(first); literals.add(second); }
  for (const [, text] of js.matchAll(/emptyNote\(\s*"((?:[^"\\]|\\.)+)"/g)) literals.add(text);
  for (const [, text] of js.matchAll(/(?:success|confirm|label): "((?:[^"\\]|\\.)+)"/g)) literals.add(text);
  for (const [, text] of js.matchAll(/(?:meeting|person|topic|decision|action_item|transcript_segment|resource|reference|design_doc|ticket|code_review|notes|follow_up|page_not_found): "([^"]+)"/g)) literals.add(text);
  for (const [, text] of js.matchAll(/\|\| "([A-Z][^"]+)"/g)) literals.add(text);
  for (const [, text] of js.matchAll(/error: "([^"]+)"/g)) literals.add(text);
  assert.ok(literals.size >= 70, `found ${literals.size}`);
  for (const message of literals) {
    const sentences = message.split(/(?<=[.?!])\s+/);
    assert.ok(keys.has(message) || sentences.every((sentence) => keys.has(sentence)), `missing Chinese copy: ${message}`);
  }
  for (const text of ["Retry 1 failed job?", "Retry {count} failed jobs?", "Each one is processed again with the current provider settings."]) assert.ok(keys.has(text), text);
});

test("every memory edge, job stage, and job state the index can produce has Chinese copy", () => {
  const view = loadRenderer({ uiLanguage: "zh-CN" });
  const edges = vm.runInContext("EDGE_LABELS", view.context);
  const memory = fs.readFileSync(path.join(__dirname, "..", "..", "meeting_wiki", "memory.py"), "utf8");
  const stored = [...memory.matchAll(/self\._link\(connection, \w+, \w+, "([a-z_]+)"/g)].map((match) => match[1]);
  assert.equal(stored.length, 8);
  for (const relation of [...stored, ...require("../memory-client").RESOURCE_RELATIONS]) {
    assert.ok(Object.prototype.hasOwnProperty.call(edges, relation), `no label for edge ${relation}`);
    assert.ok(Object.prototype.hasOwnProperty.call(localization.messages, edges[relation]), `no Chinese copy for ${edges[relation]}`);
  }
  const models = fs.readFileSync(path.join(__dirname, "..", "..", "meeting_wiki", "models.py"), "utf8");
  const stages = [...models.slice(models.indexOf("class JobStage"), models.indexOf("class JobRecord")).matchAll(/= "([a-z]+)"/g)].map((match) => match[1]);
  assert.ok(stages.length >= 9);
  for (const word of stages) assert.ok(Object.prototype.hasOwnProperty.call(localization.messages, word), `no Chinese copy for ${word}`);
  assert.ok(Object.prototype.hasOwnProperty.call(localization.messages, "Unknown speaker"));
});

test("main-process error text reaching the Wiki window has Chinese copy", () => {
  const keys = new Set(Object.keys(localization.messages));
  const windowSource = fs.readFileSync(path.join(__dirname, "..", "wiki-window.js"), "utf8");
  const fromWindow = [...windowSource.matchAll(/error: "([^"]+)"/g)].map((match) => match[1]);
  const fromStatus = [...fs.readFileSync(path.join(__dirname, "..", "status.js"), "utf8").matchAll(/new Error\("(Invalid job selected)"\)/g)].map((match) => match[1]);
  assert.deepEqual(fromWindow, ["This action is unavailable."]);
  for (const message of [...fromWindow, ...fromStatus, ...Object.values(RESOURCE_ERRORS), "The resource could not be saved."]) {
    assert.ok(keys.has(message), message);
  }
});

test("Wiki messages translate sentence by sentence and fill placeholders", () => {
  const translate = localization.translateWikiMessage;
  assert.equal(translate("Retry 2 failed jobs? Each one is processed again with the current provider settings.".replace("2", "{count}"), "zh-CN", "en", { count: 2 }), "要重试 2 个失败任务吗？每个任务都会用当前 provider 设置重新处理。");
  assert.equal(translate("Retry {count} failed jobs?", "en", "zh-CN", { count: 2 }), "Retry 2 failed jobs?");
  assert.equal(translate("No pages match “{query}”.", "system", "zh-Hans-CN", { query: "{count}" }), "没有页面匹配“{count}”。");
  assert.equal(translate("An unknown error.", "zh-CN", "en"), "An unknown error.");
  assert.equal(translate("pending", "system", "fr-FR"), "pending");
});

function fakeElement(id, text = "") {
  const attributes = new Map();
  const classes = new Set();
  return {
    id,
    hidden: false,
    textContent: text,
    className: "",
    dataset: {},
    children: [],
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    removeAttribute: (name) => attributes.delete(name),
    appendChild(node) { this.children.push(node); return node; },
    addEventListener() {},
    focus() {},
  };
}

function loadRenderer({ uiLanguage, navigatorLanguage = "en-US", api = {} }) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const statics = new Map();
  const documentObject = {
    title: "Meeting Wiki",
    documentElement: { lang: "en" },
    body: fakeElement("body"),
    getElementById: byId,
    createElement: () => fakeElement(""),
    querySelectorAll(selector) {
      if ([".rail-item", ".view", "[data-recovery-action]", ".workbench > *"].includes(selector)) return [];
      if (!statics.has(selector)) statics.set(selector, [fakeElement(selector, `EN ${selector}`)]);
      return statics.get(selector);
    },
    querySelector(selector) {
      if (!statics.has(`one:${selector}`)) statics.set(`one:${selector}`, fakeElement(selector));
      return statics.get(`one:${selector}`);
    },
    addEventListener(name, handler) { if (name === "DOMContentLoaded") documentObject.start = handler; },
  };
  const windowObject = {
    meetingWiki: {
      uiLanguage: async () => uiLanguage,
      listRecent: async () => ({ items: [] }),
      actionItems: async () => ({ items: ["| | Send notes | [[meetings/a]] | |"] }),
      corrections: { inbox: async () => [] },
      jobs: {
        listDead: async () => [{ id: 7, stage: "transcribing", attempts: 2, max_attempts: 3, label: "Planning sync", captured_at: "2026-10-01T09:30:00Z" }],
        listDismissed: async () => [],
      },
      memory: { search: async () => ({ items: [] }) },
      ...api,
    },
    addEventListener() {},
  };
  const context = { window: windowObject, document: documentObject, navigator: { language: navigatorLanguage }, Date, Number, String, Promise, setTimeout, clearTimeout };
  vm.createContext(context);
  for (const file of ["i18n.js", "wiki-localization.js", "app.js"]) vm.runInContext(read(file), context, { filename: file });
  return { byId, context, documentObject, statics };
}

test("the Chinese Wiki window translates static text, attributes, and rendered rows", async () => {
  const view = loadRenderer({ uiLanguage: "zh-CN" });
  await view.documentObject.start();
  await new Promise((resolve) => setImmediate(resolve));
  await view.context.switchView("actions");
  await view.context.switchView("recovery");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.documentObject.documentElement.lang, "zh-CN");
  assert.equal(view.byId("recent-list").children[0].textContent, "还没有会议。录制或导入一场会议即可开始。", "the language is applied before the first list renders");
  assert.equal(view.statics.get("#search-button")[0].textContent, "搜索");
  assert.equal(view.statics.get("#type-label-person")[0].textContent, "人员");
  assert.equal(view.documentObject.querySelector(".rail").getAttribute("aria-label"), "分区");
  assert.equal(view.documentObject.querySelector("#search-input").getAttribute("placeholder"), "例如：迁移上线");
  assert.equal(view.byId("memory-scope").textContent, "只显示共享记忆。");
  const [card] = view.byId("actions-list").children;
  assert.equal(card.children[0].children[0].textContent, "未分配");
  assert.equal(card.children[0].children[2].textContent, "没有截止日期");
  const recovery = view.byId("recovery-list").children[0];
  assert.equal(recovery.children[0].textContent, "Planning sync", "meeting titles are never translated");
  assert.match(recovery.children[1].textContent, /^采集于 .* · 任务 #7 · 转写中 · 第 2 次，共 3 次$/);
  assert.equal(recovery.children[2].textContent, "任务在“转写中”阶段停止。");
  assert.equal(view.byId("recovery-retry-all").dataset.count, "1");
  assert.match(view.byId("recovery-updated").textContent, /^最后更新于 /);
});

test("English, system, and unreadable choices keep or follow the right language", async () => {
  const english = loadRenderer({ uiLanguage: "en", navigatorLanguage: "zh-CN" });
  await english.documentObject.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(english.statics.get("#search-button")[0].textContent, "EN #search-button");
  assert.equal(english.byId("memory-scope").textContent, "Showing shared memory only.");

  const system = loadRenderer({ uiLanguage: "system", navigatorLanguage: "zh-Hans-CN" });
  await system.documentObject.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(system.statics.get("#search-button")[0].textContent, "搜索");

  const broken = loadRenderer({ uiLanguage: "fr", navigatorLanguage: "zh-CN", api: { uiLanguage: async () => { throw new Error("no bridge"); } } });
  await broken.documentObject.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broken.byId("memory-scope").textContent, "只显示共享记忆。");
});

test("the Wiki window reads the saved language through one named channel", async () => {
  const handlers = new Map();
  registerHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    dataDir: "/tmp/mw-wiki-localization-none",
    python: "/nonexistent/python",
    configPath: "/nonexistent/config.toml",
    uiLanguage: () => "zh-CN",
  });
  assert.equal(await handlers.get("wiki:uiLanguage")(), "zh-CN");
  assert.equal(savedUiLanguage({ uiLanguage: () => "fr" }), "system");
  assert.equal(savedUiLanguage({ uiLanguage: () => { throw new Error("unreadable"); } }), "system");
  assert.equal(savedUiLanguage({}), "system");

  const invocations = [];
  const exposed = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { invoke: (channel, ...args) => { invocations.push({ channel, args }); return Promise.resolve("en"); } },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    return request === "electron" ? electron : originalLoad.call(this, request, ...rest);
  };
  try {
    const preloadPath = require.resolve("../preload");
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(await exposed.meetingWiki.uiLanguage(), "en");
  assert.deepEqual(invocations, [{ channel: "wiki:uiLanguage", args: [] }]);
});

test("main passes the saved language getter to the Wiki window", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /\{ dataDir: DATA_DIR, python: PYTHON, configPath: CONFIG_PATH, uiLanguage: currentUiLanguage \}/);
});
