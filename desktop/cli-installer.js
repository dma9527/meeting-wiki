"use strict";

// Installs two fixed command shims, meeting-wiki and meeting-wiki-mcp, into ~/.local/bin using
// only fs calls (no shell). Each shim finds the app at a fixed location on every run, so it keeps
// working after the app is replaced at /Applications. Created folders are 0700 and shims are 0700.
// An existing file is never replaced: identical content is reported as already installed, and
// anything else is left untouched.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SHIM_NAMES = Object.freeze(["meeting-wiki", "meeting-wiki-mcp"]);
const MODULES = Object.freeze({ "meeting-wiki": "meeting_wiki.cli", "meeting-wiki-mcp": "meeting_wiki.mcp_server" });
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

// Fixed text only. -I ignores PYTHON* variables and the current folder, so nothing outside
// the app bundle is imported. No PATH lookup is used to find the app.
function shimContent(name) {
  const moduleName = MODULES[name];
  if (!moduleName) throw new Error(`unknown shim: ${name}`);
  return [
    "#!/bin/sh",
    "# Meeting Wiki command shim, installed from the Meeting Wiki menu. Safe to delete.",
    "set -u",
    'for app in "/Applications/Meeting Wiki.app" "${HOME:-}/Applications/Meeting Wiki.app"; do',
    '  python="$app/Contents/Resources/runtime/bin/python"',
    '  if [ -d "$app" ] && [ -x "$python" ]; then',
    `    exec "$python" -I -m ${moduleName} "$@"`,
    "  fi",
    "done",
    `echo "${name}: Meeting Wiki.app was not found in /Applications or ~/Applications." >&2`,
    "exit 127",
    "",
  ].join("\n");
}

// Parents may be user-managed links to folders; a link to anything else is refused.
function ensureDirectory(fsImpl, dir) {
  let stat;
  try {
    stat = fsImpl.lstatSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fsImpl.mkdirSync(dir, { mode: 0o700 });
    fsImpl.chmodSync(dir, 0o700);
    return true;
  }
  if (stat.isSymbolicLink()) return fsImpl.statSync(dir).isDirectory();
  return stat.isDirectory();
}

function writeExclusive(fsImpl, target, content) {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fsImpl.constants;
  let fd;
  try {
    fd = fsImpl.openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o700);
  } catch (error) {
    if (error.code === "EEXIST") return "conflict";
    throw error;
  }
  try {
    fsImpl.fchmodSync(fd, 0o700);
    const buffer = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += fsImpl.writeSync(fd, buffer, offset, buffer.length - offset);
    fsImpl.fsyncSync(fd);
  } catch (error) {
    fsImpl.closeSync(fd);
    fd = undefined;
    try { fsImpl.unlinkSync(target); } catch (_) {}
    throw error;
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
  return "installed";
}

function installOne(fsImpl, dir, name) {
  const target = path.join(dir, name);
  const content = shimContent(name);
  let existing = null;
  try {
    existing = fsImpl.lstatSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.isFile()) return "unsafe_path";
    return fsImpl.readFileSync(target, "utf8") === content ? "already_installed" : "conflict";
  }
  return writeExclusive(fsImpl, target, content);
}

// A file left unchanged (different content or a link) is a conflict; unsafe_path is for the folder.
function overallStatus(files) {
  const values = Object.values(files);
  if (values.includes("error")) return "error";
  if (values.includes("conflict") || values.includes("unsafe_path")) return "conflict";
  return values.includes("installed") ? "installed" : "already_installed";
}

function installCommandShims({ fsImpl = fs, homeDir = os.homedir() } = {}) {
  try {
    const local = path.join(homeDir, ".local");
    const bin = path.join(local, "bin");
    if (!ensureDirectory(fsImpl, local) || !ensureDirectory(fsImpl, bin)) return { status: "unsafe_path", files: {} };
    const files = {};
    for (const name of SHIM_NAMES) {
      try {
        files[name] = installOne(fsImpl, bin, name);
      } catch (_) {
        files[name] = "error";
      }
    }
    return { status: overallStatus(files), files };
  } catch (_) {
    return { status: "error", files: {} };
  }
}

const PATH_HELP = `If your shell cannot find meeting-wiki, add this line to ~/.zshrc and open a new Terminal window:\n${PATH_LINE}`;
const CLI_NOTE = "The commands use the app in /Applications or ~/Applications, so they keep working after you update it. API keys stay with the app, so terminal commands that call your provider need the key in the environment.";

const CONFIRM_DIALOG = Object.freeze({
  type: "question",
  title: "Meeting Wiki",
  message: "Install command-line tools?",
  detail: `This adds meeting-wiki and meeting-wiki-mcp to ~/.local/bin, readable only by you. It never replaces a file that is already there. ${CLI_NOTE}`,
  buttons: ["Install", "Cancel"],
  defaultId: 0,
  cancelId: 1,
  noLink: true,
});

const RESULT_MESSAGES = Object.freeze({
  installed: { message: "Command-line tools installed", detail: `meeting-wiki and meeting-wiki-mcp are in ~/.local/bin.\n\n${PATH_HELP}` },
  already_installed: { message: "Command-line tools already installed", detail: `meeting-wiki and meeting-wiki-mcp in ~/.local/bin are up to date.\n\n${PATH_HELP}` },
  conflict: {
    message: "Some command-line tools were not installed",
    detail: `A file or link named meeting-wiki or meeting-wiki-mcp already exists in ~/.local/bin with different content. It was left unchanged. Rename or remove it, then try again.\n\n${PATH_HELP}`,
  },
  unsafe_path: {
    message: "Command-line tools not installed",
    detail: "~/.local or ~/.local/bin is not a folder. Nothing was changed.",
  },
  error: { message: "Command-line tools not installed", detail: "The tools could not be written. Nothing was replaced." },
});

function resultDialog(result) {
  const entry = RESULT_MESSAGES[result && result.status] || RESULT_MESSAGES.error;
  return { type: result && ["installed", "already_installed"].includes(result.status) ? "info" : "warning", title: "Meeting Wiki", message: entry.message, detail: entry.detail, buttons: ["OK"], noLink: true };
}

async function presentShimInstall({ install = installCommandShims, showDialog, focus, notify }) {
  if (focus) focus();
  const choice = await showDialog(CONFIRM_DIALOG);
  if (!choice || choice.response !== 0) return "cancelled";
  let result;
  try {
    result = install();
  } catch (_) {
    result = { status: "error" };
  }
  const options = resultDialog(result);
  try {
    await showDialog(options);
    return result.status;
  } catch (_) {
    if (notify) notify(options.message, options.detail);
    return result.status;
  }
}

module.exports = {
  CONFIRM_DIALOG,
  PATH_LINE,
  RESULT_MESSAGES,
  SHIM_NAMES,
  installCommandShims,
  presentShimInstall,
  resultDialog,
  shimContent,
};
