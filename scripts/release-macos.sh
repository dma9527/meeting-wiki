#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/desktop"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

fail() {
  echo "Release preflight failed: $1" >&2
  exit 1
}

for command in node npm python3 security codesign xcrun ditto hdiutil spctl shasum; do
  command -v "$command" >/dev/null || fail "$command is required"
done

IDENTITY="${CSC_NAME:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -1)"
fi
[ -n "$IDENTITY" ] || fail "install a Developer ID Application certificate and private key"
security find-identity -v -p codesigning 2>/dev/null \
  | grep -Fq "\"$IDENTITY\"" \
  || fail "Developer ID identity is not valid in the current keychain"

NOTARY_ARGS=()
if [ -n "${APPLE_NOTARY_PROFILE:-}" ]; then
  NOTARY_ARGS=(--keychain-profile "$APPLE_NOTARY_PROFILE")
else
  : "${APPLE_API_KEY_PATH:?Set APPLE_NOTARY_PROFILE or APPLE_API_KEY_PATH}"
  : "${APPLE_API_KEY_ID:?Set APPLE_API_KEY_ID}"
  : "${APPLE_API_ISSUER:?Set APPLE_API_ISSUER}"
  [ -f "$APPLE_API_KEY_PATH" ] || fail "APPLE_API_KEY_PATH does not exist"
  NOTARY_ARGS=(
    --key "$APPLE_API_KEY_PATH"
    --key-id "$APPLE_API_KEY_ID"
    --issuer "$APPLE_API_ISSUER"
  )
fi

xcrun notarytool history "${NOTARY_ARGS[@]}" >/dev/null \
  || fail "notarytool credentials are invalid or unavailable"

echo "Developer ID identity ready: $IDENTITY"
echo "Notarization credentials ready."
DESKTOP_VERSION="$(node -p "require('$DESKTOP/package.json').version")"
PYTHON_VERSION="$(python3 - "$ROOT/pyproject.toml" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as source:
    print(tomllib.load(source)["project"]["version"])
PY
)"
[ "$DESKTOP_VERSION" = "$PYTHON_VERSION" ] \
  || fail "version mismatch: desktop=$DESKTOP_VERSION python=$PYTHON_VERSION"
echo "Package versions match: $DESKTOP_VERSION"
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "Release preflight passed."
  exit 0
fi

cd "$DESKTOP"
VERSION="$DESKTOP_VERSION"
ARCH="$(uname -m)"
APP="dist/mac-$ARCH/Meeting Wiki.app"
RELEASE_DIR="dist/release"
SUBMISSION_ZIP="dist/Meeting-Wiki-notarization.zip"
STAGING_DIR="dist/dmg-staging"
FINAL_ZIP="$RELEASE_DIR/Meeting-Wiki-$VERSION-$ARCH.zip"
FINAL_DMG="$RELEASE_DIR/Meeting-Wiki-$VERSION-$ARCH.dmg"

rm -rf "$APP" "$RELEASE_DIR" "$SUBMISSION_ZIP" "$STAGING_DIR"
mkdir -p "$RELEASE_DIR"

npm ci
npm test
CSC_NAME="$IDENTITY" npx electron-builder --mac dir
[ -d "$APP" ] || fail "electron-builder did not create $APP"

codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --verbose=4 "$APP" 2>&1 | grep -q 'flags=.*runtime' \
  || fail "hardened runtime is not present"

ditto -c -k --sequesterRsrc --keepParent "$APP" "$SUBMISSION_ZIP"
xcrun notarytool submit "$SUBMISSION_ZIP" "${NOTARY_ARGS[@]}" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

rm -f "$FINAL_ZIP" "$FINAL_DMG"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$FINAL_ZIP"
mkdir -p "$STAGING_DIR"
ditto "$APP" "$STAGING_DIR/Meeting Wiki.app"
ln -s /Applications "$STAGING_DIR/Applications"
hdiutil create \
  -volname "Meeting Wiki" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$FINAL_DMG" >/dev/null

xcrun notarytool submit "$FINAL_DMG" "${NOTARY_ARGS[@]}" --wait
xcrun stapler staple "$FINAL_DMG"
xcrun stapler validate "$FINAL_DMG"

codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose=4 "$APP"
(
  cd "$RELEASE_DIR"
  shasum -a 256 "$(basename "$FINAL_DMG")" "$(basename "$FINAL_ZIP")" > SHA256SUMS
)

rm -rf "$SUBMISSION_ZIP" "$STAGING_DIR"
echo "Signed and notarized artifacts: $RELEASE_DIR"
