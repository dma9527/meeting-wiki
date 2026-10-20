"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  DISPLAY_PATH,
  TEMPLATE_PATH,
  installClaudeSkill,
  presentSkillInstall,
  readTemplate,
  skillInstallDialogOptions,
  skillInstallMessage,
} = require("../skill-installer");

const DESKTOP = path.join(__dirname, "..");
const mode = (target) => fs.statSync(target).mode & 0o777;

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mw-skill-"));
}

function target(homeDir) {
  return path.join(homeDir, ".claude", "skills", "meeting-wiki-memory", "SKILL.md");
}

test("installs the bundled template with 0700 directories and a 0600 file", () => {
  const homeDir = home();
  assert.deepEqual(installClaudeSkill({ homeDir }), { status: "installed" });
  const file = target(homeDir);
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(TEMPLATE_PATH));
  assert.equal(mode(file), 0o600);
  for (const dir of [".claude", ".claude/skills", ".claude/skills/meeting-wiki-memory"]) {
    assert.equal(mode(path.join(homeDir, dir)), 0o700, dir);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["SKILL.md"]);
});

test("an identical existing file is reported as already installed", () => {
  const homeDir = home();
  installClaudeSkill({ homeDir });
  assert.deepEqual(installClaudeSkill({ homeDir }), { status: "already_installed" });
});

test("a different user file is never overwritten", () => {
  const homeDir = home();
  const file = target(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, "my own notes\n", { mode: 0o644 });
  assert.deepEqual(installClaudeSkill({ homeDir }), { status: "conflict" });
  assert.equal(fs.readFileSync(file, "utf8"), "my own notes\n");
  assert.equal(mode(file), 0o644);
  assert.equal(mode(path.dirname(file)), 0o755, "existing user directories keep their mode");
});

test("symlinked skill folders or files are refused without writing through them", () => {
  const homeDir = home();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mw-elsewhere-"));
  const skillsDir = path.join(homeDir, ".claude", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(skillsDir, "meeting-wiki-memory"));
  assert.deepEqual(installClaudeSkill({ homeDir }), { status: "unsafe_path" });
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  const homeTwo = home();
  const victim = path.join(elsewhere, "victim.md");
  fs.writeFileSync(victim, "keep\n");
  fs.mkdirSync(path.dirname(target(homeTwo)), { recursive: true });
  fs.symlinkSync(victim, target(homeTwo));
  assert.deepEqual(installClaudeSkill({ homeDir: homeTwo }), { status: "unsafe_path" });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");

  const homeThree = home();
  fs.mkdirSync(target(homeThree), { recursive: true });
  assert.deepEqual(installClaudeSkill({ homeDir: homeThree }), { status: "unsafe_path" });
});

test("a malformed or missing template reports an error and writes nothing", () => {
  const homeDir = home();
  const bogus = path.join(home(), "SKILL.md");
  fs.writeFileSync(bogus, "not a skill");
  assert.deepEqual(installClaudeSkill({ homeDir, templatePath: bogus }), { status: "error" });
  assert.deepEqual(installClaudeSkill({ homeDir, templatePath: path.join(homeDir, "missing.md") }), { status: "error" });
  assert.equal(fs.existsSync(target(homeDir)), false);
});

