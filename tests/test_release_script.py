from __future__ import annotations

from pathlib import Path


def test_release_script_runs_full_local_verification_before_building_artifacts():
    script = (Path(__file__).parents[1] / "scripts" / "release-macos.sh").read_text()

    check_only_exit = script.index('if [ "$CHECK_ONLY" -eq 1 ]; then')
    verification = script.index('"$ROOT/scripts/verify-local.sh"')
    desktop_directory = script.index('cd "$DESKTOP"')

    assert check_only_exit < verification < desktop_directory
