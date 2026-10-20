"use strict";

// Capability self-check for the tray. Every line shown to the user comes from the fixed
// tables below, keyed by status codes. Provider health text, exception messages, paths,
// and secrets are never displayed; unknown codes collapse to a fixed "unknown" line.

const { execFile } = require("child_process");

const SELF_CHECK_TIMEOUT_MS = 60_000;

const LABELS = Object.freeze({
  microphone: "Microphone permission",
  systemAudio: "System audio permission",
  transcription: "Batch transcription",
  analysis: "Meeting analysis",
  live: "Live captions",
  storage: "Storage",
  memory: "Memory index",
  claudeSkill: "Claude skill",
});

const ORDER = Object.freeze(Object.keys(LABELS));

const ENGINE_TEXT = Object.freeze({
  engine_missing: ["attention", "The Meeting Wiki engine is missing. Reinstall the app."],
  key_unavailable: ["attention", "The API key could not be read from the Keychain. Run setup again."],
  credentials_missing: ["attention", "The API key is not available. Run setup again."],
  not_configured: ["attention", "Not configured. Run setup again or fix your configuration."],
  config_invalid: ["attention", "Your configuration could not be read. Run setup again or fix it by hand."],
  check_failed: ["attention", "The self-check did not finish. Open logs or try again."],
  not_checked: ["note", "Not checked."],
});

const PERMISSION_TEXT = Object.freeze({
  microphone: {
    granted: ["ok", "Allowed."],
    denied: ["attention", "Blocked. Allow Meeting Wiki in System Settings, Privacy & Security, Microphone."],
    restricted: ["attention", "Restricted by a device policy. Recording cannot use the microphone."],
    "not-determined": ["note", "Not asked yet. macOS asks the first time you record."],
    unknown: ["note", "macOS did not report this permission."],
  },
  systemAudio: {
    granted: ["ok", "Allowed."],
    denied: [
      "attention",
      "Blocked. Remote participants will be silent. Allow Meeting Wiki in System Settings, Privacy & Security, Screen & System Audio Recording.",
    ],
    restricted: ["attention", "Restricted by a device policy. Remote participants will be silent."],
    "not-determined": ["note", "Not asked yet. macOS asks the first time you record."],
    unknown: ["note", "macOS did not report this permission."],
  },
});

const CAPABILITY_TEXT = Object.freeze({
  transcription: {
    ready: ["ok", "Ready."],
    failed: ["attention", "Not responding. Use Test current setup in Run setup, or check your provider."],
  },
  analysis: {
    ready: ["ok", "Ready."],
    failed: ["attention", "Not responding. Use Test current setup in Run setup, or check your provider."],
  },
  live: {
    ready: ["ok", "Ready. Live captions are display-only and never change saved notes."],
    no_adapter: ["note", "Not available with this provider. Recording and processing still work."],
    failed: ["attention", "Not ready. Recording and processing still work without live captions."],
  },
  storage: {
    ready: ["ok", "Ready on this Mac."],
    missing: ["note", "The data folder does not exist yet. It is created when you record."],
    failed: ["attention", "The data folder cannot be written. Check its permissions."],
    remote_unverified: ["note", "Shared files go to S3, which is not checked here. Private files stay on this Mac."],
  },
  memory: {
    ready: ["ok", "Ready."],
    empty: ["note", "Empty. Memory fills in as meetings are processed."],
    missing: ["note", "Not built yet. It is created after the first processed meeting."],
    failed: ["attention", "Could not be read. Run meeting-wiki reindex-memory to rebuild it."],
  },
  claudeSkill: {
    installed: ["ok", "Installed and up to date."],
    missing: ["note", "Not installed. Use Install Claude skill in the menu to add it."],
    conflict: ["note", "A different SKILL.md is already there. It was left unchanged."],
    unsafe_path: ["attention", "The skill folder is a link or not a regular file. Nothing was changed."],
    error: ["note", "Could not be checked."],
  },
});

const PROVIDER_NAMES = Object.freeze({
  gemini: "Google Gemini",
  openai_compatible: "an OpenAI-compatible endpoint",
  mlx_whisper: "MLX Whisper on this Mac",
  chunked_mlx_whisper: "MLX Whisper on this Mac",
  ollama: "Ollama",
  text: "text import",
});

const UNKNOWN = ["attention", "Returned an unexpected result."];
const PYTHON_CAPABILITIES = Object.freeze(["transcription", "analysis", "live", "storage", "memory"]);
const MEDIA_STATUSES = new Set(["granted", "denied", "restricted", "not-determined"]);

