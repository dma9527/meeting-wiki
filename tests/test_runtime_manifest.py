from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "runtime_manifest", Path(__file__).parents[1] / "scripts" / "runtime_manifest.py"
)
runtime_manifest = importlib.util.module_from_spec(_SPEC)
sys.modules["runtime_manifest"] = runtime_manifest
_SPEC.loader.exec_module(runtime_manifest)


@pytest.mark.parametrize(
    ("expression", "category"),
    [
        ("BSD-3-Clause", "permissive"),
        ("libpng-2.0", "permissive"),
        ("GPL-2.0-or-later AND LGPL-2.1-or-later", "copyleft"),
        ("LGPL-2.1-only", "copyleft"),
        ("BSD-3-Clause AND (GPL-2.0-or-later OR LGPL-2.1-or-later)", "copyleft"),
        ("LicenseRef-Proprietary", "unknown"),
        ("BSD-3-Clause AND LicenseRef-Proprietary", "unknown"),
        (None, "unknown"),
        ("", "unknown"),
    ],
)
def test_classify_license(expression, category):
    assert runtime_manifest.classify_license(expression)[0] == category


def test_keg_for_recognizes_homebrew_cellar_paths_only():
    keg = runtime_manifest.keg_for("/opt/homebrew/Cellar/sox/14.4.2_6/bin/sox")
    assert keg == ("sox", "14.4.2_6", Path("/opt/homebrew/Cellar/sox/14.4.2_6"))
    assert runtime_manifest.keg_for("/usr/local/bin/sox") is None


def test_plan_blocks_missing_tools_without_inspecting_anything():
    plan = runtime_manifest.plan_audio_tools(
        {"rec": "", "sox": ""}, None, licenses_lookup=lambda formulas: {}
    )
    assert plan["status"] == "blocked"
    assert any("MEETING_WIKI_REC_BIN" in blocker for blocker in plan["blockers"])
    assert any("MEETING_WIKI_SOX_BIN" in blocker for blocker in plan["blockers"])


def test_plan_blocks_non_executable_tool(tmp_path):
    fake = tmp_path / "sox"
    fake.write_text("not a binary")
    plan = runtime_manifest.plan_audio_tools(
        {"rec": str(fake), "sox": str(fake)}, None, licenses_lookup=lambda formulas: {}
    )
    assert plan["status"] == "blocked"
    assert all("not an executable file" in blocker for blocker in plan["blockers"])


def test_scan_flags_user_data_secrets_models_and_host_paths(tmp_path):
    runtime = tmp_path / "runtime"
    (runtime / "lib" / "site-packages" / "pkg").mkdir(parents=True)
    (runtime / "wiki").mkdir()
    (runtime / "lib" / "config.toml").write_text("[llm]\n")
    (runtime / "lib" / "whisper.safetensors").write_bytes(b"\0")
    (runtime / "lib" / "leak.txt").write_text("/Users/someone/private")
    (runtime / "lib" / "token.txt").write_text("key=sk-" + "a" * 40)
    (runtime / "lib" / "site-packages" / "pkg" / "credentials.py").write_text("x = 1\n")

    findings = runtime_manifest.scan_runtime(runtime, ["/Users/someone"])

    assert "forbidden data directory: wiki/" in findings
    assert "private file: lib/config.toml" in findings
    assert "private or model artifact: lib/whisper.safetensors" in findings
    assert "host path leak in lib/leak.txt" in findings
    assert "secret-like content in lib/token.txt" in findings
    assert not any("credentials.py" in finding for finding in findings)


def test_normalize_dist_info_drops_pruned_records_and_installer_cache(tmp_path):
    site = tmp_path / "site-packages"
    dist = site / "demo-1.0.dist-info"
    dist.mkdir(parents=True)
    (site / "demo.py").write_text("")
    (dist / "uv_cache.json").write_text("{}")
    (dist / "direct_url.json").write_text("{}")
    (dist / "RECORD").write_text(
        "demo.py,sha256=abc,0\n../../../bin/demo,sha256=def,10\ndemo-1.0.dist-info/RECORD,,\n"
    )

    runtime_manifest.normalize_dist_info(site)

    assert not (dist / "uv_cache.json").exists()
    assert not (dist / "direct_url.json").exists()
    assert (dist / "RECORD").read_text() == "demo.py,sha256=abc,0\ndemo-1.0.dist-info/RECORD,,\n"


def test_installed_packages_records_retained_license_files(tmp_path):
    site = tmp_path / "site-packages"
    dist = site / "demo-1.0.dist-info"
    licenses = dist / "licenses"
    licenses.mkdir(parents=True)
    (dist / "METADATA").write_text("Name: demo\nVersion: 1.0\nLicense-Expression: MIT\n\n")
    (licenses / "LICENSE.txt").write_text("license\n")

    assert runtime_manifest.installed_packages(site) == [
        {
            "name": "demo",
            "version": "1.0",
            "license": "MIT",
            "license_files": ["demo-1.0.dist-info/licenses/LICENSE.txt"],
        }
    ]


def test_tree_digest_ignores_manifest_and_mtimes_but_tracks_content(tmp_path):
    (tmp_path / "bin").mkdir()
    (tmp_path / "bin" / "tool").write_text("one")
    baseline = runtime_manifest.tree_digest(tmp_path)

    (tmp_path / "manifest.json").write_text("{}")
    assert runtime_manifest.tree_digest(tmp_path) == baseline

    (tmp_path / "bin" / "tool").write_text("two")
    assert runtime_manifest.tree_digest(tmp_path) != baseline
