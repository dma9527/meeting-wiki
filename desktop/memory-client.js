"use strict";

// Runs the local memory-search CLI. Input is validated before a process starts,
// values are passed as --flag=value so none can be read as an option, and only a
// fixed projection of each result is returned to the renderer.

const { execFile } = require("child_process");

const NODE_TYPES = Object.freeze([
  "action_item",
  "decision",
  "meeting",
  "person",
  "topic",
  "transcript_segment",
]);
const MAX_LIMIT = 30;
const MAX_RELATIONS = 12;

function validateQuery(query) {
  if (typeof query !== "string") throw new Error("query must be a string");
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 300) throw new Error("query must be 2-300 characters");
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error("query has invalid characters");
  return trimmed;
}

function sanitizeOptions(options) {
  const source = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const requested = Array.isArray(source.types) ? source.types : [];
  if (requested.length > NODE_TYPES.length) throw new Error("too many type filters");
  for (const type of requested) {
    if (!NODE_TYPES.includes(type)) throw new Error("unknown type filter");
  }
  const limit = Number.isInteger(source.limit) && source.limit > 0
    ? Math.min(source.limit, MAX_LIMIT)
    : 12;
  return {
    types: [...new Set(requested)].sort(),
    limit,
    // Only an explicit boolean true opts in; anything else stays shared-only.
    includePrivate: source.includePrivate === true,
  };
}

function memorySearchArgs(configPath, query, options) {
  const safeQuery = validateQuery(query);
  const safe = sanitizeOptions(options);
  const args = [
    "-m", "meeting_wiki.cli", "--config", configPath, "memory-search",
    `--query=${safeQuery}`, `--limit=${safe.limit}`,
  ];
  for (const type of safe.types) args.push(`--type=${type}`);
  if (safe.includePrivate) args.push("--include-private");
  return args;
}

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function projectSource(source) {
  if (!source || typeof source !== "object") return null;
  const privacy = source.privacy === "shared" ? "shared" : "private";
  const meetingKey = text(source.meeting_key, 300);
  return {
    title: text(source.title, 300),
    occurredAt: text(source.occurred_at, 40),
    privacy,
    // Only shared wiki pages can be opened; the wiki store refuses everything else.
    meetingKey: privacy === "shared" && meetingKey.startsWith("wiki/meetings/") ? meetingKey : "",
  };
}

function projectItem(item) {
  const relations = Array.isArray(item.relations) ? item.relations.slice(0, MAX_RELATIONS) : [];
  return {
    nodeType: NODE_TYPES.includes(item.node_type) ? item.node_type : "unknown",
    label: text(item.label, 300),
    content: text(item.content, 800),
    occurredAt: text(item.occurred_at, 40),
    privacy: item.privacy === "shared" ? "shared" : "private",
    source: projectSource(item.source),
    relations: relations.map((relation) => ({
      relation: text(relation.relation, 40),
      direction: relation.direction === "in" ? "in" : "out",
      nodeType: NODE_TYPES.includes(relation.node_type) ? relation.node_type : "unknown",
      label: text(relation.label, 200),
      source: projectSource(relation.source),
    })),
  };
}

// Defense in depth: a shared-only request never forwards a private item or relation.
function sharedOnly(item) {
  const hidesSource = (entry) => entry.source && entry.source.privacy !== "shared";
  if (item.privacy !== "shared" || hidesSource(item)) return null;
  return { ...item, relations: item.relations.filter((relation) => !hidesSource(relation)) };
}

function searchMemory(python, configPath, query, options, execFileFn = execFile) {
  const args = memorySearchArgs(configPath, query, options);
  const includePrivate = sanitizeOptions(options).includePrivate;
  return new Promise((resolve, reject) => {
    execFileFn(python, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      let parsed;
      try {
        parsed = JSON.parse((stdout || "").trim());
      } catch (_) {
        reject(new Error("memory-search returned invalid JSON"));
        return;
      }
      if (error || !parsed || !Array.isArray(parsed.items)) {
        reject(new Error("memory search failed"));
        return;
      }
      const projected = parsed.items.slice(0, MAX_LIMIT).map(projectItem);
      const items = includePrivate ? projected : projected.map(sharedOnly).filter(Boolean);
      resolve({ count: items.length, items });
    });
  });
}

module.exports = { NODE_TYPES, memorySearchArgs, projectItem, sanitizeOptions, searchMemory, validateQuery };
