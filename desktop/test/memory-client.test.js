"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const {
  NODE_TYPES,
  memorySearchArgs,
  projectItem,
  sanitizeOptions,
  searchMemory,
  validateQuery,
} = require("../memory-client");

const DESKTOP = path.join(__dirname, "..");

function fakeExec(response, calls) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    process.nextTick(() => callback(response.error || null, response.stdout || "", ""));
  };
}

const sharedSource = {
  source_id: "aaaaaaaaaaaaaaaa",
  title: "Platform sync",
  occurred_at: "2026-09-04T15:00:00+00:00",
  privacy: "shared",
  meeting_key: "wiki/meetings/2026-09-04-platform-sync.md",
};
const citationFor = (source, anchor = null) => ({
  version: 1,
  meeting_id: source.source_id,
  meeting_title: source.title,
  occurred_at: source.occurred_at,
  privacy: source.privacy,
  source_path: source.meeting_key,
  anchor,
});
const privateSource = {
  source_id: "bbbbbbbbbbbbbbbb",
  title: "Career chat",
  occurred_at: "2026-09-05T15:00:00+00:00",
  privacy: "private",
  meeting_key: "private/meetings/2026-09-05-career-chat.md",
};

function cliItem(overrides = {}) {
  return {
    node_id: "decision:0123456789abcdef",
    node_type: "decision",
    label: "Rollout decision",
    content: "Ship the canary rollout",
    source_id: sharedSource.source_id,
    occurred_at: sharedSource.occurred_at,
    privacy: "shared",
    metadata: { owner: "Alex" },
    source: sharedSource,
    citation: citationFor(sharedSource),
    relations: [
      { relation: "decided_in", direction: "out", node_id: "meeting:x", node_type: "meeting", label: "Platform sync", source: sharedSource, citation: citationFor(sharedSource) },
    ],
    ...overrides,
  };
}

test("memorySearchArgs passes values as --flag=value and defaults to shared only", () => {
  assert.deepEqual(memorySearchArgs("/c", "  canary rollout ", {}), [
    "-m", "meeting_wiki.cli", "--config", "/c", "memory-search",
    "--query=canary rollout", "--limit=12",
  ]);
  const injected = memorySearchArgs("/c", "--include-private", {});
  assert.equal(injected.includes("--include-private"), false);
  assert.ok(injected.includes("--query=--include-private"));
});

test("memorySearchArgs adds sorted unique type filters and the explicit private opt-in", () => {
  const args = memorySearchArgs("/c", "canary", {
    types: ["topic", "decision", "topic"],
    limit: 500,
    includePrivate: true,
  });
  assert.deepEqual(args.slice(5), [
    "--query=canary", "--limit=30", "--type=decision", "--type=topic", "--include-private",
  ]);
});

test("only a strict boolean true opts in to private memory", () => {
  for (const value of ["true", 1, {}, [], null, undefined]) {
    assert.equal(sanitizeOptions({ includePrivate: value }).includePrivate, false);
  }
  assert.equal(sanitizeOptions(null).includePrivate, false);
  assert.equal(sanitizeOptions([true]).includePrivate, false);
});

test("invalid queries and type filters are refused before spawning", () => {
  assert.throws(() => validateQuery(42), /string/);
  assert.throws(() => validateQuery(" a "), /2-300/);
  assert.throws(() => validateQuery("a".repeat(301)), /2-300/);
  assert.throws(() => validateQuery("canary\nrollout"), /invalid characters/);
  assert.throws(() => validateQuery("canary\u0000"), /invalid characters/);
  assert.throws(() => sanitizeOptions({ types: ["secret_table"] }), /unknown type/);
  assert.throws(() => sanitizeOptions({ types: ["--include-private"] }), /unknown type/);
  assert.throws(() => sanitizeOptions({ types: Array(8).fill("topic") }), /too many/);
  assert.deepEqual([...NODE_TYPES].sort(), [
    "action_item", "decision", "meeting", "person", "resource", "topic", "transcript_segment",
  ]);
});

