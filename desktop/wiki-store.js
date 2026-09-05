"use strict";

// Reads only data_dir/wiki. Canonical containment rejects private/, .., absolute
// paths, null bytes, and symlink escapes. No generic file read is ever exposed.

const nodeFs = require("fs");
const path = require("path");

function assertSafeRelativePath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (relPath.includes("\0")) throw new Error("path contains a null byte");
  const normalized = relPath.replace(/\\/g, "/");
  if (path.isAbsolute(relPath) || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("path must be relative to the wiki root");
  }
  const withoutPrefix = normalized.replace(/^wiki\//, "").replace(/^\.\//, "");
  const segments = withoutPrefix.split("/");
  if (segments.some((segment) => segment === ".." || segment.toLowerCase() === "private")) {
    throw new Error("path escapes the wiki root");
  }
  if (withoutPrefix.length === 0) throw new Error("path must name a file");
  return withoutPrefix;
}

function escapesRoot(realRoot, target) {
  const rel = path.relative(realRoot, target);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

// fs errors that mean "no readable file lives at this path". Treated as a miss
// so a raw error, whose message embeds the absolute path, never reaches callers.
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

class WikiStore {
  constructor(dataDir, options = {}) {
    this.fs = options.fs || nodeFs;
    this.root = path.join(dataDir, "wiki");
  }

  resolve(relPath) {
    const safe = assertSafeRelativePath(relPath);
    const candidate = path.resolve(this.root, safe);
    if (escapesRoot(this.root, candidate)) throw new Error("path escapes the wiki root");
    return candidate;
  }

  readText(relPath) {
    const candidate = this.resolve(relPath);
    try {
      const real = this.fs.realpathSync(candidate);
      const realRoot = this.fs.realpathSync(this.root);
      if (escapesRoot(realRoot, real)) throw new Error("path escapes the wiki root");
      const stat = this.fs.statSync(real);
      if (!stat.isFile()) return null;
      const content = this.fs.readFileSync(real, "utf8");
      // Defense in depth: never return a page that declares itself private, even
      // if it somehow lives outside the private/ tree or on a case-insensitive FS.
      if (WikiStore._isPrivate(WikiStore.parseFrontmatter(content))) return null;
      return content;
    } catch (error) {
      if (error && error.message === "path escapes the wiki root") throw error;
      // A path resolving to no readable file is simply "not found". Any other fs
      // error is re-thrown code-only: its native message embeds the absolute path.
      if (error && MISSING_CODES.has(error.code)) return null;
      throw new Error("unable to read wiki page");
    }
  }

  listMarkdown(subdir = "") {
    const base = subdir ? this.resolve(subdir) : this.root;
    const keys = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = this.fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        // Symlinks report neither isDirectory nor isFile, so they are skipped:
        // listing never follows a link out of the tree.
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const key = path.relative(this.root, full).split(path.sep).join("/");
          if (!key.split("/").some((segment) => segment.toLowerCase() === "private")) {
            keys.push(key);
          }
        }
      }
    };
    walk(base);
    keys.sort();
    return keys;
  }

  static parseFrontmatter(text) {
    const lines = text.split("\n");
    if (lines[0] !== "---") return {};
    const meta = {};
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index] === "---") break;
      const separator = lines[index].indexOf(":");
      if (separator > 0) {
        const key = lines[index].slice(0, separator).trim();
        let value = lines[index].slice(separator + 1).trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        meta[key] = value;
      }
    }
    return meta;
  }

  static _isPrivate(meta) {
    return meta.privacy === "private" || meta.type === "private-meeting";
  }

  static _page(items, limit) {
    return { total: items.length, count: Math.min(items.length, limit), items: items.slice(0, limit) };
  }

  listRecent(limit = 10) {
    const meetings = [];
    for (const key of this.listMarkdown("meetings")) {
      if (key.endsWith("index.md")) continue;
      const text = this.readText(key);
      if (text == null) continue;
      const meta = WikiStore.parseFrontmatter(text);
      if (WikiStore._isPrivate(meta)) continue;
      meetings.push({
        path: key,
        title: meta.title || key,
        timestamp: meta.timestamp || "",
        meeting_type: meta.meeting_type || "generic",
        description: meta.description || "",
      });
    }
    meetings.sort(
      (left, right) =>
        right.timestamp.localeCompare(left.timestamp) || right.path.localeCompare(left.path),
    );
    return WikiStore._page(meetings, limit);
  }

  search(query, limit = 8) {
    const terms = (String(query).toLowerCase().match(/[\w.-]+/g) || []).filter(
      (term) => term.length > 1,
    );
    if (terms.length === 0) return WikiStore._page([], limit);
    const results = [];
    for (const key of this.listMarkdown()) {
      const text = this.readText(key);
      if (text == null) continue;
      const meta = WikiStore.parseFrontmatter(text);
      if (WikiStore._isPrivate(meta)) continue;
      const lowered = text.toLowerCase();
      const matches = terms.filter((term) => lowered.includes(term)).length;
      if (!matches) continue;
      const title = meta.title || key.replace(/\.md$/, "").split("/").pop();
      const titleHits = terms.filter((term) => title.toLowerCase().includes(term)).length;
      const lines = text.split("\n");
      const snippets = [];
      for (let index = 0; index < lines.length && snippets.length < 3; index += 1) {
        if (terms.some((term) => lines[index].toLowerCase().includes(term))) {
          snippets.push({ line: index + 1, text: lines[index].slice(0, 400) });
        }
      }
      results.push({
        path: key,
        title,
        description: meta.description || "",
        score: matches * 10 + titleHits * 8,
        snippets,
      });
    }
    results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return WikiStore._page(results, limit);
  }

  readPage(relPath, limitChars = 40000) {
    const text = this.readText(relPath);
    if (text == null) return { error: "page_not_found", path: assertSafeRelativePath(relPath) };
    const key = path.relative(this.root, this.resolve(relPath)).split(path.sep).join("/");
    return {
      path: key,
      total_chars: text.length,
      content: text.slice(0, limitChars),
      truncated: text.length > limitChars,
    };
  }

  actionItems(options = {}) {
    const ownerTerm = String(options.owner || "").toLowerCase();
    const queryTerm = String(options.query || "").toLowerCase();
    const limit = Number.isInteger(options.limit) ? options.limit : 30;
    const text = this.readText("action-items/active.md") || "";
    const rows = [];
    for (const line of text.split("\n")) {
      const lowered = line.toLowerCase();
      if (!line.startsWith("|") || line.startsWith("|---") || lowered.includes("| owner |")) {
        continue;
      }
      if (ownerTerm && !lowered.includes(ownerTerm)) continue;
      if (queryTerm && !lowered.includes(queryTerm)) continue;
      if (lowered.includes("| done |")) continue;
      rows.push(line);
    }
    return WikiStore._page(rows, limit);
  }
}

module.exports = { WikiStore, assertSafeRelativePath, escapesRoot };
