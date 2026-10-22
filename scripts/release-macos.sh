#!/usr/bin/env bash
# Signed, notarized macOS release. Fails closed on every release-integrity gate.
# Usage: release-macos.sh [--check] [--candidate]
#   --check      run every preflight gate, then stop before building
#   --candidate  build an untagged release candidate (manifest marks it unpublishable)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/desktop"
INTEGRITY="$ROOT/scripts/release_integrity.py"
CHECK_ONLY=0
MODE=release
for argument in "$@"; do
  case "$argument" in
    --check) CHECK_ONLY=1 ;;
    --candidate) MODE=candidate ;;
    *) echo "usage: release-macos.sh [--check] [--candidate]" >&2; exit 2 ;;
  esac
done

fail() {
  echo "Release preflight failed: $1" >&2
  exit 1
}

for command in node npm python3 uv git security codesign xcrun ditto hdiutil spctl shasum file; do
  command -v "$command" >/dev/null || fail "$command is required"
done

# Gate 1: clean tree, committed version parity, exact annotated tag (or explicit candidate).
python3 "$INTEGRITY" preflight --mode "$MODE" || fail "source identity is not releasable"

# Gate 2: corresponding-source offer for bundled GPL/LGPL audio tools. The release owner
# supplies this file; the script never writes or assumes one.
SOURCE_OFFER="${MEETING_WIKI_GPL_SOURCE_OFFER:-}"
[ -n "$SOURCE_OFFER" ] || fail "set MEETING_WIKI_GPL_SOURCE_OFFER (see docs/portable-runtime.md)"
[ -s "$SOURCE_OFFER" ] || fail "MEETING_WIKI_GPL_SOURCE_OFFER is not a non-empty file"

# Gate 3: Developer ID Application identity.
IDENTITY="${CSC_NAME:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -1)"
fi
[ -n "$IDENTITY" ] || fail "install a Developer ID Application certificate and private key"
case "$IDENTITY" in
  "Developer ID Application: "*) ;;
  *) fail "CSC_NAME must be a Developer ID Application identity" ;;
esac
BUILDER_IDENTITY="${IDENTITY#Developer ID Application: }"
security find-identity -v -p codesigning 2>/dev/null \
  | grep -Fq "\"$IDENTITY\"" \
  || fail "Developer ID identity is not valid in the current keychain"

# Gate 4: notarization credentials.
NOTARY_ARGS=()
if [ -n "${APPLE_NOTARY_PROFILE:-}" ]; then
  NOTARY_ARGS=(--keychain-profile "$APPLE_NOTARY_PROFILE")
else
  [ -n "${APPLE_API_KEY_PATH:-}" ] || fail "set APPLE_NOTARY_PROFILE or APPLE_API_KEY_PATH"
  [ -n "${APPLE_API_KEY_ID:-}" ] || fail "set APPLE_API_KEY_ID"
  [ -n "${APPLE_API_ISSUER:-}" ] || fail "set APPLE_API_ISSUER"
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
echo "Source offer ready."
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "Release preflight passed ($MODE)."
  exit 0
fi

"$ROOT/scripts/verify-local.sh"
MEETING_WIKI_GPL_SOURCE_OFFER="$SOURCE_OFFER" bash "$ROOT/scripts/prepare-runtime-macos.sh"

cd "$DESKTOP"
VERSION="$(node -p "require('./package.json').version")"
ARCH="$(uname -m)"
APP="dist/mac-$ARCH/Meeting Wiki.app"
RELEASE_DIR="dist/release"
SUBMISSION_ZIP="dist/Meeting-Wiki-notarization.zip"
STAGING_DIR="dist/dmg-staging"
INSPECT_DIR="dist/release-inspect"
FINAL_ZIP="$RELEASE_DIR/Meeting-Wiki-$VERSION-$ARCH.zip"
FINAL_DMG="$RELEASE_DIR/Meeting-Wiki-$VERSION-$ARCH.dmg"
MANIFEST="$RELEASE_DIR/release-manifest.json"

