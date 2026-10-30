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
    createElement: (tag) => Object.assign(fakeElement(""), { tagName: String(tag).toUpperCase() }),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
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
  assert.match(recovery.children[1].textContent, /^采集于 .* · 任务 #7 · 在“转写中”阶段停止 · 第 2 次，共 3 次$/);
  assert.equal(recovery.children[2].textContent, "任务在“转写中”阶段停止。");
  assert.equal(view.byId("recovery-retry-all").dataset.count, "1");
  assert.equal(view.byId("recovery-retry-all").hidden, true, "Retry all is hidden with only one job");
  assert.match(view.byId("recovery-updated").textContent, /^最后更新于 /);
});

async function recoveryCardFor(uiLanguage, diagnostic) {
  const job = { id: 15, stage: "transcribing", attempts: 5, max_attempts: 5, label: "Recording", captured_at: "2026-10-26T15:07:18Z", diagnostic };
  const view = loadRenderer({ uiLanguage, api: { jobs: { listDead: async () => [job, { ...job, id: 16 }], listDismissed: async () => [] } } });
  await view.documentObject.start();
  await new Promise((resolve) => setImmediate(resolve));
  await view.context.switchView("recovery");
  await new Promise((resolve) => setImmediate(resolve));
  return { view, card: view.byId("recovery-list").children[0] };
}

const providerFailure = (httpStatus) => ({
  category: "provider_request_failed",
  provider: "gemini",
  operation: "transcription",
  sdk_error_type: "BadRequestError",
  http_status: httpStatus,
});

test("a failed provider request explains the next step and keeps the raw error behind a disclosure", async () => {
  const { view, card } = await recoveryCardFor("en", providerFailure(400));
  assert.equal(card.children[2].textContent, "Google Gemini rejected the request. Retry the job. If it fails again, choose Export diagnostics in the menu bar.");
  const details = card.children[3];
  assert.equal(details.className, "recovery-details");
  assert.equal(details.children[0].textContent, "Technical details");
  assert.equal(details.children[1].textContent, "gemini transcription failed (BadRequestError, HTTP 400).");
  assert.equal(view.byId("recovery-retry-all").hidden, false, "Retry all shows with two or more jobs");

  const cases = [
    [401, /did not accept the API key/],
    [429, /rate limit or quota/],
    [503, /server problem/],
    [0, /could not be reached/],
  ];
  for (const [status, pattern] of cases) {
    const { card: next } = await recoveryCardFor("en", providerFailure(status));
    assert.match(next.children[2].textContent, pattern, `HTTP ${status}`);
  }
  const { card: chinese } = await recoveryCardFor("zh-CN", providerFailure(429));
  assert.equal(chinese.children[2].textContent, "Google Gemini 达到了速率限制或配额。请等几分钟后重试。");
  assert.equal(chinese.children[3].children[0].textContent, "技术细节");
});

async function openedPage(content) {
  const view = loadRenderer({ uiLanguage: "en", api: { readPage: async (pagePath) => ({ path: pagePath, content, truncated: false }) } });
  await view.documentObject.start();
  await new Promise((resolve) => setImmediate(resolve));
  await view.context.openPage("meetings/2026-10-20-roadmap-sync.md");
  return view;
}

test("the page viewer shows the page heading as its title and renders Markdown as plain nodes", async () => {
  const view = await openedPage([
    "---", "privacy: shared", "---",
    "# Roadmap sync", "",
    "## Decisions", "- Use **option B** with `staged` rollout", "- Owner [[people/sam|Sam]]", "",
    "<img src=x onerror=alert(1)> stays text.",
  ].join("\n"));
  assert.equal(view.byId("page-title").textContent, "Roadmap sync");
  const blocks = view.byId("page-content").children;
  assert.deepEqual(blocks.map((block) => block.tagName || "TEXT"), ["H3", "UL", "P", "P"]);
  const [first, second] = blocks[1].children;
  assert.deepEqual(first.children.map((node) => node.tagName || "TEXT"), ["TEXT", "STRONG", "TEXT", "CODE", "TEXT"]);
  assert.equal(second.children[1].className, "page-wikilink");
  assert.equal(second.children[1].textContent, "Sam");
  assert.equal(blocks[2].children[0].textContent, "<img src=x onerror=alert(1)> stays text.", "markup in a page stays text");
  assert.equal(blocks[3].className, "page-path");
  assert.equal(blocks[3].textContent, "meetings/2026-10-20-roadmap-sync.md");
});

