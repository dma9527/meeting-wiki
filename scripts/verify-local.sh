#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
RUFF="$ROOT/.venv/bin/ruff"

[ -x "$PY" ] || { echo "Run: python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'"; exit 1; }

cd "$ROOT"
echo "== Shell syntax =="
for script in scripts/*.sh; do
  bash -n "$script"
done

echo "== Python lint =="
"$RUFF" check meeting_wiki tests
echo "== Python tests =="
"$PY" -m pytest
echo "== Package build =="
"$PY" -m pip wheel --no-deps -w /tmp/meeting-wiki-wheel . >/dev/null
SDIST_DIR="$(mktemp -d /tmp/meeting-wiki-sdist.XXXXXX)"
trap 'rm -rf "$SDIST_DIR"' EXIT
"$PY" -m build --sdist --outdir "$SDIST_DIR" . >/dev/null
SDIST="$(find "$SDIST_DIR" -name '*.tar.gz' -print -quit)"
"$PY" - "$SDIST" <<'PY'
import sys
import tarfile
from pathlib import PurePosixPath

archive = sys.argv[1]
forbidden_segments = {".venv", "__pycache__", "dist", "node_modules", "out"}
forbidden_names = {".DS_Store", "config.toml"}
forbidden_suffixes = {
    ".db", ".db-shm", ".db-wal", ".flac", ".key", ".m4a", ".mp3",
    ".ogg", ".pem", ".pyc", ".wav", ".webm",
}
with tarfile.open(archive, "r:gz") as source:
    members = source.getmembers()
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"unsafe sdist path: {member.name}")
        if member.issym() or member.islnk():
            raise SystemExit(f"sdist link is not allowed: {member.name}")
        if forbidden_segments.intersection(path.parts):
            raise SystemExit(f"generated directory in sdist: {member.name}")
        if path.name in forbidden_names or path.name.startswith(".env"):
            raise SystemExit(f"private file in sdist: {member.name}")
        if any(path.name.endswith(suffix) for suffix in forbidden_suffixes):
            raise SystemExit(f"private artifact in sdist: {member.name}")
    if not any(member.name.endswith("/meeting_wiki/__init__.py") for member in members):
        raise SystemExit("meeting_wiki package missing from sdist")
print(f"sdist safety passed: {len(members)} members")
PY

echo "== Desktop syntax/tests =="
node --check desktop/main.js
node --check desktop/capture.js
node --check desktop/status.js
node --check desktop/wiki-window.js
node --check desktop/wiki-store.js
node --check desktop/corrections-client.js
node --check desktop/memory-client.js
node --check desktop/skill-installer.js
node --check desktop/self-check.js
node --check desktop/setting-metadata.js
node --check desktop/preload.js
node --check desktop/managed-config.js
node --check desktop/setup-window.js
node --check desktop/setup-preload.js
node --check desktop/settings-window.js
node --check desktop/settings-preload.js
node --check desktop/live-session.js
node --check desktop/live-sidebar-window.js
node --check desktop/live-sidebar-preload.js
node --check desktop/recording-session.js
node --check desktop/recording-settings.js
node --check desktop/renderer/app.js
node --check desktop/renderer/setup.js
node --check desktop/renderer/settings.js
node --check desktop/renderer/live-sidebar.js
(cd desktop && npm test)

echo "== Dependency audits =="
"$ROOT/.venv/bin/pip-audit"
(cd desktop && npm audit --audit-level=high)

echo "== Public safety scan =="
"$ROOT/scripts/public-safety-scan.sh"

echo "All checks passed."