rm -rf "$APP" "$RELEASE_DIR" "$SUBMISSION_ZIP" "$STAGING_DIR" "$INSPECT_DIR"
mkdir -p "$RELEASE_DIR"

# Inventory, privacy scan, and source-offer parity for one unpacked copy of the app.
inspect_app() {
  local app="$1"
  python3 "$INTEGRITY" inventory --app "$app" || fail "declared resources missing from $app"
  python3 "$INTEGRITY" scan --app "$app" --forbid-path "$HOME" --forbid-path "$ROOT" \
    || fail "$app contains user data, secrets, or local paths"
  python3 "$INTEGRITY" source-offer --app "$app" --source-offer "$SOURCE_OFFER" \
    || fail "$app source offer does not match MEETING_WIKI_GPL_SOURCE_OFFER"
}

sign_runtime() {
  local app="$1"
  local runtime="$app/Contents/Resources/runtime"
  local count=0
  local binary
  while IFS= read -r -d '' binary; do
    if file -b "$binary" | grep -q 'Mach-O'; then
      if [ "$binary" = "$runtime/bin/sox" ] || [ "$binary" = "$runtime/bin/rec" ]; then
        codesign --force --options runtime --timestamp --entitlements \
          "$DESKTOP/entitlements.audio-tool.plist" --sign "$IDENTITY" "$binary"
      else
        codesign --force --options runtime --timestamp --sign "$IDENTITY" "$binary"
      fi
      count=$((count + 1))
    fi
  done < <(find "$runtime" -type f -print0)
  [ "$count" -gt 0 ] || fail "packaged runtime contains no Mach-O files to sign"
}

verify_signed_code() {
  local code="$1"
  local team_id="$2"
  local metadata
  metadata="$(codesign -d --verbose=4 "$code" 2>&1)" || fail "cannot inspect signature for $code"
  grep -q '^Authority=Developer ID Application:' <<<"$metadata" \
    || fail "$code is not signed with Developer ID Application"
  grep -q "^TeamIdentifier=$team_id$" <<<"$metadata" \
    || fail "$code is signed by a different team"
  grep -Eq '^CodeDirectory .* flags=0x[0-9a-fA-F]+\([^)]*runtime[^)]*\)' <<<"$metadata" \
    || fail "$code lacks hardened runtime"
  grep -q '^Timestamp=' <<<"$metadata" || fail "$code lacks a secure timestamp"
}

verify_entitlements() {
  local code="$1"
  shift
  local entitlements
  entitlements="$(mktemp "${TMPDIR:-/tmp}/meeting-wiki-entitlements.XXXXXX")"
  if ! codesign -d --entitlements :- "$code" >"$entitlements" 2>/dev/null; then
    rm -f "$entitlements"
    fail "cannot extract entitlements for $code"
  fi
  if ! python3 - "$entitlements" "$@" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    entitlements = plistlib.load(source)
for key in sys.argv[2:]:
    if entitlements.get(key) is not True:
        raise SystemExit(f"missing entitlement: {key}")
PY
  then
    rm -f "$entitlements"
    fail "$code entitlements are incomplete"
  fi
  rm -f "$entitlements"
}

verify_signed_app() {
  local app="$1"
  local metadata
  local team_id
  local binary
  local count=0
  codesign --verify --deep --strict --verbose=2 "$app"
  metadata="$(codesign -d --verbose=4 "$app" 2>&1)" || fail "cannot inspect app signature"
  team_id="$(sed -n 's/^TeamIdentifier=//p' <<<"$metadata")"
  [ -n "$team_id" ] && [ "$team_id" != "not set" ] || fail "app signature has no team identifier"
  verify_signed_code "$app" "$team_id"
  while IFS= read -r -d '' binary; do
    if file -b "$binary" | grep -q 'Mach-O'; then
      verify_signed_code "$binary" "$team_id"
      count=$((count + 1))
    fi
  done < <(find "$app/Contents/Resources/runtime" -type f -print0)
  [ "$count" -gt 0 ] || fail "packaged runtime contains no signed Mach-O files"

  verify_entitlements "$app" \
    "com.apple.security.cs.allow-jit" \
    "com.apple.security.device.audio-input"
  verify_entitlements "$app/Contents/Resources/runtime/bin/sox" \
    "com.apple.security.device.audio-input"
  verify_entitlements "$app/Contents/Resources/runtime/bin/rec" \
    "com.apple.security.device.audio-input"
}

