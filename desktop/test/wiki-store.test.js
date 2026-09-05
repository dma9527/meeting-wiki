"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WikiStore, assertSafeRelativePath } = require("../wiki-store");

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-store-"));
  const wiki = path.join(dataDir, "wiki");
  const write = (relativeKey, content) => {
    const full = path.join(wiki, relativeKey);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write(
    "meetings/2026-09-04-rollout.md",
    '---\ntitle: "Rollout sync"\ntimestamp: "2026-09-04T15:00:00Z"\nmeeting_type: "generic"\nprivacy: "shared"\n---\n# Rollout sync\n\nWe discussed the migration rollout.\n',
  );
  write(
    "meetings/2026-09-05-planning.md",
    '---\ntitle: "Planning"\ntimestamp: "2026-09-05T15:00:00Z"\nprivacy: "shared"\n---\n# Planning\n\nRoadmap and migration timeline.\n',
  );
  write(
    "meetings/leaked.md",
    '---\ntitle: "Should never surface"\nprivacy: "private"\ntype: "private-meeting"\n---\n# Secret migration\n',
  );
  write(
    "action-items/active.md",
    "# Action Items\n\n| Owner | Action | Source | Due | Status |\n|---|---|---|---|---|\n" +
      "| Sam | Finish migration | [[meetings/x]] | | open |\n" +
      "| Alex | Old task | [[meetings/y]] | | done |\n",
  );
  return { dataDir, wiki, write };
}

test("path validation rejects traversal, absolute, null byte, and private segments", () => {
  for (const bad of [
    "../secret.md",
    "meetings/../../private/secret.md",
    "/etc/passwd",
    "private/notes.md",
    "wiki/private/notes.md",
    "meetings/a\u0000.md",
    "",
  ]) {
    assert.throws(() => assertSafeRelativePath(bad), /escapes|relative|null byte|non-empty|file/);
  }
});

test("path validation accepts wiki-relative keys with or without the wiki/ prefix", () => {
  assert.equal(assertSafeRelativePath("meetings/x.md"), "meetings/x.md");
  assert.equal(assertSafeRelativePath("wiki/meetings/x.md"), "meetings/x.md");
});

test("path validation rejects a private segment regardless of case", () => {
  for (const bad of ["Private/notes.md", "wiki/Private/notes.md", "meetings/PRIVATE/x.md"]) {
    assert.throws(() => assertSafeRelativePath(bad), /escapes/);
  }
});

test("readText and readPage refuse a page marked private in frontmatter", () => {
  const { dataDir } = fixture();
  const store = new WikiStore(dataDir);
  assert.equal(store.readText("meetings/leaked.md"), null);
  assert.equal(store.readPage("meetings/leaked.md").error, "page_not_found");
});

test("readText reads shared pages and returns null for missing files", () => {
  const { dataDir } = fixture();
  const store = new WikiStore(dataDir);
  assert.match(store.readText("meetings/2026-09-04-rollout.md"), /Rollout sync/);
  assert.match(store.readText("wiki/meetings/2026-09-04-rollout.md"), /Rollout sync/);
  assert.equal(store.readText("meetings/missing.md"), null);
});

test("readText rejects traversal and absolute paths before touching disk", () => {
  const { dataDir } = fixture();
  const store = new WikiStore(dataDir);
  assert.throws(() => store.readText("../private/secret.md"), /escapes/);
  assert.throws(() => store.readText("/etc/passwd"), /relative/);
  assert.throws(() => store.readText("private/x.md"), /escapes/);
});

test("readText rejects a symlinked file that escapes the wiki root", () => {
  const { dataDir, wiki } = fixture();
  const secret = path.join(dataDir, "private", "secret.md");
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, "top secret transcript");
  fs.symlinkSync(secret, path.join(wiki, "leak.md"));
  const store = new WikiStore(dataDir);
  assert.throws(() => store.readText("leak.md"), /escapes/);
});

