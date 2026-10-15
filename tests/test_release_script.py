from __future__ import annotations

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
    first_codesign = script.index("codesign --verify")
    notarize = script.index("xcrun notarytool submit")

    assert check_only_exit < verification < prepare < builder
    assert builder < app_exists < assertion < first_codesign < notarize
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
