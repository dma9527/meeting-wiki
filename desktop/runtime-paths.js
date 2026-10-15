"use strict";

const path = require("path");

const OVERRIDES = {
  python: "MEETING_WIKI_PYTHON",
  rec: "MEETING_WIKI_REC_BIN",
  sox: "MEETING_WIKI_SOX_BIN",
};

const DEV_BINARY_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

function override(env, name) {
  const value = env && env[OVERRIDES[name]];
  return value ? value : null;
}

// Packaged builds only trust the app bundle; null means the bundled tool is absent.
function packagedPath(name, { resourcesPath, existsSync }) {
  if (!resourcesPath) return null;
  const candidate = path.join(resourcesPath, "runtime", "bin", name);
  return existsSync(candidate) ? candidate : null;
}

function resolvePython({ env = {}, isPackaged = false, resourcesPath, dataDir, existsSync }) {
  const explicit = override(env, "python");
  if (explicit) return explicit;
  if (isPackaged) return packagedPath("python", { resourcesPath, existsSync });
  return path.join(dataDir, "venv", "bin", "python");
}

function resolveAudioBinary(name, { env = {}, isPackaged = false, resourcesPath, existsSync }) {
  if (!["rec", "sox"].includes(name)) throw new Error(`unknown audio binary: ${name}`);
  const explicit = override(env, name);
  if (explicit) return explicit;
  if (isPackaged) return packagedPath(name, { resourcesPath, existsSync });
  for (const dir of DEV_BINARY_DIRS) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function resolveRuntimePaths(deps) {
  return {
    packaged: Boolean(deps.isPackaged),
    python: resolvePython(deps),
    rec: resolveAudioBinary("rec", deps),
    sox: resolveAudioBinary("sox", deps),
  };
}

function missingRuntimeMessage(name, { packaged = false, resolvedPath = null } = {}) {
  if (!OVERRIDES[name]) throw new Error(`unknown runtime component: ${name}`);
  const label = name === "python" ? "Python runtime" : `${name} audio tool`;
  if (packaged) {
    return {
      title: "Meeting Wiki installation damaged",
      body: `The bundled ${label} is missing from the app. Reinstall Meeting Wiki.`,
    };
  }
  if (name === "python") {
    const where = resolvedPath ? ` at ${resolvedPath}` : "";
    return {
      title: "Meeting Wiki setup required",
      body: `Python environment not found${where}. Run scripts/setup.sh or set ${OVERRIDES.python}.`,
    };
  }
  return {
    title: "Meeting Wiki setup required",
    body: `${name} was not found. Install SoX (brew install sox) or set ${OVERRIDES[name]}.`,
  };
}

module.exports = {
  missingRuntimeMessage,
  resolveAudioBinary,
  resolvePython,
  resolveRuntimePaths,
};
