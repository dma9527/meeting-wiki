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
  readTemplate,
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

test("the installer uses fs only and main wires the menu item to it", () => {
  const code = fs.readFileSync(path.join(DESKTOP, "skill-installer.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /child_process|execFile|spawn\(|\bshell\b|require\("electron"\)/);
  const main = fs.readFileSync(path.join(DESKTOP, "main.js"), "utf8");
  assert.match(main, /\{ label: "Install Claude skill\.\.\.", click: installSkillFromMenu \}/);
  const body = main.slice(main.indexOf("function installSkillFromMenu"), main.indexOf("function askTitle"));
  assert.match(body, /skillInstallMessage\(installClaudeSkill\(\)\)/);
  assert.match(body, /notify\(message\.title, message\.body\)/);
  assert.doesNotMatch(body, /exec|spawn|shell/);
});

test("electron-builder ships the installer and only the skill template", () => {
  const pkg = require("../package.json");
  assert.ok(pkg.build.files.includes("skill-installer.js"));
  assert.ok(pkg.build.files.includes("skills/meeting-wiki-memory/SKILL.md"));
  assert.equal(pkg.build.files.some((entry) => entry.startsWith("skills/") && entry.includes("*")), false);
  assert.deepEqual(fs.readdirSync(path.join(DESKTOP, "skills")), ["meeting-wiki-memory"]);
  assert.deepEqual(fs.readdirSync(path.join(DESKTOP, "skills", "meeting-wiki-memory")), ["SKILL.md"]);
});