test("notification messages are fixed and contain no user data", () => {
  for (const status of ["installed", "already_installed", "conflict", "unsafe_path", "error", "weird", "constructor"]) {
    const message = skillInstallMessage({ status });
    assert.equal(typeof message.title, "string");
    assert.equal(typeof message.body, "string");
    assert.doesNotMatch(`${message.title} ${message.body}`, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(skillInstallMessage({ status: "installed" }).body, new RegExp(DISPLAY_PATH.replace(/[.]/g, "\\.")));
  assert.equal(skillInstallMessage(null).title, "Claude skill not installed");
});

test("the template is portable SKILL.md with no user data or direct-write guidance", () => {
  const text = readTemplate().toString("utf8");
  const [, frontmatter] = text.split("---\n");
  assert.match(frontmatter, /^name: meeting-wiki-memory$/m);
  assert.match(frontmatter, /^description: .{40,1024}$/m);
  assert.doesNotMatch(text, /\/Users\/|\/home\/|@[a-z0-9-]+\.(com|dev)|[0-9]{12}|AKIA|token=/i);
  assert.match(text, /meeting_wiki_memory_search/);
  assert.match(text, /reindex-memory/);
  assert.match(text, /--include-private/);
  assert.match(text, /Never open, edit, copy, or delete files/);
});

test("the installer uses fs only and main wires a discoverable menu item to a result dialog", () => {
  const code = fs.readFileSync(path.join(DESKTOP, "skill-installer.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /child_process|execFile|spawn\(|\bshell\b|require\("electron"\)/);
  const main = fs.readFileSync(path.join(DESKTOP, "main.js"), "utf8");
  assert.match(main, /const INSTALL_SKILL_LABEL = "Install Claude skill for meeting memory\.\.\.";/);
  assert.match(main, /\{ label: INSTALL_SKILL_LABEL, toolTip: INSTALL_SKILL_TOOLTIP, click: \(\) => \{ void installSkillFromMenu\(\); \} \}/);
  const menu = main.slice(main.indexOf("function updateMenu"));
  const wikiAt = menu.indexOf('label: "Open Wiki & Corrections"');
  const skillAt = menu.indexOf("label: INSTALL_SKILL_LABEL");
  const quitAt = menu.indexOf('label: "Quit"');
  assert.ok(wikiAt > 0 && skillAt > wikiAt && skillAt < menu.indexOf('label: "Settings..."') && skillAt < quitAt);
  const body = main.slice(main.indexOf("function installSkillFromMenu") - 40, main.indexOf("function askTitle"));
  assert.match(body, /presentSkillInstall\(\{/);
  assert.match(body, /install: installClaudeSkill/);
  assert.match(body, /showDialog: \(options\) => dialog\.showMessageBox\(options\)/);
  assert.match(body, /app\.focus\(\{ steal: true \}\)/);
  assert.doesNotMatch(body, /exec|spawn|shell/);
});

const STATUSES = ["installed", "already_installed", "conflict", "unsafe_path", "error"];

test("dialog options are fixed per status with an appropriate type and no user data", () => {
  const types = { installed: "info", already_installed: "info", conflict: "warning", unsafe_path: "warning", error: "error" };
  const titles = new Set();
  for (const status of STATUSES) {
    const options = skillInstallDialogOptions({ status, path: os.homedir(), detail: "secret" });
    const message = skillInstallMessage({ status });
    assert.deepEqual(options, {
      type: types[status],
      title: "Meeting Wiki",
      message: message.title,
      detail: message.body,
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
    });
    assert.doesNotMatch(JSON.stringify(options), /secret|\/Users\/|\/home\//);
    titles.add(`${message.title}|${message.body}`);
  }
  assert.equal(titles.size, STATUSES.length, "each status has a distinct message");
  assert.deepEqual(skillInstallDialogOptions({ status: "constructor" }), skillInstallDialogOptions({ status: "error" }));
});

test("presentSkillInstall shows a dialog for every status without notifying", async () => {
  for (const status of STATUSES) {
    const shown = [];
    const notified = [];
    let focused = 0;
    const via = await presentSkillInstall({
      install: () => ({ status }),
      focus: () => { focused += 1; },
      showDialog: async (options) => { shown.push(options); return { response: 0 }; },
      notify: (...args) => notified.push(args),
    });
    assert.equal(via, "dialog");
    assert.equal(focused, 1);
    assert.deepEqual(shown, [skillInstallDialogOptions({ status })]);
    assert.deepEqual(notified, []);
  }
});

test("presentSkillInstall reports a throwing installer as an error dialog", async () => {
  const shown = [];
  await presentSkillInstall({
    install: () => { throw new Error(`boom ${os.homedir()}`); },
    showDialog: async (options) => { shown.push(options); },
  });
  assert.deepEqual(shown, [skillInstallDialogOptions({ status: "error" })]);
});

test("presentSkillInstall falls back to a fixed notification only if the dialog fails", async () => {
  const notified = [];
  const via = await presentSkillInstall({
    install: () => ({ status: "conflict" }),
    focus: () => { throw new Error("no focus"); },
    showDialog: async () => { throw new Error("no dialog"); },
    notify: (...args) => notified.push(args),
  });
  const message = skillInstallMessage({ status: "conflict" });
  assert.equal(via, "notification");
  assert.deepEqual(notified, [[message.title, message.body]]);
});

test("presentSkillInstall never overwrites an existing user file", async () => {
  const homeDir = home();
  const file = target(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "mine\n");
  const shown = [];
  await presentSkillInstall({
    install: () => installClaudeSkill({ homeDir }),
    showDialog: async (options) => { shown.push(options); },
  });
  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
  assert.equal(shown[0].message, skillInstallMessage({ status: "conflict" }).title);
});

test("electron-builder ships the installer and only the skill template", () => {
  const pkg = require("../package.json");
  assert.ok(pkg.build.files.includes("skill-installer.js"));
  assert.ok(pkg.build.files.includes("skills/meeting-wiki-memory/SKILL.md"));
  assert.equal(pkg.build.files.some((entry) => entry.startsWith("skills/") && entry.includes("*")), false);
  assert.deepEqual(fs.readdirSync(path.join(DESKTOP, "skills")), ["meeting-wiki-memory"]);
  assert.deepEqual(fs.readdirSync(path.join(DESKTOP, "skills", "meeting-wiki-memory")), ["SKILL.md"]);
});