test("a page without a heading keeps its path as the title", async () => {
  const view = await openedPage("Just notes.");
  assert.equal(view.byId("page-title").textContent, "meetings/2026-10-20-roadmap-sync.md");
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

const CITATION = {
  meetingTitle: "Platform sync",
  occurredAt: "2026-09-04T15:00:00+00:00",
  privacy: "shared",
  sourcePath: "wiki/meetings/2026-09-04-platform-sync.md",
  anchor: null,
};

async function memoryCardsFor(uiLanguage, items) {
  const view = loadRenderer({
    uiLanguage,
    api: { memory: { search: async () => ({ count: items.length, items }) } },
  });
  await view.documentObject.start();
  await new Promise((resolve) => setImmediate(resolve));
  view.byId("memory-input").value = "canary";
  await view.context.runMemorySearch();
  return view.byId("memory-results").children;
}

const memoryItem = (overrides = {}) => ({
  nodeType: "decision",
  meetingNodeId: "",
  url: "",
  resourceRelation: "",
  label: "Rollout decision",
  content: "Ship the canary rollout",
  occurredAt: CITATION.occurredAt,
  privacy: "shared",
  source: null,
  citation: CITATION,
  relations: [],
  ...overrides,
});

const texts = (card) => card.children.map((child) => child.textContent);

test("a memory result shows its citation in the chosen language and opens the cited page", async () => {
  const [english] = await memoryCardsFor("en", [memoryItem()]);
  assert.ok(texts(english).includes("From Platform sync · 2026-09-04"));
  const [chinese] = await memoryCardsFor("zh-CN", [memoryItem()]);
  assert.ok(texts(chinese).includes("来自 Platform sync · 2026-09-04"));
  assert.equal(chinese.children.at(-1).textContent, "打开会议");
});

test("a transcript line shows the time inside the meeting from its anchor", async () => {
  const anchored = memoryItem({
    nodeType: "transcript_segment",
    citation: { ...CITATION, anchor: { startSeconds: 3725, endSeconds: 3730 } },
  });
  const [english] = await memoryCardsFor("en", [anchored]);
  assert.ok(texts(english).includes("From Platform sync · 2026-09-04 · at 1:02:05"));
  const [chinese] = await memoryCardsFor("zh-CN", [anchored]);
  assert.ok(texts(chinese).includes("来自 Platform sync · 2026-09-04 · 位于 1:02:05"));
  const short = memoryItem({
    nodeType: "transcript_segment",
    citation: { ...CITATION, anchor: { startSeconds: 65, endSeconds: 70 } },
  });
  assert.ok(texts((await memoryCardsFor("en", [short]))[0]).includes("From Platform sync · 2026-09-04 · at 1:05"));
});

test("a result without a citation shows no source line and no open button", async () => {
  const [card] = await memoryCardsFor("en", [memoryItem({ nodeType: "topic", citation: null })]);
  assert.ok(!texts(card).some((line) => line.startsWith("From ")));
  assert.ok(!texts(card).includes("Open meeting"));
});

test("a private citation is labeled private and never offers to open a page", async () => {
  const privateCitation = { ...CITATION, privacy: "private", sourcePath: "" };
  const [card] = await memoryCardsFor("en", [memoryItem({ privacy: "private", citation: privateCitation })]);
  assert.ok(texts(card).includes("From Platform sync · 2026-09-04 (private)"));
  assert.ok(!texts(card).includes("Open meeting"));
});

test("each relation shows its own citation title", async () => {
  const related = memoryItem({
    relations: [{ relation: "decided_in", direction: "out", nodeType: "meeting", label: "Platform sync", source: null, citation: CITATION }],
  });
  const [card] = await memoryCardsFor("en", [related]);
  const list = card.children.find((child) => child.className === "relation-list");
  assert.equal(list.children[0].textContent, "decided in: Meeting “Platform sync”, source: Platform sync");
});


const DECISION = {
  title: "Use polling",
  detail: "Poll every 5 minutes.",
  owner: "Sam",
  status: "accepted",
  effectiveStatus: "accepted",
  occurredAt: "2026-09-01T15:00:00+00:00",
  privacy: "shared",
  citation: CITATION,
  supersedes: null,
  supersededBy: null,
};

async function decisionCardsFor(uiLanguage, items) {
  const view = loadRenderer({
    uiLanguage,
    api: { memory: { search: async () => ({ items: [] }), decisions: async () => ({ count: items.length, items }) } },
  });
  await view.documentObject.start();
  await new Promise((resolve) => setImmediate(resolve));
  await view.context.loadDecisions();
  return view.byId("decisions-list").children;
}

test("a superseded decision keeps its place, gains a badge, and links to its replacement", async () => {
  const replaced = { ...DECISION, effectiveStatus: "superseded", supersededBy: { title: "Use webhooks", occurredAt: "2026-09-08T15:00:00+00:00", citation: CITATION } };
  const replacement = { ...DECISION, title: "Use webhooks", occurredAt: "2026-09-08T15:00:00+00:00", supersedes: { title: "Use polling", occurredAt: "2026-09-01T15:00:00+00:00", citation: CITATION } };
  const [first, second] = await decisionCardsFor("en", [replaced, replacement]);
  assert.equal(first.children[0].children[0].textContent, "Superseded");
  assert.ok(texts(first).includes("Replaced by “Use webhooks” (2026-09-08)"));
  assert.ok(texts(first).includes("2026-09-01 · Owner: Sam"));
  assert.ok(texts(first).includes("Poll every 5 minutes."));
  assert.equal(second.children[0].children.length, 0, "the current decision has no badge");
  assert.ok(texts(second).includes("Replaces “Use polling” (2026-09-01)"));
  assert.equal(first.children.at(-1).textContent, "Open meeting");
});

test("the Chinese decision history translates badges, links, and the empty state", async () => {
  const replaced = { ...DECISION, effectiveStatus: "superseded", supersededBy: { title: "Use webhooks", occurredAt: "2026-09-08T15:00:00+00:00", citation: CITATION } };
  const reversed = { ...DECISION, title: "Drop retries", status: "reversed", effectiveStatus: "reversed", owner: "" };
  const [first, second] = await decisionCardsFor("zh-CN", [replaced, reversed]);
  assert.equal(first.children[0].children[0].textContent, "已被取代");
  assert.ok(texts(first).includes("被“Use webhooks”取代（2026-09-08）"));
  assert.ok(texts(first).includes("2026-09-01 · 负责人：Sam"));
  assert.equal(second.children[0].children[0].textContent, "已撤销");
  assert.ok(texts(second).includes("2026-09-01"), "no owner means no owner text");
  const [empty] = await decisionCardsFor("zh-CN", []);
  assert.equal(empty.textContent, "还没有记录任何决定。");
});

test("the decision history titles are shown as written and never as markup", async () => {
  const [card] = await decisionCardsFor("en", [{ ...DECISION, title: "<img src=x onerror=alert(1)>" }]);
  assert.equal(card.children[0].textContent, "<img src=x onerror=alert(1)>");
});