test("readText rejects reads through a symlinked directory that escapes the root", () => {
  const { dataDir, wiki } = fixture();
  const outside = path.join(dataDir, "private");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.md"), "top secret transcript");
  fs.symlinkSync(outside, path.join(wiki, "leakdir"));
  const store = new WikiStore(dataDir);
  assert.throws(() => store.readText("leakdir/secret.md"), /escapes/);
  // Listing never follows the symlinked directory either.
  assert.ok(!store.listMarkdown().some((key) => key.startsWith("leakdir/")));
});

test("search excludes private pages and ranks by term matches", () => {
  const { dataDir } = fixture();
  const store = new WikiStore(dataDir);
  const result = store.search("migration");
  const paths = result.items.map((item) => item.path);
  assert.ok(paths.includes("meetings/2026-09-04-rollout.md"));
  assert.ok(paths.includes("meetings/2026-09-05-planning.md"));
  assert.ok(!paths.includes("meetings/leaked.md"));
  assert.ok(result.items.every((item) => item.snippets.length > 0));
});

test("listRecent sorts by timestamp descending and excludes private meetings", () => {
  const { dataDir } = fixture();
  const store = new WikiStore(dataDir);
  const result = store.listRecent();
  assert.deepEqual(
    result.items.map((item) => item.path),
    ["meetings/2026-09-05-planning.md", "meetings/2026-09-04-rollout.md"],
  );
  assert.ok(!result.items.some((item) => item.title === "Should never surface"));
});

test("actionItems returns open rows and drops the header and done rows", () => {
  const { dataDir } = fixture();
  const store = new WikiStore(dataDir);
  const result = store.actionItems();
  assert.equal(result.items.length, 1);
  assert.match(result.items[0], /Finish migration/);
  assert.equal(
    result.items.some((row) => row.toLowerCase().includes("| done |")),
    false,
  );
});

test("actionItems reads only the open active page, never the completed archive", () => {
  const { dataDir, write } = fixture();
  write(
    "action-items/active.md",
    "# Action Items\n\n| Owner | Action | Source | Due | Status |\n|---|---|---|---|---|\n" +
      "| Sam | Finish migration | [[meetings/x]] | | open |\n",
  );
  write(
    "action-items/archive.md",
    "# Completed Action Items\n\n| Owner | Action | Source | Due | Status |\n|---|---|---|---|---|\n" +
      "| Alex | Archived task | [[meetings/y]] | | done |\n",
  );
  const store = new WikiStore(dataDir);
  const result = store.actionItems();
  assert.equal(result.items.length, 1);
  assert.match(result.items[0], /Finish migration/);
  assert.ok(!result.items.some((row) => /Archived task/.test(row)));
});

test("readPage returns content or a not-found marker", () => {
  const { dataDir } = fixture();
  const store = new WikiStore(dataDir);
  const page = store.readPage("meetings/2026-09-04-rollout.md");
  assert.equal(page.path, "meetings/2026-09-04-rollout.md");
  assert.match(page.content, /Rollout sync/);
  assert.equal(store.readPage("meetings/missing.md").error, "page_not_found");
});

test("readText treats a file used as a directory as not found without leaking a path", () => {
  const { dataDir } = fixture();
  const store = new WikiStore(dataDir);
  // The rollout page is a file; requesting a child path triggers ENOTDIR, which
  // must not surface as a raw fs error carrying the absolute wiki path.
  assert.equal(store.readText("meetings/2026-09-04-rollout.md/child.md"), null);
  assert.equal(store.readPage("meetings/2026-09-04-rollout.md/child.md").error, "page_not_found");
});

test("readText never leaks a filesystem path in an unexpected error", () => {
  const { dataDir } = fixture();
  const abs = path.join(dataDir, "wiki", "meetings", "x.md");
  const denied = Object.assign(new Error(`EACCES: permission denied, open '${abs}'`), {
    code: "EACCES",
  });
  const fakeFs = {
    realpathSync: (target) => target,
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => {
      throw denied;
    },
  };
  const store = new WikiStore(dataDir, { fs: fakeFs });
  assert.throws(
    () => store.readText("meetings/x.md"),
    (error) => error.message === "unable to read wiki page" && !error.message.includes(dataDir),
  );
});
