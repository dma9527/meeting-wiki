#!/usr/bin/env bash
# Stage the app-owned Apple Silicon runtime that electron-builder ships at Resources/runtime.
# Exit codes: 0 staged, 1 error, 3 audio tools cannot be redistributed defensibly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PYTHON_VERSION="3.12.12"
PYTHON_KEY="cpython-$PYTHON_VERSION-macos-aarch64-none"
PYTHON_MINOR="python${PYTHON_VERSION%.*}"
LOCK="$ROOT/scripts/runtime-requirements.txt"
HELPER="$ROOT/scripts/runtime_manifest.py"
OUT="${MEETING_WIKI_RUNTIME_OUT:-$ROOT/desktop/runtime}"
BLOCKED_REPORT="$OUT.blocked.json"
EPOCH_STAMP="1980-01-01T00:00:00"

fail() {
  echo "prepare-runtime: $1" >&2
  exit 1
}

if [ "${1:-}" = "--lock" ]; then
  uv pip compile --custom-compile-command "scripts/prepare-runtime-macos.sh --lock" \
    "$ROOT/pyproject.toml" --extra gemini --generate-hashes -o "$LOCK" \
    --python-version "${PYTHON_VERSION%.*}" --python-platform aarch64-apple-darwin
  exit 0
fi

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] \
  || fail "the portable runtime is built on Apple Silicon macOS only"
for command in uv otool install_name_tool codesign lipo ditto; do
  command -v "$command" >/dev/null || fail "$command is required"
done
[ -f "$LOCK" ] || fail "missing $LOCK; run scripts/prepare-runtime-macos.sh --lock"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/meeting-wiki-runtime.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/runtime"
export SOURCE_DATE_EPOCH=315532800
export PYTHONDONTWRITEBYTECODE=1
unset PYTHONPATH PYTHONHOME VIRTUAL_ENV

echo "== Python $PYTHON_VERSION (uv-managed standalone build) =="
uv python install --no-bin "$PYTHON_VERSION" >/dev/null
SOURCE_PYTHON="$(uv python find --managed-python --no-project "$PYTHON_KEY")"
SOURCE_PREFIX="$(cd "$(dirname "$SOURCE_PYTHON")/.." && pwd -P)"
ditto "$SOURCE_PREFIX" "$STAGE"

# Drop development and GUI pieces the worker never loads.
rm -rf "$STAGE/include" "$STAGE/share" "$STAGE/lib/pkgconfig" \
  "$STAGE/lib/$PYTHON_MINOR/config-${PYTHON_VERSION%.*}-darwin" \
  "$STAGE/lib/$PYTHON_MINOR/idlelib" "$STAGE/lib/$PYTHON_MINOR/tkinter" \
  "$STAGE/lib/$PYTHON_MINOR/turtledemo" "$STAGE/lib/$PYTHON_MINOR/turtle.py" \
  "$STAGE/lib/$PYTHON_MINOR/ensurepip"
find "$STAGE/lib" -maxdepth 1 \( -name 'tcl*' -o -name 'tk*' -o -name 'itcl*' \
  -o -name 'thread*' -o -name 'libtcl*' -o -name 'libtk*' \) -exec rm -rf {} +
find "$STAGE/lib/$PYTHON_MINOR/lib-dynload" -name '_tkinter*' -delete
find "$STAGE/lib/$PYTHON_MINOR/site-packages" -maxdepth 1 -name 'pip*' -exec rm -rf {} +

PY="$STAGE/bin/$PYTHON_MINOR"
[ -x "$PY" ] || fail "uv-managed interpreter missing at bin/$PYTHON_MINOR"

# uv patches its absolute install path into libpython and sysconfig data; undo both.
install_name_tool -id "@rpath/lib$PYTHON_MINOR.dylib" "$STAGE/lib/lib$PYTHON_MINOR.dylib" 2>/dev/null
codesign --force --sign - "$STAGE/lib/lib$PYTHON_MINOR.dylib" 2>/dev/null
"$PY" -I -B "$HELPER" neutralize-prefix --runtime "$STAGE" --prefix "$SOURCE_PREFIX"

