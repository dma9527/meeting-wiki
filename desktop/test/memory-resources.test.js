"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  RESOURCE_RELATIONS,
  addResource,
  addResourceArgs,
  projectItem,
  searchMemory,
  validateResourceInput,
} = require("../memory-client");

const DESKTOP = path.join(__dirname, "..");
const MEETING = "meeting:0123456789abcdef";

function fakeExec(response, calls) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    process.nextTick(() => callback(response.error || null, response.stdout || "", ""));
  };
}

const validInput = (overrides = {}) => ({
  meetingNodeId: MEETING,
  url: "https://docs.example.com/spec",
  title: "Rollout spec",
  summary: "Canary plan\nwith steps",
  relation: "design_doc",
  ...overrides,
});

test("addResourceArgs passes every value as --flag=value and never opts in to private or loopback", () => {
  const { value } = validateResourceInput(validInput({ title: "--allow-private" }));
  const args = addResourceArgs("/c", value);
  assert.deepEqual(args, [
    "-m", "meeting_wiki.cli", "--config", "/c", "memory-add-resource",
    `--meeting=${MEETING}`, "--url=https://docs.example.com/spec", "--title=--allow-private",
    "--summary=Canary plan\nwith steps", "--relation=design_doc",
  ]);
  assert.equal(args.includes("--allow-private"), false);
  assert.equal(args.some((arg) => arg.startsWith("--allow-loopback")), false);
});

test("validateResourceInput refuses unsafe input before any process starts", () => {
  const cases = [
    [null, "meeting_unavailable"],
    [validInput({ meetingNodeId: "person:0123456789abcdef" }), "meeting_unavailable"],
    [validInput({ meetingNodeId: "meeting:../../x" }), "meeting_unavailable"],
    [validInput({ url: "" }), "invalid_url"],
    [validInput({ url: "https://exa mple.com" }), "invalid_url"],
    [validInput({ url: "https://exämple.com" }), "invalid_url"],
    [validInput({ url: "http://docs.example.com" }), "https_required"],
    [validInput({ url: "http://localhost:3000" }), "https_required"],
    [validInput({ url: "javascript:alert(1)" }), "https_required"],
    [validInput({ url: "https://docs.example.com/#x" }), "fragment_not_allowed"],
    [validInput({ url: "https://user:pw@docs.example.com/" }), "credentials_not_allowed"],
    [validInput({ title: "" }), "invalid_title"],
    [validInput({ title: "two\nlines" }), "invalid_title"],
    [validInput({ title: "x".repeat(201) }), "invalid_title"],
    [validInput({ summary: "bell\u0007" }), "invalid_summary"],
    [validInput({ summary: 5 }), "invalid_summary"],
    [validInput({ relation: "owns" }), "invalid_relation"],
  ];
  for (const [input, code] of cases) {
    assert.equal(validateResourceInput(input).error, code, JSON.stringify(input));
  }
  assert.deepEqual([...RESOURCE_RELATIONS].sort(), [
    "code_review", "design_doc", "follow_up", "notes", "reference", "ticket",
  ]);
});

test("addResource maps CLI error codes to fixed messages and never echoes CLI text", async () => {
  const calls = [];
  const refused = await addResource("/py", "/c", validInput({ url: "http://x.example" }), fakeExec({}, calls));
  assert.equal(calls.length, 0);
  assert.equal(refused.error, "Use an https URL.");

  const privateHost = await addResource(
    "/py", "/c", validInput(),
    fakeExec({ error: new Error("exit 1"), stdout: '{"error":"private_or_reserved_host"}' }, calls),
  );
  assert.equal(privateHost.error, "Private, local, and reserved network addresses are not allowed.");
  for (const stdout of ['{"error":"/Users/someone/secret"}', '{"error":"constructor"}', "Traceback", ""]) {
    const result = await addResource("/py", "/c", validInput(), fakeExec({ error: new Error("x"), stdout }, []));
    assert.deepEqual(result, { error: "The resource could not be saved." });
  }
});

