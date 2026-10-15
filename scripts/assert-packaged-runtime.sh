#!/usr/bin/env bash
# Fail unless an electron-builder .app carries a working bundled runtime.
set -euo pipefail

APP="${1:?usage: assert-packaged-runtime.sh 'path/to/Meeting Wiki.app'}"
[ -d "$APP" ] || { echo "Packaged runtime check failed: $APP does not exist" >&2; exit 1; }
APP="$(cd "$APP" && pwd -P)"
RUNTIME="$APP/Contents/Resources/runtime"

fail() {
  echo "Packaged runtime check failed: $1" >&2
  exit 1
}

for tool in python rec sox; do
  [ -x "$RUNTIME/bin/$tool" ] || fail "runtime/bin/$tool is missing from $APP"
done
[ -f "$RUNTIME/manifest.json" ] || fail "runtime/manifest.json is missing"
[ -s "$RUNTIME/licenses/SOURCE-OFFER.txt" ] || fail "runtime/licenses/SOURCE-OFFER.txt is missing"

# Run outside the checkout so the repo cannot shadow the bundled package.
cd /
env -i HOME="${TMPDIR:-/tmp}" PATH=/usr/bin:/bin "$RUNTIME/bin/python" -I -B -c 'import meeting_wiki' \
  || fail "bundled python cannot import meeting_wiki"
env -i PATH=/usr/bin:/bin "$RUNTIME/bin/sox" --version >/dev/null \
  || fail "bundled sox does not run"
env -i PATH=/usr/bin:/bin "$RUNTIME/bin/rec" --version >/dev/null \
  || fail "bundled rec does not run"
echo "Packaged runtime OK: $RUNTIME"