test("projectItem returns a fixed projection and only shared wiki meeting keys", () => {
  const projected = projectItem(cliItem({ secret: "x", metadata: { token: "t" } }));
  assert.deepEqual(Object.keys(projected).sort(), [
    "citation", "content", "label", "meetingNodeId", "nodeType", "occurredAt", "privacy",
    "relations", "resourceRelation", "source", "url",
  ]);
  assert.equal(projected.meetingNodeId, "");
  assert.equal(projected.url, "");
  assert.equal(projected.source.meetingKey, sharedSource.meeting_key);
  assert.equal(projected.relations[0].relation, "decided_in");
  const privateItem = projectItem(cliItem({ privacy: "private", source: privateSource }));
  assert.equal(privateItem.source.meetingKey, "");
  const odd = projectItem(cliItem({ privacy: "unknown", source: { ...sharedSource, privacy: "maybe" } }));
  assert.equal(odd.privacy, "private");
  assert.equal(odd.source.privacy, "private");
  const traversal = projectItem(cliItem({ source: { ...sharedSource, meeting_key: "../private/x.md" } }));
  assert.equal(traversal.source.meetingKey, "");
});

test("searchMemory drops private items and relations unless private was requested", async () => {
  const stdout = JSON.stringify({
    count: 2,
    items: [
      cliItem({
        relations: [
          cliItem().relations[0],
          { relation: "mentioned_in", direction: "out", node_id: "m:p", node_type: "meeting", label: "Career chat", source: privateSource },
        ],
      }),
      cliItem({ label: "Private decision", privacy: "private", source: privateSource }),
    ],
  });
  const calls = [];
  const shared = await searchMemory("/py", "/c", "canary", {}, fakeExec({ stdout }, calls));
  assert.equal(calls[0].file, "/py");
  assert.equal(calls[0].args.includes("--include-private"), false);
  assert.equal(shared.count, 1);
  assert.deepEqual(shared.items[0].relations.map((relation) => relation.label), ["Platform sync"]);
  assert.doesNotMatch(JSON.stringify(shared), /Career chat|Private decision/);

  const both = await searchMemory("/py", "/c", "canary", { includePrivate: true }, fakeExec({ stdout }, []));
  assert.equal(both.count, 2);
});

test("searchMemory rejects CLI failures and malformed output without leaking details", async () => {
  await assert.rejects(
    searchMemory("/py", "/c", "canary", {}, fakeExec({ error: new Error("/Users/me/x"), stdout: '{"error":"invalid_memory_query","items":[]}' }, [])),
    /memory search failed/,
  );
  await assert.rejects(searchMemory("/py", "/c", "canary", {}, fakeExec({ stdout: "Traceback" }, [])), /invalid JSON/);
  await assert.rejects(searchMemory("/py", "/c", "canary", {}, fakeExec({ stdout: '{"items":"x"}' }, [])), /memory search failed/);
});

test("the wiki window registers memory:search and returns only a generic error on bad input", async () => {
  const handlers = new Map();
  const { registerHandlers } = require("../wiki-window");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mw-memory-"));
  registerHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    dataDir,
    python: "/nonexistent/python",
    configPath: path.join(dataDir, "config.toml"),
  });
  const handler = handlers.get("memory:search");
  assert.equal(typeof handler, "function");
  assert.deepEqual(await handler({}, "x", {}), { error: "This action is unavailable." });
  assert.deepEqual(await handler({}, "canary", { types: ["secret"] }), { error: "This action is unavailable." });
  assert.deepEqual(await handler({}, "canary", {}), { error: "This action is unavailable." });
});

