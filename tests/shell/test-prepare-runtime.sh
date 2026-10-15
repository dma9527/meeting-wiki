#!/usr/bin/env bash
# Exercises scripts/prepare-runtime-macos.sh end to end on Apple Silicon.
# Writes only under a temp dir; never touches desktop/runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
PREPARE="$ROOT/scripts/prepare-runtime-macos.sh"
HELPER="$ROOT/scripts/runtime_manifest.py"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/meeting-wiki-runtime-test.XXXXXX")"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
PASSED=0

pass() { PASSED=$((PASSED + 1)); echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

if [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]; then
  echo "skip - Apple Silicon macOS required"
  exit 0
fi

OFFER="$SCRATCH/SOURCE-OFFER.txt"
echo "Test fixture: written offer of corresponding source." > "$OFFER"

# 1. Copyleft audio tools without a source offer must fail loud and stage nothing.
OUT="$SCRATCH/blocked/runtime"
mkdir -p "$OUT/bin" && echo stale > "$OUT/bin/python"
set +e
LOG="$(env -u MEETING_WIKI_GPL_SOURCE_OFFER MEETING_WIKI_RUNTIME_OUT="$OUT" bash "$PREPARE" 2>&1)"
STATUS=$?
set -e
[ "$STATUS" -eq 3 ] || fail "missing source offer should exit 3 (got $STATUS)"
grep -q "BLOCKED" <<<"$LOG" || fail "blocked run should say BLOCKED"
grep -q "MEETING_WIKI_GPL_SOURCE_OFFER" <<<"$LOG" || fail "blocked run should name the fix"
[ ! -e "$OUT" ] || fail "blocked run must remove any stale runtime"
grep -q '"status": "blocked"' "$OUT.blocked.json" || fail "blocked report missing"
pass "copyleft tools without a source offer are blocked"

# 2. A tool whose license cannot be verified (not a Homebrew keg) is blocked.
OUT="$SCRATCH/unverified/runtime"
set +e
LOG="$(MEETING_WIKI_SOX_BIN=/bin/ls MEETING_WIKI_GPL_SOURCE_OFFER="$OFFER" \
  MEETING_WIKI_RUNTIME_OUT="$OUT" bash "$PREPARE" 2>&1)"
STATUS=$?
set -e
[ "$STATUS" -eq 3 ] || fail "unverifiable sox should exit 3 (got $STATUS)"
grep -q "cannot be verified" <<<"$LOG" || fail "unverifiable tool should explain why"
[ ! -e "$OUT" ] || fail "unverifiable run must not stage a runtime"
pass "audio tools outside a Homebrew keg are blocked"

# 3. Successful staging produces the expected layout and manifest.
OUT="$SCRATCH/first/runtime"
MEETING_WIKI_GPL_SOURCE_OFFER="$OFFER" MEETING_WIKI_RUNTIME_OUT="$OUT" bash "$PREPARE" >/dev/null
for tool in python rec sox; do
  [ -x "$OUT/bin/$tool" ] || fail "runtime/bin/$tool missing"
done
grep -q '"status": "ok"' "$OUT/manifest.json" || fail "manifest audio status not ok"
grep -q '"redistribution": "copyleft' "$OUT/manifest.json" || fail "manifest lacks redistribution notes"
grep -q '"name": "meeting-wiki"' "$OUT/manifest.json" || fail "manifest lacks meeting-wiki"
grep -q '"name": "google-genai"' "$OUT/manifest.json" || fail "manifest lacks online provider deps"
[ -s "$OUT/licenses/SOURCE-OFFER.txt" ] || fail "source offer not shipped"
[ -n "$(find "$OUT/licenses" -path '*sox-*' -name 'LICENSE.GPL')" ] || fail "SoX GPL text not shipped"
if grep -q "$HOME" "$OUT/manifest.json"; then fail "manifest leaks the home path"; fi
pass "runtime layout, licenses, and manifest"

# 4. Nothing private, secret, or model-sized ships.
"$OUT/bin/python" -I -B "$HELPER" scan --runtime "$OUT" --forbid-path "$HOME" --forbid-path "$ROOT" \
  || fail "privacy scan found private content"
for pattern in 'config.toml' '*.db' '*.wav' '*.safetensors' '*.gguf' '*.key' '.env*'; do
  [ -z "$(find "$OUT" -name "$pattern" -print -quit)" ] || fail "runtime contains $pattern"
done
[ -z "$(find "$OUT" -name '*.dist-info' -path '*mlx*' -print -quit)" ] || fail "local model stack shipped"
pass "privacy scan"

# 5. Relocated runtime works with no Homebrew, repo, venv, or uv on PATH.
MOVED="$SCRATCH/relocated/Meeting Wiki.app/Contents/Resources/runtime"
mkdir -p "$(dirname "$MOVED")"
ditto "$OUT" "$MOVED"
CLEAN_ENV=(env -i HOME="$SCRATCH/home" PATH=/usr/bin:/bin TMPDIR="$SCRATCH")
cd "$SCRATCH"  # keep the repo checkout off sys.path
"${CLEAN_ENV[@]}" "$MOVED/bin/python" -c 'import meeting_wiki' || fail "relocated import meeting_wiki"
"${CLEAN_ENV[@]}" "$MOVED/bin/python" -c \
  'import sys, meeting_wiki, google.genai, httpx, mcp, pydantic_core, cryptography.fernet
assert sys.prefix.endswith("Resources/runtime"), sys.prefix
assert meeting_wiki.__file__.startswith(sys.prefix), meeting_wiki.__file__' \
  || fail "relocated runtime resolves outside itself"
"${CLEAN_ENV[@]}" "$MOVED/bin/sox" -n -r 16000 -c 1 "$SCRATCH/tone.flac" synth 0.05 sine 440 \
  || fail "relocated sox cannot encode FLAC"
"${CLEAN_ENV[@]}" "$MOVED/bin/rec" --version >/dev/null || fail "relocated rec does not run"
for binary in "$MOVED/bin/python3.12" "$MOVED/bin/sox" "$MOVED"/lib/*.dylib; do
  if otool -L "$binary" | tail -n +2 | grep -Eq '/opt/homebrew|/usr/local|/Users/'; then
    fail "$(basename "$binary") links outside the runtime"
  fi
done
[ -z "$(find "$MOVED" -name __pycache__ -newer "$OUT/manifest.json" -print -quit)" ] \
  || fail "importing wrote bytecode into the runtime"
pass "relocated runtime imports meeting_wiki and runs rec/sox"

# 6. Staging is deterministic.
SECOND="$SCRATCH/second/runtime"
MEETING_WIKI_GPL_SOURCE_OFFER="$OFFER" MEETING_WIKI_RUNTIME_OUT="$SECOND" bash "$PREPARE" >/dev/null
FIRST_DIGEST="$("$OUT/bin/python" -I -B "$HELPER" digest --runtime "$OUT")"
SECOND_DIGEST="$("$OUT/bin/python" -I -B "$HELPER" digest --runtime "$SECOND")"
[ "$FIRST_DIGEST" = "$SECOND_DIGEST" ] || fail "two staging runs differ"
cmp -s "$OUT/manifest.json" "$SECOND/manifest.json" || fail "manifests differ between runs"
pass "deterministic tree ($FIRST_DIGEST)"

echo "$PASSED passed"
