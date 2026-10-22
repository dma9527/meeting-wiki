#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Stage desktop/runtime first; electron-builder copies it to Resources/runtime.
bash "$ROOT/scripts/prepare-runtime-macos.sh"

cd "$ROOT/desktop"
npm ci
npm test
npm run build

APP="dist/mac-$(uname -m)/Meeting Wiki.app"
[ -d "$APP" ] || { echo "Build failed: app bundle is missing" >&2; exit 1; }
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
bash "$ROOT/scripts/assert-packaged-runtime.sh" "$APP"
python3 "$ROOT/scripts/release_integrity.py" inventory --app "$APP"
python3 "$ROOT/scripts/release_integrity.py" scan --app "$APP" \
  --forbid-path "$HOME" --forbid-path "$ROOT"

# This path is for local development artifacts. electron-builder may apply an
# ad-hoc signature when no Developer ID identity is available. Never publish
# these files as a release; use release-macos.sh for signing and notarization.
cd dist
shasum -a 256 ./*.dmg ./*.zip 2>/dev/null > SHA256SUMS || true
echo "Built artifacts under $ROOT/desktop/dist"
