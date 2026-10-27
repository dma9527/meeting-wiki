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
  "resource",
  "topic",
  "transcript_segment",
]);
const RESOURCE_RELATIONS = Object.freeze([
  "code_review",
  "design_doc",
  "follow_up",
  "notes",
  "reference",
  "ticket",
]);
const MEETING_NODE_ID = /^meeting:[0-9a-f]{16}$/;
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

const CITATION_VERSION = 1;
// A day of audio is far longer than any recording the app allows.
const MAX_ANCHOR_SECONDS = 86_400;

function boundedSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_ANCHOR_SECONDS
    ? value
    : null;
}

function projectAnchor(anchor) {
  if (!anchor || typeof anchor !== "object" || anchor.kind !== "transcript_segment") return null;
  const startSeconds = boundedSeconds(anchor.start_seconds);
  const endSeconds = boundedSeconds(anchor.end_seconds);
  return startSeconds === null || endSeconds === null ? null : { startSeconds, endSeconds };
}

// The one citation shape from the CLI and MCP. Only a shared wiki meeting page can be opened.
function projectCitation(citation) {
  if (!citation || typeof citation !== "object" || citation.version !== CITATION_VERSION) return null;
  const privacy = citation.privacy === "shared" ? "shared" : "private";
  const sourcePath = text(citation.source_path, 300);
  return {
    meetingTitle: text(citation.meeting_title, 300),
    occurredAt: text(citation.occurred_at, 40),
    privacy,
    sourcePath: privacy === "shared" && sourcePath.startsWith("wiki/meetings/") && !sourcePath.includes("..")
      ? sourcePath
      : "",
    anchor: projectAnchor(citation.anchor),
  };
}

function projectItem(item) {
  const relations = Array.isArray(item.relations) ? item.relations.slice(0, MAX_RELATIONS) : [];
  const nodeType = NODE_TYPES.includes(item.node_type) ? item.node_type : "unknown";
  const privacy = item.privacy === "shared" ? "shared" : "private";
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const url = nodeType === "resource" ? text(metadata.url, 2048) : "";
  return {
    nodeType,
    // Only a shared meeting can be targeted by "Add resource".
    meetingNodeId:
      nodeType === "meeting" && privacy === "shared" && MEETING_NODE_ID.test(item.node_id || "")
        ? item.node_id
        : "",
    url: /^https?:\/\//.test(url) ? url : "",
    resourceRelation:
      nodeType === "resource" && RESOURCE_RELATIONS.includes(metadata.relation) ? metadata.relation : "",
    label: text(item.label, 300),
    content: text(item.content, 800),
    occurredAt: text(item.occurred_at, 40),
    privacy,
    source: projectSource(item.source),
    citation: projectCitation(item.citation),
    relations: relations.map((relation) => ({
      relation: text(relation.relation, 40),
      direction: relation.direction === "in" ? "in" : "out",
      nodeType: NODE_TYPES.includes(relation.node_type) ? relation.node_type : "unknown",
      label: text(relation.label, 200),
      source: projectSource(relation.source),
      citation: projectCitation(relation.citation),
    })),
  };
}

// Defense in depth: a shared-only request never forwards a private item or relation.
function sharedOnly(item) {
  const hidesSource = (entry) =>
    (entry.source && entry.source.privacy !== "shared")
    || (entry.citation && entry.citation.privacy !== "shared");
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

const DECISION_STATUSES = Object.freeze(["accepted", "superseded", "reversed"]);
const MAX_DECISIONS = 200;
const MAX_DECISION_DETAIL = 1200;

function decisionStatus(value) {
  return DECISION_STATUSES.includes(value) ? value : "accepted";
}

// A link names another shared decision; anything not clearly shared is dropped.
function projectDecisionLink(link) {
  if (!link || typeof link !== "object") return null;
  const citation = projectCitation(link.citation);
  if (!citation || citation.privacy !== "shared") return null;
  return {
    title: text(link.title, 300),
    occurredAt: text(link.occurred_at, 40),
    citation,
  };
}

function projectDecision(item) {
  const citation = projectCitation(item.citation);
  return {
    title: text(item.title, 300),
    detail: text(item.detail, MAX_DECISION_DETAIL),
    owner: text(item.owner, 200),
    status: decisionStatus(item.status),
    effectiveStatus: decisionStatus(item.effective_status),
    occurredAt: text(item.occurred_at, 40),
    privacy: item.privacy === "shared" ? "shared" : "private",
    citation,
    supersedes: projectDecisionLink(item.supersedes),
    supersededBy: projectDecisionLink(item.superseded_by),
  };
}

// Decision history is shared-only: the renderer never asks for private decisions.
function listDecisions(python, configPath, options, execFileFn = execFile) {
  const requested = options && Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const args = [
    "-m", "meeting_wiki.cli", "--config", configPath, "memory-decisions",
    `--limit=${Math.min(requested, MAX_DECISIONS)}`,
  ];
  return new Promise((resolve, reject) => {
    execFileFn(python, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      let parsed;
      try {
        parsed = JSON.parse((stdout || "").trim());
      } catch (_) {
        reject(new Error("memory-decisions returned invalid JSON"));
        return;
      }
      if (error || !parsed || !Array.isArray(parsed.items)) {
        reject(new Error("decision history failed"));
        return;
      }
      const items = parsed.items
        .slice(-MAX_DECISIONS)
        .map(projectDecision)
        .filter((decision) => decision.privacy === "shared" && decision.citation && decision.citation.privacy === "shared");
      resolve({ count: items.length, items });
    });
  });
}