npm ci
npm test
CSC_NAME="$BUILDER_IDENTITY" npx electron-builder --mac dir
[ -d "$APP" ] || fail "electron-builder did not create $APP"

# Sign runtime Mach-O leaves first, then seal the outer app. Electron Builder signs its own
# frameworks and helpers before this point; signing with --deep here would replace that work.
sign_runtime "$APP"
codesign --force --options runtime --timestamp --entitlements \
  "$DESKTOP/entitlements.mac.plist" --sign "$IDENTITY" "$APP"
bash "$ROOT/scripts/assert-packaged-runtime.sh" "$APP"
inspect_app "$APP"
verify_signed_app "$APP"

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
codesign --force --timestamp --sign "$IDENTITY" "$FINAL_DMG"
codesign --verify --verbose=2 "$FINAL_DMG"

xcrun notarytool submit "$FINAL_DMG" "${NOTARY_ARGS[@]}" --wait
xcrun stapler staple "$FINAL_DMG"
xcrun stapler validate "$FINAL_DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$FINAL_DMG"

codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose=4 "$APP"

# Inspect the final ZIP and DMG contents, not only the build directory.
mkdir -p "$INSPECT_DIR/zip" "$INSPECT_DIR/dmg"
ditto -x -k "$FINAL_ZIP" "$INSPECT_DIR/zip"
inspect_app "$INSPECT_DIR/zip/Meeting Wiki.app"
verify_signed_app "$INSPECT_DIR/zip/Meeting Wiki.app"
spctl --assess --type execute --verbose=4 "$INSPECT_DIR/zip/Meeting Wiki.app"
hdiutil attach -readonly -nobrowse -mountpoint "$INSPECT_DIR/dmg" "$FINAL_DMG" >/dev/null
trap 'hdiutil detach "$INSPECT_DIR/dmg" >/dev/null 2>&1 || true' EXIT
DMG_ENTRIES="$(ls -A "$INSPECT_DIR/dmg" | grep -v '^\.' | sort | tr '\n' ',')"
[ "$DMG_ENTRIES" = "Applications,Meeting Wiki.app," ] \
  || fail "DMG has unexpected top-level entries: $DMG_ENTRIES"
inspect_app "$INSPECT_DIR/dmg/Meeting Wiki.app"
verify_signed_app "$INSPECT_DIR/dmg/Meeting Wiki.app"
spctl --assess --type execute --verbose=4 "$INSPECT_DIR/dmg/Meeting Wiki.app"
hdiutil detach "$INSPECT_DIR/dmg" >/dev/null
trap - EXIT

# The manifest re-runs the source preflight, so a tree dirtied by the build fails here.
python3 "$INTEGRITY" manifest --mode "$MODE" --app "$APP" \
  --artifact "$FINAL_DMG" --artifact "$FINAL_ZIP" \
  --source-offer "$SOURCE_OFFER" --out "$MANIFEST" \
  || fail "release manifest could not be written"
(
  cd "$RELEASE_DIR"
  shasum -a 256 "$(basename "$FINAL_DMG")" "$(basename "$FINAL_ZIP")" \
    "$(basename "$MANIFEST")" > SHA256SUMS
)

rm -rf "$SUBMISSION_ZIP" "$STAGING_DIR" "$INSPECT_DIR"
if [ "$MODE" = candidate ]; then
  echo "Signed and notarized RELEASE CANDIDATE (not publishable): $RELEASE_DIR"
else
  echo "Signed and notarized artifacts: $RELEASE_DIR"
fi