test("the wiki preload exposes memory.search on the named channel only", () => {
  const invocations = [];
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    ipcRenderer: {
      invoke: (channel, ...args) => { invocations.push({ channel, args }); return Promise.resolve({}); },
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const preloadPath = require.resolve("../preload");
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(exposed.name, "meetingWiki");
  assert.deepEqual(Object.keys(exposed.api.memory), ["search", "addResource"]);
  exposed.api.memory.search("canary", { types: ["topic"], includePrivate: false });
  exposed.api.memory.addResource({ meetingNodeId: "meeting:0123456789abcdef" });
  assert.deepEqual(invocations, [
    { channel: "memory:search", args: ["canary", { types: ["topic"], includePrivate: false }] },
    { channel: "memory:addResource", args: [{ meetingNodeId: "meeting:0123456789abcdef" }] },
  ]);
  const source = fs.readFileSync(path.join(DESKTOP, "preload.js"), "utf8");
  assert.doesNotMatch(source, /ipcRenderer\.(send|on)\(|invoke\(\s*channel/);
});

test("the memory view defaults to shared only and renders with textContent", () => {
  const html = fs.readFileSync(path.join(DESKTOP, "renderer", "index.html"), "utf8");
  const start = html.indexOf('<section id="view-memory"');
  assert.ok(start >= 0, "index.html is missing the memory view");
  const view = html.slice(start, html.indexOf("</section>", start));
  assert.match(view, /<input id="memory-include-private" type="checkbox" \/>/);
  assert.doesNotMatch(view, /checked/);
  assert.match(view, /Showing shared memory only\./);
  const types = [...view.matchAll(/name="memory-type" value="([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(types, [...NODE_TYPES].sort());
  const js = fs.readFileSync(path.join(DESKTOP, "renderer", "app.js"), "utf8");
  assert.match(js, /api\.memory\.search\(query, \{ types, limit: 20, includePrivate \}\)/);
  assert.match(js, /checked === true/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test("projectItem projects the shared citation shape and nothing else from it", () => {
  const projected = projectItem(cliItem({ citation: { ...citationFor(sharedSource), secret: "x" } }));
  assert.deepEqual(projected.citation, {
    meetingTitle: "Platform sync",
    occurredAt: "2026-09-04T15:00:00+00:00",
    privacy: "shared",
    sourcePath: "wiki/meetings/2026-09-04-platform-sync.md",
    anchor: null,
  });
  assert.deepEqual(projected.relations[0].citation, projected.citation);
});

test("a transcript line citation keeps only bounded anchor times", () => {
  const anchor = { kind: "transcript_segment", start_seconds: 65, end_seconds: 71.5, index: 0 };
  const projected = projectItem(cliItem({ node_type: "transcript_segment", citation: citationFor(sharedSource, anchor) }));
  assert.deepEqual(projected.citation.anchor, { startSeconds: 65, endSeconds: 71.5 });
  for (const bad of [
    { kind: "transcript_segment", start_seconds: "65", end_seconds: 1 },
    { kind: "transcript_segment", start_seconds: -1, end_seconds: 1 },
    { kind: "transcript_segment", start_seconds: 1e12, end_seconds: 1 },
    { kind: "transcript_segment", start_seconds: NaN, end_seconds: 1 },
    { kind: "other", start_seconds: 1, end_seconds: 2 },
    "65",
  ]) {
    const item = projectItem(cliItem({ citation: citationFor(sharedSource, bad) }));
    assert.equal(item.citation.anchor, null, JSON.stringify(bad));
  }
});

test("a citation never opens anything but a shared wiki meeting page", () => {
  const cases = [
    citationFor(privateSource),
    { ...citationFor(sharedSource), source_path: "../private/x.md" },
    { ...citationFor(sharedSource), source_path: "wiki/meetings/../../private/x.md" },
    { ...citationFor(sharedSource), source_path: "wiki/people/alex.md" },
    { ...citationFor(sharedSource), privacy: "maybe" },
  ];
  for (const citation of cases) {
    assert.equal(projectItem(cliItem({ citation })).citation.sourcePath, "", JSON.stringify(citation));
  }
  assert.equal(projectItem(cliItem({ citation: null })).citation, null);
  assert.equal(projectItem(cliItem({ citation: "text" })).citation, null);
  assert.equal(projectItem(cliItem({ citation: { version: 2 } })).citation, null);
});

test("a shared-only request drops an item or relation whose citation is private", async () => {
  const stdout = JSON.stringify({
    items: [
      cliItem({ label: "Leaky", source: sharedSource, citation: citationFor(privateSource) }),
      cliItem({
        label: "Fine",
        relations: [
          { relation: "mentioned_in", direction: "out", node_id: "m:p", node_type: "meeting", label: "Career chat", source: sharedSource, citation: citationFor(privateSource) },
          cliItem().relations[0],
        ],
      }),
    ],
  });
  const calls = [];
  const result = await searchMemory("/py", "/c", "canary", {}, fakeExec({ stdout }, calls));
  assert.deepEqual(result.items.map((item) => item.label), ["Fine"]);
  assert.equal(result.items[0].relations.length, 1);
  assert.equal(result.items[0].relations[0].citation.privacy, "shared");
});