// Fields come only from the user. The desktop never sends --allow-private or
// --allow-loopback, so resources can only attach to shared meetings over https.
const RESOURCE_ERRORS = Object.freeze({
  credentials_not_allowed: "Remove credentials or secret tokens from the URL.",
  fragment_not_allowed: "Remove the #fragment from the URL.",
  https_required: "Use an https URL.",
  invalid_host: "Use a public host name such as docs.example.com.",
  invalid_relation: "Choose a relation from the list.",
  invalid_summary: "The summary must be 2,000 characters or fewer.",
  invalid_title: "Enter a one-line title of 200 characters or fewer.",
  invalid_url: "Enter a valid https URL.",
  meeting_unavailable: "That meeting is not available for shared resources.",
  private_or_reserved_host: "Private, local, and reserved network addresses are not allowed.",
  resource_exists: "This URL is already attached to that meeting.",
  unsupported_scheme: "Use an https URL.",
});

function cleanText(value, max, { multiline }) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("invalid text");
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (trimmed.length > max) throw new Error("text too long");
  const control = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (control.test(trimmed)) throw new Error("invalid text");
  return trimmed;
}

function validateResourceInput(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (typeof source.meetingNodeId !== "string" || !MEETING_NODE_ID.test(source.meetingNodeId)) {
    return { error: "meeting_unavailable" };
  }
  const url = typeof source.url === "string" ? source.url.trim() : "";
  if (!url || url.length > 2048 || !/^[\x21-\x7e]+$/.test(url)) return { error: "invalid_url" };
  if (!/^https:\/\//i.test(url)) return { error: "https_required" };
  if (url.includes("#")) return { error: "fragment_not_allowed" };
  if (/^https:\/\/[^/?]*@/i.test(url)) return { error: "credentials_not_allowed" };
  let title;
  let summary;
  try {
    title = cleanText(source.title, 200, { multiline: false });
  } catch (_) {
    return { error: "invalid_title" };
  }
  if (!title) return { error: "invalid_title" };
  try {
    summary = cleanText(source.summary, 2000, { multiline: true });
  } catch (_) {
    return { error: "invalid_summary" };
  }
  const relation = source.relation === undefined ? "reference" : source.relation;
  if (!RESOURCE_RELATIONS.includes(relation)) return { error: "invalid_relation" };
  return { value: { meetingNodeId: source.meetingNodeId, url, title, summary, relation } };
}

function addResourceArgs(configPath, value) {
  return [
    "-m", "meeting_wiki.cli", "--config", configPath, "memory-add-resource",
    `--meeting=${value.meetingNodeId}`, `--url=${value.url}`, `--title=${value.title}`,
    `--summary=${value.summary}`, `--relation=${value.relation}`,
  ];
}

const resourceError = (code) => ({
  error: Object.prototype.hasOwnProperty.call(RESOURCE_ERRORS, code)
    ? RESOURCE_ERRORS[code]
    : "The resource could not be saved.",
});

function addResource(python, configPath, input, execFileFn = execFile) {
  const checked = validateResourceInput(input);
  if (checked.error) return Promise.resolve(resourceError(checked.error));
  const args = addResourceArgs(configPath, checked.value);
  return new Promise((resolve) => {
    execFileFn(python, args, { encoding: "utf8", maxBuffer: 256 * 1024 }, (error, stdout) => {
      let parsed;
      try {
        parsed = JSON.parse((stdout || "").trim());
      } catch (_) {
        resolve(resourceError(""));
        return;
      }
      if (!error && parsed && parsed.added === true && parsed.resource) {
        resolve({
          added: true,
          resource: {
            title: text(parsed.resource.title, 200),
            relation: RESOURCE_RELATIONS.includes(parsed.resource.relation) ? parsed.resource.relation : "",
          },
        });
        return;
      }
      resolve(resourceError(parsed && typeof parsed.error === "string" ? parsed.error : ""));
    });
  });
}

module.exports = {
  NODE_TYPES,
  RESOURCE_ERRORS,
  RESOURCE_RELATIONS,
  addResource,
  addResourceArgs,
  listDecisions,
  memorySearchArgs,
  projectDecision,
  projectItem,
  sanitizeOptions,
  searchMemory,
  validateQuery,
  validateResourceInput,
};