function entryFor(capability, status) {
  const table = PERMISSION_TEXT[capability] || CAPABILITY_TEXT[capability] || {};
  if (Object.prototype.hasOwnProperty.call(table, status)) return table[status];
  if (Object.prototype.hasOwnProperty.call(ENGINE_TEXT, status)) return ENGINE_TEXT[status];
  return UNKNOWN;
}

// Keeps only allowlisted codes from the CLI report; anything else becomes "unknown".
function projectReport(parsed) {
  const result = { capabilities: {}, providers: {}, liveScope: "" };
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
    for (const name of PYTHON_CAPABILITIES) result.capabilities[name] = "check_failed";
    return result;
  }
  if (parsed.config === "invalid") {
    for (const name of PYTHON_CAPABILITIES) result.capabilities[name] = "config_invalid";
    return result;
  }
  const capabilities = parsed.capabilities && typeof parsed.capabilities === "object" ? parsed.capabilities : {};
  for (const name of PYTHON_CAPABILITIES) {
    const status = capabilities[name];
    result.capabilities[name] = typeof status === "string" && entryFor(name, status) !== UNKNOWN ? status : "unknown";
  }
  const providers = parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {};
  for (const field of ["transcription", "llm", "live_transcription"]) {
    if (Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, providers[field])) result.providers[field] = providers[field];
  }
  if (parsed.live_scope === "external" || parsed.live_scope === "local") result.liveScope = parsed.live_scope;
  return result;
}

function runCli(python, configPath, execFileFn, env) {
  return new Promise((resolve) => {
    execFileFn(
      python,
      ["-m", "meeting_wiki.cli", "--config", configPath, "self-check"],
      { encoding: "utf8", maxBuffer: 256 * 1024, timeout: SELF_CHECK_TIMEOUT_MS, env },
      (_error, stdout) => {
        try {
          resolve(JSON.parse(String(stdout || "").trim()));
        } catch (_) {
          resolve(null);
        }
      },
    );
  });
}

function mediaStatus(mediaAccess, type) {
  try {
    const status = mediaAccess(type);
    return MEDIA_STATUSES.has(status) ? status : "unknown";
  } catch (_) {
    return "unknown";
  }
}

// env is null when the provider key is unavailable; the engine is then not run at all.
async function runSelfCheck({ python, configPath, pythonAvailable, env, mediaAccess, skillStatus, execFileFn = execFile }) {
  const report = {
    capabilities: {
      microphone: mediaStatus(mediaAccess, "microphone"),
      systemAudio: mediaStatus(mediaAccess, "screen"),
    },
    providers: {},
    liveScope: "",
  };
  if (!pythonAvailable) {
    for (const name of PYTHON_CAPABILITIES) report.capabilities[name] = "engine_missing";
  } else if (!env) {
    for (const name of ["transcription", "analysis", "live"]) report.capabilities[name] = "key_unavailable";
    report.capabilities.storage = "not_checked";
    report.capabilities.memory = "not_checked";
  } else {
    const projected = projectReport(await runCli(python, configPath, execFileFn, env));
    Object.assign(report.capabilities, projected.capabilities);
    report.providers = projected.providers;
    report.liveScope = projected.liveScope;
  }
  let skill = "error";
  try {
    skill = skillStatus();
  } catch (_) {}
  report.capabilities.claudeSkill = typeof skill === "string" ? skill : "error";
  return report;
}

const TONE_PREFIX = Object.freeze({ ok: "OK", note: "Note", attention: "Needs attention" });

function formatSelfCheck(report) {
  const capabilities = (report && report.capabilities) || {};
  const lines = [];
  let attention = 0;
  for (const name of ORDER) {
    const [tone, text] = entryFor(name, capabilities[name]);
    if (tone === "attention") attention += 1;
    lines.push(`${TONE_PREFIX[tone]}  ${LABELS[name]}: ${text}`);
  }
  const providers = (report && report.providers) || {};
  const processedBy = PROVIDER_NAMES[providers.transcription];
  if (processedBy) lines.push("", `Recordings are transcribed by ${processedBy}.`);
  if (report && report.liveScope === "external") lines.push("Live captions send microphone audio to an external provider.");
  if (report && report.liveScope === "local") lines.push("Live captions run on this Mac.");
  return {
    type: attention ? "warning" : "info",
    title: "Meeting Wiki self-check",
    message: attention
      ? `${attention} ${attention === 1 ? "item needs" : "items need"} attention.`
      : "Everything Meeting Wiki needs is ready.",
    detail: lines.join("\n"),
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
  };
}

module.exports = {
  CAPABILITY_TEXT,
  ENGINE_TEXT,
  LABELS,
  PERMISSION_TEXT,
  PROVIDER_NAMES,
  formatSelfCheck,
  projectReport,
  runSelfCheck,
};