test("addResource returns only the saved title and relation", async () => {
  const stdout = JSON.stringify({
    added: true,
    resource: { title: "Rollout spec", relation: "design_doc", url: "https://docs.example.com/spec", privacy: "shared", meeting_node_id: MEETING },
  });
  const calls = [];
  const result = await addResource("/py", "/c", validInput(), fakeExec({ stdout }, calls));
  assert.deepEqual(result, { added: true, resource: { title: "Rollout spec", relation: "design_doc" } });
  assert.equal(calls[0].file, "/py");
  assert.equal(calls[0].args[4], "memory-add-resource");
});

test("projectItem exposes a meeting node id only for shared meetings and a URL only for resources", () => {
  const meeting = { node_id: MEETING, node_type: "meeting", label: "Platform sync", privacy: "shared", content: "", relations: [] };
  assert.equal(projectItem(meeting).meetingNodeId, MEETING);
  assert.equal(projectItem({ ...meeting, privacy: "private" }).meetingNodeId, "");
  assert.equal(projectItem({ ...meeting, node_id: "meeting:zz" }).meetingNodeId, "");
  assert.equal(projectItem({ ...meeting, node_type: "topic" }).meetingNodeId, "");
  assert.equal(projectItem({ ...meeting, metadata: { url: "https://x.example/" } }).url, "");

  const resource = {
    node_id: "resource:0123456789abcdef", node_type: "resource", label: "Spec", privacy: "shared",
    content: "Plan\nhttps://docs.example.com/spec",
    metadata: { url: "https://docs.example.com/spec", relation: "design_doc" }, relations: [],
  };
  const projected = projectItem(resource);
  assert.equal(projected.url, "https://docs.example.com/spec");
  assert.equal(projected.resourceRelation, "design_doc");
  assert.equal(projected.meetingNodeId, "");
  assert.equal(projectItem({ ...resource, metadata: { url: "javascript:alert(1)", relation: "x" } }).url, "");
  assert.equal(projectItem({ ...resource, metadata: { url: "javascript:alert(1)", relation: "x" } }).resourceRelation, "");
});

test("shared memory search drops private resources", async () => {
  const stdout = JSON.stringify({
    items: [
      { node_id: "resource:a", node_type: "resource", label: "Shared spec", privacy: "shared", content: "", metadata: { url: "https://a.example/" }, relations: [] },
      { node_id: "resource:b", node_type: "resource", label: "Career ladder", privacy: "private", content: "", metadata: { url: "https://b.example/" }, relations: [] },
    ],
  });
  const shared = await searchMemory("/py", "/c", "spec", {}, fakeExec({ stdout }, []));
  assert.deepEqual(shared.items.map((item) => item.label), ["Shared spec"]);
  assert.doesNotMatch(JSON.stringify(shared), /Career ladder|b\.example/);
});

test("the wiki window registers memory:addResource behind the generic guard", async () => {
  const handlers = new Map();
  const { registerHandlers } = require("../wiki-window");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mw-resource-"));
  registerHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    dataDir,
    python: "/nonexistent/python",
    configPath: path.join(dataDir, "config.toml"),
  });
  const handler = handlers.get("memory:addResource");
  assert.equal(typeof handler, "function");
  assert.deepEqual(await handler({}, validInput({ url: "http://x.example" })), { error: "Use an https URL." });
  const result = await handler({}, validInput());
  assert.ok(result && typeof result.error === "string");
  assert.doesNotMatch(result.error, /nonexistent|config\.toml/);
});

test("the renderer offers Add resource only on shared meetings and renders links as text", () => {
  const html = fs.readFileSync(path.join(DESKTOP, "renderer", "index.html"), "utf8");
  assert.equal((html.match(/id="view-memory"/g) || []).length, 1);
  assert.equal((html.match(/data-view="memory"/g) || []).length, 1);
  assert.match(html, /name="memory-type" value="resource"/);
  const js = fs.readFileSync(path.join(DESKTOP, "renderer", "app.js"), "utf8");
  assert.match(js, /item\.nodeType === "meeting" && item\.privacy === "shared" && item\.meetingNodeId/);
  assert.match(js, /api\.memory\.addResource\(\{/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|window\.open|location\.href|<a /);
  assert.doesNotMatch(js, /includePrivate:\s*true|allowPrivate|allow-private/);
});
