"use strict";

// Installs the bundled, data-free Claude skill template into
// ~/.claude/skills/meeting-wiki-memory/SKILL.md using only fs calls (no shell).
// Directories it creates are 0700 and the file is 0600. An existing file is
// never overwritten: identical content is reported as already installed, and
// anything else is left untouched and reported as a conflict.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SKILL_NAME = "meeting-wiki-memory";
const TEMPLATE_PATH = path.join(__dirname, "skills", SKILL_NAME, "SKILL.md");
const DISPLAY_PATH = `~/.claude/skills/${SKILL_NAME}/SKILL.md`;

const MESSAGES = Object.freeze({
  installed: { title: "Claude skill installed", body: `Installed ${DISPLAY_PATH}.` },
  already_installed: { title: "Claude skill already installed", body: `${DISPLAY_PATH} is up to date.` },
  conflict: {
    title: "Claude skill not installed",
    body: `${DISPLAY_PATH} already exists with different content. It was left unchanged.`,
  },
  unsafe_path: {
    title: "Claude skill not installed",
    body: `${DISPLAY_PATH} or its folder is a link or not a regular file. Nothing was changed.`,
  },
  error: { title: "Claude skill not installed", body: "The skill could not be written. Nothing was overwritten." },
});

function readTemplate(fsImpl = fs, templatePath = TEMPLATE_PATH) {
  const content = fsImpl.readFileSync(templatePath);
  if (!content.toString("utf8").startsWith(`---\nname: ${SKILL_NAME}\n`)) {
    throw new Error("bundled skill template is malformed");
  }
  return content;
}

// Parents may be user-managed links to directories; the skill folder may not.
function ensureDirectory(fsImpl, dir, { allowLink }) {
  let stat;
  try {
    stat = fsImpl.lstatSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fsImpl.mkdirSync(dir, { mode: 0o700 });
    fsImpl.chmodSync(dir, 0o700);
    return true;
  }
  if (stat.isSymbolicLink()) {
    if (!allowLink || !fsImpl.statSync(dir).isDirectory()) return false;
    return true;
  }
  return stat.isDirectory();
}

function installClaudeSkill({ fsImpl = fs, homeDir = os.homedir(), templatePath = TEMPLATE_PATH } = {}) {
  try {
    const template = readTemplate(fsImpl, templatePath);
    const claudeDir = path.join(homeDir, ".claude");
    const skillsDir = path.join(claudeDir, "skills");
    const skillDir = path.join(skillsDir, SKILL_NAME);
    const target = path.join(skillDir, "SKILL.md");
    if (!ensureDirectory(fsImpl, claudeDir, { allowLink: true })) return { status: "unsafe_path" };
    if (!ensureDirectory(fsImpl, skillsDir, { allowLink: true })) return { status: "unsafe_path" };
    if (!ensureDirectory(fsImpl, skillDir, { allowLink: false })) return { status: "unsafe_path" };

    let existing = null;
    try {
      existing = fsImpl.lstatSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing) {
      if (!existing.isFile()) return { status: "unsafe_path" };
      const current = fsImpl.readFileSync(target);
      return { status: Buffer.compare(current, template) === 0 ? "already_installed" : "conflict" };
    }

    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fsImpl.constants;
    let fd;
    try {
      fd = fsImpl.openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch (error) {
      // Created between the check and the open: never overwrite it.
      if (error.code === "EEXIST") return { status: "conflict" };
      throw error;
    }
    try {
      fsImpl.fchmodSync(fd, 0o600);
      let offset = 0;
      while (offset < template.length) {
        offset += fsImpl.writeSync(fd, template, offset, template.length - offset);
      }
      fsImpl.fsyncSync(fd);
    } catch (error) {
      fsImpl.closeSync(fd);
      fd = undefined;
      try {
        fsImpl.unlinkSync(target);
      } catch (_) {}
      throw error;
    } finally {
      if (fd !== undefined) fsImpl.closeSync(fd);
    }
    return { status: "installed" };
  } catch (_) {
    return { status: "error" };
  }
}

const DIALOG_TYPES = Object.freeze({
  installed: "info",
  already_installed: "info",
  conflict: "warning",
  unsafe_path: "warning",
  error: "error",
});

function knownStatus(result) {
  return result && Object.prototype.hasOwnProperty.call(MESSAGES, result.status) ? result.status : "error";
}

function skillInstallMessage(result) {
  return MESSAGES[knownStatus(result)];
}

function skillInstallDialogOptions(result) {
  const status = knownStatus(result);
  const { title, body } = MESSAGES[status];
  return {
    type: DIALOG_TYPES[status],
    title: "Meeting Wiki",
    message: title,
    detail: body,
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
  };
}

// Runs the install, then shows the fixed result in a dialog; notifies only if the dialog fails.
async function presentSkillInstall({ install = installClaudeSkill, showDialog, focus, notify }) {
  let result;
  try {
    result = install();
  } catch (_) {
    result = { status: "error" };
  }
  const options = skillInstallDialogOptions(result);
  try {
    if (focus) focus();
    await showDialog(options);
    return "dialog";
  } catch (_) {
    if (notify) notify(options.message, options.detail);
    return "notification";
  }
}

module.exports = {
  DISPLAY_PATH,
  SKILL_NAME,
  TEMPLATE_PATH,
  installClaudeSkill,
  presentSkillInstall,
  readTemplate,
  skillInstallDialogOptions,
  skillInstallMessage,
};
