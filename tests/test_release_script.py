from __future__ import annotations

import subprocess
from pathlib import Path

SCRIPTS = Path(__file__).parents[1] / "scripts"


def _script(name: str) -> str:
    return (SCRIPTS / name).read_text()


def test_release_script_runs_full_local_verification_before_building_artifacts():
    script = _script("release-macos.sh")

    check_only_exit = script.index('if [ "$CHECK_ONLY" -eq 1 ]; then')
    verification = script.index('"$ROOT/scripts/verify-local.sh"')
    desktop_directory = script.index('cd "$DESKTOP"')

    assert check_only_exit < verification < desktop_directory


def test_release_script_prepares_runtime_before_electron_builder_and_asserts_after():
    script = _script("release-macos.sh")

    check_only_exit = script.index('if [ "$CHECK_ONLY" -eq 1 ]; then')
    verification = script.index('"$ROOT/scripts/verify-local.sh"')
    prepare = script.index('scripts/prepare-runtime-macos.sh"')
    builder = script.index("npx electron-builder --mac dir")
    app_exists = script.index('[ -d "$APP" ] || fail')
    assertion = script.index('scripts/assert-packaged-runtime.sh" "$APP"')
    signature_verification = script.index('verify_signed_app "$APP"', assertion)
    notarize = script.index("xcrun notarytool submit")

    assert check_only_exit < verification < prepare < builder
    assert builder < app_exists < assertion < signature_verification < notarize
    assert script.count("prepare-runtime-macos.sh") == 1


def test_release_check_only_mode_requires_uv_but_never_stages_runtime():
    script = _script("release-macos.sh")
    check_only_exit = script.index('if [ "$CHECK_ONLY" -eq 1 ]; then')

    assert " uv " in script[: script.index("IDENTITY=")]
    assert script.index("prepare-runtime-macos.sh") > check_only_exit


def test_build_script_prepares_runtime_before_electron_builder_and_asserts_after():
    script = _script("build-macos.sh")

    prepare = script.index('scripts/prepare-runtime-macos.sh"')
    npm_ci = script.index("npm ci")
    build = script.index("npm run build")
    assertion = script.index("scripts/assert-packaged-runtime.sh")
    checksums = script.index("shasum -a 256")

    assert prepare < npm_ci < build < assertion < checksums


def test_packaged_runtime_assertion_covers_python_rec_and_sox():
    script = _script("assert-packaged-runtime.sh")

    assert 'RUNTIME="$APP/Contents/Resources/runtime"' in script
    assert "for tool in python rec sox; do" in script
    assert "import meeting_wiki" in script
    assert "SOURCE-OFFER.txt" in script


def test_prepare_runtime_never_reads_user_data_or_models():
    script = _script("prepare-runtime-macos.sh")

    for forbidden in (".meeting-wiki", "config.toml", "MEETING_WIKI_DATA_DIR", "mlx"):
        assert forbidden not in script
    assert "--require-hashes" in script
    assert "--extra gemini" in script
    assert "exit 3" in script


def test_build_script_resigns_local_app_after_electron_builder():
    root = Path(__file__).parents[1]
    build_script = (root / "scripts" / "build-macos.sh").read_text()

    build_after_builder = build_script.index("npm run build")
    build_resign = build_script.index('codesign --force --deep --sign - "$APP"')
    assert build_after_builder < build_resign


def test_release_signs_runtime_inside_out_with_hardened_timestamped_signatures():
    script = _script("release-macos.sh")

    builder = script.index("npx electron-builder --mac dir")
    runtime_sign = script.index('sign_runtime "$APP"')
    outer_sign = script.index(
        "codesign --force --options runtime --timestamp --entitlements", runtime_sign
    )
    verification = script.index('verify_signed_app "$APP"')

    assert builder < runtime_sign < outer_sign < verification
    assert 'codesign --force --deep --sign "$IDENTITY" "$APP"' not in script
    assert 'codesign --force --options runtime --timestamp --sign "$IDENTITY" "$binary"' in script
    assert "codesign --verify --deep --strict" in script
    assert 'codesign -d --entitlements :- "$code"' in script
    assert '"$DESKTOP/entitlements.audio-tool.plist" --sign "$IDENTITY" "$binary"' in script
    assert '[ "$binary" = "$runtime/bin/sox" ] || [ "$binary" = "$runtime/bin/rec" ]' in script
    assert 'verify_entitlements "$app/Contents/Resources/runtime/bin/sox"' in script
    assert 'verify_entitlements "$app/Contents/Resources/runtime/bin/rec"' in script


