#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
RUFF="$ROOT/.venv/bin/ruff"

[ -x "$PY" ] || { echo "Run: python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'"; exit 1; }

cd "$ROOT"
echo "== Python lint =="
"$RUFF" check meeting_wiki tests
echo "== Python tests =="
"$PY" -m pytest
echo "== Package build =="
"$PY" -m pip wheel --no-deps -w /tmp/meeting-wiki-wheel . >/dev/null

echo "== Desktop syntax/tests =="
node --check desktop/main.js
node --check desktop/capture.js
(cd desktop && npm test)

echo "== Dependency audits =="
"$ROOT/.venv/bin/pip-audit"
(cd desktop && npm audit --audit-level=high)

echo "== Public safety scan =="
"$ROOT/scripts/public-safety-scan.sh"

echo "All checks passed."
