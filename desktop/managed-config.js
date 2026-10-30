"use strict";

// Strict reader and writer for the TOML that setup generates. Setup and Settings both
// write the [identity] section through here; anything outside MANAGED_SCHEMA is a hand edit.

const MANAGED_HEADER = "# Managed by Meeting Wiki setup.";
const TOP_LEVEL = "";

// "" holds top-level keys; user_name is the legacy primary profile name.
const MANAGED_SCHEMA = Object.freeze({
  [TOP_LEVEL]: { user_name: "string", language: "string" },
  identity: { primary_profile_name: "string", aliases: "string[]" },
  providers: { transcription: "string", llm: "string", live_transcription: "string", live_language: "string" },
  live: { allow_external_providers: "boolean", translation_target_language: "string", summary_context_characters: "integer" },
  languages: { transcript: "string", live_translation: "string", live_summary: "string", memory: "string", ui: "string" },
  gemini: { api_key_env: "string", batch_audio_model: "string", batch_audio_api: "string", live_model: "string", language_model: "string" },
  openai_compatible: { base_url: "string", model: "string", api_key_env: "string" },
  openai_transcription: { base_url: "string", model: "string", api_key_env: "string" },
});

// Stricter than IdentityConfig in meeting_wiki/config.py, so a UI save always loads there.
const IDENTITY_LIMITS = Object.freeze({ nameMaxLength: 100, maxAliases: 20 });
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'\u2019()_-]*$/u;
const EMPTY_IDENTITY = Object.freeze({ primaryProfileName: "", aliases: Object.freeze([]), legacyUserName: "" });
const IDENTITY_COMMENT = "# The local microphone channel is always attributed to this profile.";
const DEFAULT_LANGUAGE_SETTINGS = Object.freeze({
  transcriptLanguage: "auto",
  liveTranslationLanguage: "zh-CN",
  liveSummaryLanguage: "zh-CN",
  memoryLanguage: "source",
  uiLanguage: "system",
});
const LANGUAGE_VALUES = Object.freeze({
  transcriptLanguage: Object.freeze(["auto", "en", "zh-CN"]),
  liveTranslationLanguage: Object.freeze(["en", "zh-CN"]),
  liveSummaryLanguage: Object.freeze(["en", "zh-CN"]),
  memoryLanguage: Object.freeze(["source", "en", "zh-CN"]),
  uiLanguage: Object.freeze(["system", "en", "zh-CN"]),
});

const STRING_SOURCE = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\["\\\\]|\\\\u[0-9a-fA-F]{4})*"';
const STRING_VALUE = new RegExp(`^${STRING_SOURCE}$`);
const STRING_ARRAY = new RegExp(`^\\[(?:${STRING_SOURCE}(?:, ${STRING_SOURCE})*)?\\]$`);

// Errors whose message is safe to show in the renderer.
class IdentityError extends Error {}

function tomlString(value) {
  const escaped = String(value).replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    if (char === "\\") return "\\\\";
    if (char === '"') return '\\"';
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `"${escaped}"`;
}

function parseValue(raw) {
  if (raw === "true") return { type: "boolean", value: true };
  if (raw === "false") return { type: "boolean", value: false };
  if (/^\d{1,9}$/.test(raw)) return { type: "integer", value: Number(raw) };
  if (STRING_VALUE.test(raw)) return { type: "string", value: JSON.parse(raw) };
  if (STRING_ARRAY.test(raw)) {
    return { type: "string[]", value: [...raw.matchAll(new RegExp(STRING_SOURCE, "g"))].map(([item]) => JSON.parse(item)) };
  }
  return null;
}

// Returns { [table]: { key: value } } for a setup-managed config, or null for anything else.
function parseManagedConfig(text) {
  if (typeof text !== "string" || !text.startsWith(MANAGED_HEADER)) return null;
  const tables = { [TOP_LEVEL]: {} };
  let section = TOP_LEVEL;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([a-z_]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      if (!MANAGED_SCHEMA[section] || section === TOP_LEVEL || tables[section]) return null;
      tables[section] = {};
      continue;
    }
    const pair = /^([a-z_]+) = (.+)$/.exec(line);
    if (!pair) return null;
    const [, key, raw] = pair;
    const expected = MANAGED_SCHEMA[section][key];
    const parsed = parseValue(raw);
    if (!expected || !parsed || parsed.type !== expected || key in tables[section]) return null;
    tables[section][key] = parsed.value;
  }
  return tables;
}

function identityFromTables(tables) {
  const identity = tables.identity || {};
  return {
    primaryProfileName: identity.primary_profile_name ?? "",
    aliases: [...(identity.aliases ?? [])],
    legacyUserName: tables[TOP_LEVEL].user_name ?? "",
  };
}

function canonicalLanguage(value, fallback) {
  if (value === undefined) return fallback;
  return value === "zh" ? "zh-CN" : value;
}

function configuredLanguage(languages, key, fallback) {
  return Object.prototype.hasOwnProperty.call(languages, key) ? languages[key] : fallback;
}

function languageFromTables(tables) {
  const languages = tables.languages || {};
  const legacyTranscript = canonicalLanguage(
    tables[TOP_LEVEL].language,
    DEFAULT_LANGUAGE_SETTINGS.transcriptLanguage,
  );
  const legacyTranslation = canonicalLanguage(
    tables.live && tables.live.translation_target_language,
    DEFAULT_LANGUAGE_SETTINGS.liveTranslationLanguage,
  );
  return {
    transcriptLanguage: configuredLanguage(languages, "transcript", legacyTranscript),
    liveTranslationLanguage: configuredLanguage(languages, "live_translation", legacyTranslation),
    liveSummaryLanguage: configuredLanguage(
      languages,
      "live_summary",
      DEFAULT_LANGUAGE_SETTINGS.liveSummaryLanguage,
    ),
    memoryLanguage: configuredLanguage(languages, "memory", DEFAULT_LANGUAGE_SETTINGS.memoryLanguage),
    uiLanguage: configuredLanguage(languages, "ui", DEFAULT_LANGUAGE_SETTINGS.uiLanguage),
  };
}

