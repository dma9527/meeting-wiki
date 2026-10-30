#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Stage desktop/runtime first; electron-builder copies it to Resources/runtime.
bash "$ROOT/scripts/prepare-runtime-macos.sh"

cd "$ROOT/desktop"
npm ci
npm test
# Build only the app bundle. The DMG and ZIP are made from the signed bundle below, so they
# never carry the unsealed bundle electron-builder leaves without a Developer ID identity.
npx electron-builder --mac dir
rm -f dist/builder-debug.yml
VERSION="$(node -p "require('./package.json').version")"
ARCH="$(uname -m)"
APP="dist/mac-$ARCH/Meeting Wiki.app"
ZIP="dist/Meeting Wiki-$VERSION-$ARCH-mac.zip"
DMG="dist/Meeting Wiki-$VERSION-$ARCH.dmg"
INSPECT_DIR="$ROOT/desktop/dist/build-inspect"
[ -d "$APP" ] || { echo "Build failed: app bundle is missing" >&2; exit 1; }
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
bash "$ROOT/scripts/assert-packaged-runtime.sh" "$APP"
python3 "$ROOT/scripts/release_integrity.py" inventory --app "$APP"
python3 "$ROOT/scripts/release_integrity.py" scan --app "$APP" \
  --forbid-path "$HOME" --forbid-path "$ROOT"

rm -rf "$ZIP" "$DMG" "$ZIP.blockmap" "$DMG.blockmap" "$INSPECT_DIR"
rm -rf dist/dmg-staging 2>/dev/null || true  # left by older builds; Finder may still hold it
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
# Stage outside dist/ so an open Finder window cannot add .DS_Store to the DMG or block cleanup.
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/meeting-wiki-dmg.XXXXXX")"
ditto "$APP" "$STAGING_DIR/Meeting Wiki.app"
ln -s /Applications "$STAGING_DIR/Applications"
hdiutil create -volname "Meeting Wiki" -srcfolder "$STAGING_DIR" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGING_DIR"

# Verify the copies a user installs, not only the build bundle.
mkdir -p "$INSPECT_DIR/zip" "$INSPECT_DIR/dmg"
trap 'hdiutil detach "$INSPECT_DIR/dmg" >/dev/null 2>&1 || true; rm -rf "$INSPECT_DIR"' EXIT
ditto -x -k "$ZIP" "$INSPECT_DIR/zip"
codesign --verify --deep --strict --verbose=2 "$INSPECT_DIR/zip/Meeting Wiki.app"
hdiutil attach -readonly -nobrowse -mountpoint "$INSPECT_DIR/dmg" "$DMG" >/dev/null
codesign --verify --deep --strict --verbose=2 "$INSPECT_DIR/dmg/Meeting Wiki.app"
hdiutil detach "$INSPECT_DIR/dmg" >/dev/null
rm -rf "$INSPECT_DIR"
trap - EXIT
# This path is for local development artifacts. They are ad-hoc signed and not notarized.
# Never publish these files as a release; use release-macos.sh for signing and notarization.
cd dist
shasum -a 256 "./$(basename "$DMG")" "./$(basename "$ZIP")" > SHA256SUMS
echo "Built artifacts under $ROOT/desktop/dist"
