"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cli = require("../cli-installer");

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wiki-cli-"));
}

const binDir = (dir) => path.join(dir, ".local", "bin");

test("installs both shims owner-only into ~/.local/bin and is idempotent", () => {
  const dir = home();
  const result = cli.installCommandShims({ homeDir: dir });
  assert.equal(result.status, "installed");
  assert.deepEqual(result.files, { "meeting-wiki": "installed", "meeting-wiki-mcp": "installed" });
  for (const name of cli.SHIM_NAMES) {
    const target = path.join(binDir(dir), name);
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(target, "utf8"), cli.shimContent(name));
  }
  assert.equal(fs.statSync(binDir(dir)).mode & 0o777, 0o700);
  assert.equal(cli.installCommandShims({ homeDir: dir }).status, "already_installed");
});

test("existing custom files and links are never overwritten", () => {
  const dir = home();
  fs.mkdirSync(binDir(dir), { recursive: true });
  fs.writeFileSync(path.join(binDir(dir), "meeting-wiki"), "#!/bin/sh\necho mine\n");
  fs.symlinkSync("/bin/echo", path.join(binDir(dir), "meeting-wiki-mcp"));
  const result = cli.installCommandShims({ homeDir: dir });
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.files, { "meeting-wiki": "conflict", "meeting-wiki-mcp": "unsafe_path" });
  assert.equal(fs.readFileSync(path.join(binDir(dir), "meeting-wiki"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal(fs.lstatSync(path.join(binDir(dir), "meeting-wiki-mcp")).isSymbolicLink(), true);
});

test("a bin folder that is a file is refused", () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, ".local"));
  fs.writeFileSync(binDir(dir), "not a folder");
  assert.equal(cli.installCommandShims({ homeDir: dir }).status, "unsafe_path");
});

test("shims resolve only the fixed app locations and pass arguments through", () => {
  for (const name of cli.SHIM_NAMES) {
    const content = cli.shimContent(name);
    assert.match(content, /^#!\/bin\/sh\n/);
    assert.match(content, /"\/Applications\/Meeting Wiki\.app"/);
    assert.match(content, /\$\{HOME:-\}\/Applications\/Meeting Wiki\.app/);
    assert.match(content, /Contents\/Resources\/runtime\/bin\/python/);
    assert.match(content, /exec "\$python" -I -m meeting_wiki\.(cli|mcp_server) "\$@"/);
    assert.doesNotMatch(content, /PATH=|which |command -v|mdfind|eval|\$\(/);
  }
  assert.match(cli.shimContent("meeting-wiki"), /-m meeting_wiki\.cli/);
  assert.match(cli.shimContent("meeting-wiki-mcp"), /-m meeting_wiki\.mcp_server/);
  assert.throws(() => cli.shimContent("other"));
});

test("a shim reports a missing app instead of running anything else", () => {
  const dir = home();
  cli.installCommandShims({ homeDir: dir });
  const target = path.join(binDir(dir), "meeting-wiki");
  let failure;
  try {
    execFileSync("/bin/sh", [target, "--help"], { env: { HOME: dir, PATH: "/usr/bin:/bin" }, stdio: "pipe" });
  } catch (error) {
    failure = error;
  }
  if (fs.existsSync("/Applications/Meeting Wiki.app")) return; // Covered on a clean Mac only.
  assert.ok(failure, "the shim must fail when the app is absent");
  assert.equal(failure.status, 127);
  assert.match(String(failure.stderr), /Meeting Wiki\.app was not found/);
});

test("the confirmation and result dialogs use fixed text with PATH guidance", async () => {
  const shown = [];
  let installs = 0;
  await cli.presentShimInstall({
    install: () => { installs += 1; return { status: "installed", files: {} }; },
    focus: () => {},
    showDialog: async (options) => { shown.push(options); return { response: 0 }; },
  });
  assert.equal(installs, 1);
  assert.equal(shown[0], cli.CONFIRM_DIALOG);
  assert.match(cli.CONFIRM_DIALOG.detail, /~\/\.local\/bin/);
  assert.match(cli.CONFIRM_DIALOG.detail, /never replaces/);
  assert.equal(cli.CONFIRM_DIALOG.cancelId, 1);
  assert.match(shown[1].detail, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);

  const cancelled = [];
  await cli.presentShimInstall({
    install: () => { throw new Error("must not install"); },
    focus: () => {},
    showDialog: async (options) => { cancelled.push(options); return { response: 1 }; },
  });
  assert.equal(cancelled.length, 1);
  for (const message of Object.values(cli.RESULT_MESSAGES)) {
    assert.doesNotMatch(message.detail, /\/Users\//);
  }
});

test("main exposes the installer only as a user-triggered menu item", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /label: "Install command-line tools\.\.\.", click: \(\) => \{ void installShimsFromMenu\(\); \}/);
  assert.match(main, /presentShimInstall\(\{/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("cli-installer.js"));
});