function unsupportedLanguageFields(tables) {
  const values = languageFromTables(tables);
  return Object.entries(LANGUAGE_VALUES)
    .filter(([field, allowed]) => !allowed.includes(values[field]))
    .map(([field]) => field);
}

function readManagedLanguage(text) {
  const tables = parseManagedConfig(text);
  return tables ? languageFromTables(tables) : null;
}

function renderLanguageLines(values = DEFAULT_LANGUAGE_SETTINGS) {
  return [
    "[languages]",
    `transcript = ${tomlString(values.transcriptLanguage)}`,
    `live_translation = ${tomlString(values.liveTranslationLanguage)}`,
    `live_summary = ${tomlString(values.liveSummaryLanguage)}`,
    `memory = ${tomlString(values.memoryLanguage)}`,
    `ui = ${tomlString(values.uiLanguage)}`,
    "",
  ];
}

function replaceLanguageSection(text, values) {
  const lines = text.split("\n");
  const kept = [];
  let section = TOP_LEVEL;
  for (const line of lines) {
    const match = /^\[([a-z_]+)\]$/.exec(line);
    if (match) section = match[1];
    const legacyLanguage = section === TOP_LEVEL && /^language = /.test(line);
    const legacyTranslation = section === "live" && /^translation_target_language = /.test(line);
    if (section !== "languages" && !legacyLanguage && !legacyTranslation) kept.push(line);
  }
  return [...kept.join("\n").trimEnd().split("\n"), "", ...renderLanguageLines(values)].join("\n");
}

function readManagedIdentity(text) {
  const tables = parseManagedConfig(text);
  return tables ? identityFromTables(tables) : null;
}

// The top-level legacy key and the [identity] table, ending with a blank line.
function renderIdentityLines(identity = EMPTY_IDENTITY) {
  const lines = [];
  if (identity.legacyUserName) lines.push(`user_name = ${tomlString(identity.legacyUserName)}`, "");
  lines.push(
    "[identity]",
    IDENTITY_COMMENT,
    `primary_profile_name = ${tomlString(identity.primaryProfileName || "")}`,
    `aliases = [${(identity.aliases || []).map(tomlString).join(", ")}]`,
    "",
  );
  return lines;
}

// Rewrites only the top-level keys and [identity]; every other table keeps its bytes.
function replaceIdentitySection(text, identity) {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].startsWith("#")) start += 1;
  const header = lines.slice(0, start);
  const topLevel = [];
  const kept = [];
  let section = TOP_LEVEL;
  for (const line of lines.slice(start)) {
    const match = /^\[([a-z_]+)\]$/.exec(line);
    if (match) section = match[1];
    if (section === TOP_LEVEL) {
      if (line && !/^user_name = /.test(line)) topLevel.push(line);
    } else if (section !== "identity") {
      kept.push(line);
    }
  }
  const separator = topLevel.length ? [""] : [];
  return [...header, "", ...topLevel, ...separator, ...renderIdentityLines(identity), ...kept].join("\n");
}

function normalizeName(value) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function nameKey(value) {
  return value.normalize("NFKC").toLowerCase();
}

function checkName(value, label) {
  if (typeof value !== "string") throw new IdentityError(`Enter ${label}.`);
  const name = normalizeName(value);
  if (!name) throw new IdentityError(`Enter ${label}.`);
  if ([...name].length > IDENTITY_LIMITS.nameMaxLength) {
    throw new IdentityError(`Keep each name to ${IDENTITY_LIMITS.nameMaxLength} characters or fewer.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new IdentityError(
      "Names may use letters, numbers, spaces, and . , ' - _ ( ) and must start with a letter or number.",
    );
  }
  return name;
}

function validateIdentity(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const primaryProfileName = checkName(source.primaryProfileName, "your name as it should appear in meeting notes");
  if (!Array.isArray(source.aliases)) throw new IdentityError("Enter aliases one per line.");
  if (source.aliases.length > IDENTITY_LIMITS.maxAliases) {
    throw new IdentityError(`Add at most ${IDENTITY_LIMITS.maxAliases} aliases.`);
  }
  const seen = new Set([nameKey(primaryProfileName)]);
  const aliases = [];
  for (const value of source.aliases) {
    const alias = checkName(value, "each alias");
    const key = nameKey(alias);
    if (seen.has(key)) {
      throw new IdentityError(
        key === nameKey(primaryProfileName) ? "An alias repeats your primary name." : "Each alias must be different.",
      );
    }
    seen.add(key);
    aliases.push(alias);
  }
  return { primaryProfileName, aliases };
}

module.exports = {
  DEFAULT_LANGUAGE_SETTINGS,
  EMPTY_IDENTITY,
  IDENTITY_LIMITS,
  IdentityError,
  LANGUAGE_VALUES,
  MANAGED_HEADER,
  MANAGED_SCHEMA,
  NAME_PATTERN,
  TOP_LEVEL,
  identityFromTables,
  languageFromTables,
  parseManagedConfig,
  readManagedIdentity,
  readManagedLanguage,
  renderIdentityLines,
  renderLanguageLines,
  replaceIdentitySection,
  replaceLanguageSection,
  tomlString,
  unsupportedLanguageFields,
  validateIdentity,
};