def test_release_signature_check_matches_codesign_runtime_metadata():
    script = _script("release-macos.sh")
    pattern = r"^CodeDirectory .* flags=0x[0-9a-fA-F]+\([^)]*runtime[^)]*\)"
    metadata = (
        "CodeDirectory v=20500 size=334 flags=0x10000(runtime) hashes=3+7 location=embedded\n"
    )

    assert pattern in script
    result = subprocess.run(["grep", "-Eq", pattern], input=metadata, text=True, check=False)

    assert result.returncode == 0
    for invalid in (
        "CodeDirectory v=20400 size=304 flags=0x2(adhoc) hashes=3+3 location=embedded\n",
        "CodeDirectory v=20500 size=334 flags=0x0(none) hashes=3+7 location=embedded\n",
    ):
        rejected = subprocess.run(["grep", "-Eq", pattern], input=invalid, text=True, check=False)
        assert rejected.returncode == 1


def test_release_passes_unprefixed_identity_to_electron_builder():
    script = _script("release-macos.sh")

    assert 'BUILDER_IDENTITY="${IDENTITY#Developer ID Application: }"' in script
    assert 'CSC_NAME="$BUILDER_IDENTITY" npx electron-builder --mac dir' in script
    assert 'CSC_NAME="$IDENTITY" npx electron-builder --mac dir' not in script


def test_release_preflight_gates_run_before_check_only_exit():
    script = _script("release-macos.sh")
    check_only_exit = script.index('if [ "$CHECK_ONLY" -eq 1 ]; then')

    source_identity = script.index('"$INTEGRITY" preflight --mode "$MODE"')
    source_offer = script.index('[ -s "$SOURCE_OFFER" ] || fail')
    identity = script.index('[ -n "$IDENTITY" ] || fail')
    notary = script.index("xcrun notarytool history")

    assert source_identity < source_offer < identity < notary < check_only_exit


def test_release_defaults_to_tagged_mode_and_candidate_is_explicit():
    script = _script("release-macos.sh")

    assert "MODE=release\n" in script
    assert "--candidate) MODE=candidate ;;" in script
    assert '*) echo "usage:' in script


def test_release_signs_and_assesses_the_dmg_before_publication():
    script = _script("release-macos.sh")

    created = script.index("hdiutil create \\\n")
    signed = script.index('codesign --force --timestamp --sign "$IDENTITY" "$FINAL_DMG"')
    notarized = script.index('xcrun notarytool submit "$FINAL_DMG"')
    stapled = script.index('xcrun stapler staple "$FINAL_DMG"')
    assessed = script.index(
        "spctl --assess --type open --context context:primary-signature --verbose=4"
    )

    assert created < signed < notarized < stapled < assessed


def test_release_inspects_build_zip_and_dmg_before_checksums():
    script = _script("release-macos.sh")

    build_inspect = script.index('inspect_app "$APP"')
    notarize = script.index("xcrun notarytool submit")
    zip_inspect = script.index('inspect_app "$INSPECT_DIR/zip/Meeting Wiki.app"')
    dmg_inspect = script.index('inspect_app "$INSPECT_DIR/dmg/Meeting Wiki.app"')
    manifest = script.index('"$INTEGRITY" manifest --mode "$MODE"')
    checksums = script.index("> SHA256SUMS")

    assert build_inspect < notarize < zip_inspect < dmg_inspect < manifest < checksums
    assert '"$(basename "$MANIFEST")" > SHA256SUMS' in script


def test_release_inspection_covers_inventory_scan_and_source_offer():
    script = _script("release-macos.sh")
    start = script.index("inspect_app() {")
    body = script[start : script.index("\n}\n", start)]

    assert '"$INTEGRITY" inventory --app "$app"' in body
    assert '--forbid-path "$HOME" --forbid-path "$ROOT"' in body
    assert '"$INTEGRITY" source-offer --app "$app"' in body


def test_local_build_inspects_inventory_and_privacy():
    script = _script("build-macos.sh")

    assertion = script.index("scripts/assert-packaged-runtime.sh")
    inventory = script.index('release_integrity.py" inventory')
    scan = script.index('release_integrity.py" scan')

    assert assertion < inventory < scan < script.index("shasum -a 256")