echo "== Python dependencies (hash-locked, binary wheels only) =="
uv pip install --quiet --python "$PY" --break-system-packages --require-hashes \
  --no-deps --only-binary :all: -r "$LOCK"
uv build --quiet --wheel --out-dir "$WORK/wheel" "$ROOT"
uv pip install --quiet --python "$PY" --break-system-packages --no-deps \
  "$WORK"/wheel/meeting_wiki-*.whl

# Console scripts carry absolute shebangs; the app invokes `python -m` instead.
find "$STAGE/bin" -mindepth 1 ! -name python3 ! -name "$PYTHON_MINOR" -exec rm -f {} +
ln -s "$PYTHON_MINOR" "$STAGE/bin/python"
"$PY" -I -B "$HELPER" normalize-dist-info --site-packages "$STAGE/lib/$PYTHON_MINOR/site-packages"
"$STAGE/bin/python" -I -B -c 'import meeting_wiki, meeting_wiki.cli, google.genai, httpx, mcp'

# Hash-based pyc files never trigger writes into the signed app bundle.
find "$STAGE" -name __pycache__ -type d -prune -exec rm -rf {} +
"$PY" -I -B -m compileall -q -j 0 --invalidation-mode unchecked-hash \
  -s "$STAGE" -p / "$STAGE/lib/$PYTHON_MINOR" >/dev/null

echo "== Audio tools (license and redistribution check) =="
REC_SOURCE="${MEETING_WIKI_REC_BIN:-$(command -v rec || true)}"
SOX_SOURCE="${MEETING_WIKI_SOX_BIN:-$(command -v sox || true)}"
set +e
"$PY" -I -B "$HELPER" audio-plan --rec "$REC_SOURCE" --sox "$SOX_SOURCE" \
  --source-offer "${MEETING_WIKI_GPL_SOURCE_OFFER:-}" --out "$WORK/audio-plan.json"
PLAN_STATUS=$?
set -e
if [ "$PLAN_STATUS" -ne 0 ]; then
  rm -rf "$OUT"
  mkdir -p "$(dirname "$BLOCKED_REPORT")"
  cp "$WORK/audio-plan.json" "$BLOCKED_REPORT"
  cat >&2 <<EOF

prepare-runtime: BLOCKED. The runtime is NOT portable and was not staged.
  Report: $BLOCKED_REPORT
  See docs/portable-runtime.md ("Audio tool redistribution blocker").
EOF
  exit 3
fi
"$PY" -I -B "$HELPER" stage-audio --plan "$WORK/audio-plan.json" --runtime "$STAGE"

echo "== Privacy scan =="
"$PY" -I -B "$HELPER" scan --runtime "$STAGE" \
  --forbid-path "$HOME" --forbid-path "$ROOT" --forbid-path "$WORK" \
  || fail "staged runtime contains private data or host paths"

find "$STAGE" -exec touch -h -d "$EPOCH_STAMP" {} +
"$PY" -I -B "$HELPER" manifest --runtime "$STAGE" --plan "$WORK/audio-plan.json" \
  --python-version "$PYTHON_VERSION" --lock "$LOCK"
touch -h -d "$EPOCH_STAMP" "$STAGE/manifest.json"

RUNTIME_OLD="${OUT}.previous.$$"
rm -rf "$RUNTIME_OLD"
mkdir -p "$(dirname "$OUT")"
if [ -e "$OUT" ]; then
  mv "$OUT" "$RUNTIME_OLD"
fi
mv "$STAGE" "$OUT"
# Finder may recreate .DS_Store inside the old directory. It is no longer
# publish-critical after the atomic swap, so cleanup cannot block the build.
rm -rf "$RUNTIME_OLD" || true
rm -f "$BLOCKED_REPORT"

for tool in python rec sox; do
  [ -x "$OUT/bin/$tool" ] || fail "runtime/bin/$tool missing after staging"
done
"$OUT/bin/python" -I -B -c 'import meeting_wiki'
"$OUT/bin/sox" --version >/dev/null
echo "Runtime staged at $OUT ($(du -sh "$OUT" | cut -f1))"
