from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import plistlib
import struct
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).parents[1] / "scripts"
for _name in ("runtime_manifest", "release_integrity"):
    if _name not in sys.modules:
        _spec = importlib.util.spec_from_file_location(_name, SCRIPTS / f"{_name}.py")
        _module = importlib.util.module_from_spec(_spec)
        sys.modules[_name] = _module
        _spec.loader.exec_module(_module)
release_integrity = sys.modules["release_integrity"]

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}


def _git(repo: Path, *args: str) -> str:
    env = {**os.environ, **GIT_ENV}
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env
    ).stdout


def _write_versions(repo: Path, python: str, desktop: str, lock: str | None = None) -> None:
    lock = lock or desktop
    (repo / "desktop").mkdir(exist_ok=True)
    (repo / "pyproject.toml").write_text(f'[project]\nname = "x"\nversion = "{python}"\n')
    (repo / "desktop/package.json").write_text(json.dumps({"version": desktop}))
    (repo / "desktop/package-lock.json").write_text(
        json.dumps({"version": lock, "packages": {"": {"version": lock}}})
    )


@pytest.fixture
def repo(tmp_path, monkeypatch):
    for key, value in GIT_ENV.items():
        monkeypatch.setenv(key, value)
    path = tmp_path / "repo"
    path.mkdir()
    _git(path, "init", "-q", "-b", "main")
    _write_versions(path, "1.2.3", "1.2.3")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "init")
    return path


def test_release_mode_passes_on_clean_tree_with_annotated_tag_at_head(repo):
    _git(repo, "tag", "-a", "v1.2.3", "-m", "release")

    identity = release_integrity.preflight(repo, "release")

    assert identity["errors"] == []
    assert identity["version"] == "1.2.3"
    assert identity["tag"] == "v1.2.3"
    assert identity["commit"] == _git(repo, "rev-parse", "HEAD").strip()


def test_release_mode_requires_a_tag(repo):
    errors = release_integrity.preflight(repo, "release")["errors"]

    assert any("requires annotated tag v1.2.3" in error for error in errors)


def test_release_mode_rejects_lightweight_tag(repo):
    _git(repo, "tag", "v1.2.3")

    errors = release_integrity.preflight(repo, "release")["errors"]

    assert any("lightweight" in error for error in errors)


def test_release_mode_rejects_tag_on_another_commit(repo):
    _git(repo, "tag", "-a", "v1.2.3", "-m", "release")
    (repo / "README.md").write_text("later\n")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-q", "-m", "later")

    errors = release_integrity.preflight(repo, "release")["errors"]

    assert any("not HEAD" in error for error in errors)


def test_candidate_mode_passes_untagged(repo):
    identity = release_integrity.preflight(repo, "candidate")

    assert identity["errors"] == []
    assert identity["tag"] is None


def test_candidate_mode_rejects_a_version_already_tagged_elsewhere(repo):
    _git(repo, "tag", "-a", "v1.2.3", "-m", "release")
    (repo / "README.md").write_text("later\n")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-q", "-m", "later")

    errors = release_integrity.preflight(repo, "candidate")["errors"]

    assert any("already tagged" in error for error in errors)


def test_dirty_or_untracked_tree_fails(repo):
    (repo / "notes.md").write_text("untracked\n")

    errors = release_integrity.preflight(repo, "candidate")["errors"]

    assert any("not clean" in error and "notes.md" in error for error in errors)


def test_uncommitted_version_bump_fails(repo):
    _write_versions(repo, "1.2.4", "1.2.4")

    errors = release_integrity.preflight(repo, "candidate")["errors"]

    assert any("commit the version bump" in error for error in errors)


@pytest.mark.parametrize(
    ("python", "desktop", "lock"),
    [("1.2.3", "1.2.4", "1.2.4"), ("1.2.3", "1.2.3", "1.2.4")],
)
def test_committed_version_mismatch_fails(repo, python, desktop, lock):
    _write_versions(repo, python, desktop, lock)
    _git(repo, "commit", "-q", "-am", "mismatch")

    errors = release_integrity.preflight(repo, "candidate")["errors"]

    assert any("committed versions differ" in error for error in errors)


def test_unknown_mode_is_rejected(repo):
    with pytest.raises(release_integrity.IntegrityError):
        release_integrity.preflight(repo, "nightly")


# Packaged app fixtures


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_asar(path: Path, files: dict[str, bytes]) -> None:
    tree: dict = {"files": {}}
    for relative, data in files.items():
        node = tree
        *parents, name = relative.split("/")
        for parent in parents:
            node = node["files"].setdefault(parent, {"files": {}})
        node["files"][name] = {"size": len(data), "integrity": {"hash": _sha(data)}}
    raw = json.dumps(tree).encode()
    path.write_bytes(struct.pack("<4I", 4, len(raw) + 8, len(raw) + 4, len(raw)) + raw)


APP_FILES = {
    "main.js": b"main\n",
    "cli-installer.js": b"cli\n",
    "renderer/index.html": b"<html></html>\n",
    "skills/meeting-wiki-memory/SKILL.md": b"# skill\n",
}
EXTENSION_FILES = {
    "google-meet/manifest.json": json.dumps({"version": "0.4.2"}).encode(),
    "google-meet/background.js": b"background\n",
    "google-meet/content.js": b"content\n",
}
RUNTIME_FILES = {
    "bin/python": b"python\n",
    "bin/rec": b"rec\n",
    "bin/sox": b"sox\n",
    "lib/python3.12/LICENSE.txt": b"Python license\n",
    "lib/python3.12/site-packages/demo-1.0.dist-info/licenses/LICENSE.txt": b"MIT\n",
    "licenses/SOURCE-OFFER.txt": b"offer\n",
    "licenses/sox-1.0/LICENSE.GPL": b"GPL\n",
}
MAC_CONFIG = {
    "icon": "assets/icon.icns",
    "minimumSystemVersion": "14.2",
    "extendInfo": {
        "NSMicrophoneUsageDescription": "Meeting Wiki microphone",
        "NSScreenCaptureUsageDescription": "Meeting Wiki system audio",
        "NSAudioCaptureUsageDescription": "Meeting Wiki automatic recording",
    },
}


@pytest.fixture
def packaged(tmp_path):
    desktop = tmp_path / "desktop"
    build = {
        "mac": MAC_CONFIG,
        "files": [
            "main.js",
            "cli-installer.js",
            "skills/meeting-wiki-memory/SKILL.md",
            "renderer/**",
        ],
        "extraResources": [
            {"from": "runtime", "to": "runtime", "filter": ["**/*"]},
            {
                "from": "browser-extension",
                "to": "browser-extension",
                "filter": sorted(EXTENSION_FILES),
            },
            {"from": "../LICENSE", "to": "LICENSE"},
            {"from": "../NOTICE", "to": "NOTICE"},
        ],
    }
    source_files = {
        **APP_FILES,
        **{f"browser-extension/{key}": value for key, value in EXTENSION_FILES.items()},
        **{f"runtime/{key}": value for key, value in RUNTIME_FILES.items()},
        "assets/icon.icns": b"icns product icon\n",
        "browser-extension/google-meet/README.dev.md": b"not shipped\n",
    }
    for relative, data in source_files.items():
        target = desktop / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for tool in release_integrity.RUNTIME_TOOLS:
        (desktop / "runtime/bin" / tool).chmod(0o755)

    runtime_manifest_data = {
        "tree_sha256": release_integrity.runtime_manifest.tree_digest(desktop / "runtime"),
        "python": {"version": "3.12.12"},
        "packages": [
            {
                "name": "demo",
                "version": "1.0",
                "license_files": ["demo-1.0.dist-info/licenses/LICENSE.txt"],
            }
        ],
        "audio_tools": {
            "components": [
                {
                    "formula": "sox",
                    "version": "1.0",
                    "license_files": ["LICENSE.GPL"],
                }
            ]
        },
    }
    manifest = json.dumps(runtime_manifest_data).encode()
    (desktop / "runtime/manifest.json").write_bytes(manifest)
    (desktop / "package.json").write_text(json.dumps({"build": build}))
    (tmp_path / "LICENSE").write_bytes(b"Apache\n")
    (tmp_path / "NOTICE").write_bytes(b"Notice\n")

    app = tmp_path / "Meeting Wiki.app"
    contents = app / "Contents"
    resources = contents / "Resources"
    resources.mkdir(parents=True)
    _write_asar(resources / "app.asar", APP_FILES)
    packaged_files = {
        **{f"browser-extension/{key}": value for key, value in EXTENSION_FILES.items()},
        **{f"runtime/{key}": value for key, value in RUNTIME_FILES.items()},
        "runtime/manifest.json": manifest,
        "LICENSE": b"Apache\n",
        "NOTICE": b"Notice\n",
        "icon.icns": b"icns product icon\n",
    }
    for relative, data in packaged_files.items():
        target = resources / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for tool in release_integrity.RUNTIME_TOOLS:
        (resources / "runtime/bin" / tool).chmod(0o755)
    info = {
        "LSMinimumSystemVersion": "14.2",
        "CFBundleIconFile": "icon.icns",
        **MAC_CONFIG["extendInfo"],
    }
    with (contents / "Info.plist").open("wb") as output:
        plistlib.dump(info, output)
    return desktop, app


def test_inventory_passes_and_reports_extension_skill_and_runtime(packaged):
    desktop, app = packaged

    result = release_integrity.inventory(app, desktop)

    assert result["errors"] == []
    assert result["extension_version"] == "0.4.2"
    assert result["skill_sha256"] == _sha(APP_FILES["skills/meeting-wiki-memory/SKILL.md"])
    assert result["runtime_recorded_tree_sha256"] == result["runtime_packaged_tree_sha256"]
    assert result["runtime_packaged_tree_sha256"]


def test_inventory_fails_when_google_meet_extension_is_missing(packaged):
    desktop, app = packaged
    (app / "Contents/Resources/browser-extension/google-meet/content.js").unlink()

    errors = release_integrity.inventory(app, desktop)["errors"]

    assert "Resources/browser-extension/google-meet/content.js is missing" in errors


def test_inventory_fails_when_claude_skill_is_missing_from_asar(packaged):
    desktop, app = packaged
    files = {key: value for key, value in APP_FILES.items() if not key.startswith("skills/")}
    _write_asar(app / "Contents/Resources/app.asar", files)

    errors = release_integrity.inventory(app, desktop)["errors"]

    assert "app.asar is missing skills/meeting-wiki-memory/SKILL.md" in errors


def test_inventory_fails_when_packaged_source_is_stale(packaged):
    desktop, app = packaged
    (desktop / "main.js").write_bytes(b"main v2\n")

    errors = release_integrity.inventory(app, desktop)["errors"]

    assert "app.asar main.js differs from the committed source" in errors


def test_inventory_fails_on_undeclared_or_changed_resource(packaged):
    desktop, app = packaged
    extension = app / "Contents/Resources/browser-extension/google-meet"
    (extension / "debug.js").write_bytes(b"debug\n")
    (extension / "background.js").write_bytes(b"tampered\n")

    errors = release_integrity.inventory(app, desktop)["errors"]

    assert "Resources/browser-extension/google-meet/debug.js is not a declared resource" in errors
    assert any("background.js differs" in error for error in errors)


def test_inventory_rejects_build_files_entry_that_matches_nothing(packaged):
    desktop, app = packaged
    (desktop / "main.js").unlink()

    with pytest.raises(release_integrity.IntegrityError, match="main.js"):
        release_integrity.inventory(app, desktop)


def test_inventory_fails_when_cli_installer_is_missing_from_asar(packaged):
    desktop, app = packaged
    files = {key: value for key, value in APP_FILES.items() if key != "cli-installer.js"}
    _write_asar(app / "Contents/Resources/app.asar", files)

    errors = release_integrity.inventory(app, desktop)["errors"]

    assert "app.asar is missing cli-installer.js" in errors


@pytest.mark.parametrize("name", ["LICENSE", "NOTICE"])
def test_inventory_requires_packaged_project_notices(packaged, name):
    desktop, app = packaged
    (app / "Contents/Resources" / name).unlink()

    errors = release_integrity.inventory(app, desktop)["errors"]

    assert f"Resources/{name} is missing" in errors


@pytest.mark.parametrize(
    ("relative", "expected"),
    [
        ("bin/python", "Resources/runtime/bin/python is missing or not executable"),
        ("bin/rec", "Resources/runtime/bin/rec is missing or not executable"),
        ("bin/sox", "Resources/runtime/bin/sox is missing or not executable"),
        ("lib/python3.12/LICENSE.txt", "Resources/runtime is missing the CPython license"),
        (
            "lib/python3.12/site-packages/demo-1.0.dist-info/licenses/LICENSE.txt",
            "runtime package license is missing: demo-1.0.dist-info/licenses/LICENSE.txt",
        ),
        ("licenses/SOURCE-OFFER.txt", "Resources/runtime/licenses/SOURCE-OFFER.txt is missing"),
        (
            "licenses/sox-1.0/LICENSE.GPL",
            "runtime audio license is missing: licenses/sox-1.0/LICENSE.GPL",
        ),
    ],
)
def test_inventory_requires_runtime_tools_and_licenses(packaged, relative, expected):
    desktop, app = packaged
    (app / "Contents/Resources/runtime" / relative).unlink()

    errors = release_integrity.inventory(app, desktop)["errors"]

    assert expected in errors


def test_inventory_requires_release_metadata_and_product_icon(packaged):
    desktop, app = packaged
    info_path = app / "Contents/Info.plist"
    with info_path.open("rb") as source:
        info = plistlib.load(source)
    info["LSMinimumSystemVersion"] = "12.0"
    info["NSAudioCaptureUsageDescription"] = "This app needs access to audio capture"
    info["CFBundleIconFile"] = "electron.icns"
    with info_path.open("wb") as output:
        plistlib.dump(info, output)

    errors = release_integrity.inventory(app, desktop)["errors"]

    assert "Info.plist must require macOS 14.2 or later" in errors
    assert "Info.plist NSAudioCaptureUsageDescription does not match desktop/package.json" in errors
    assert "Info.plist does not use the configured Meeting Wiki icon" in errors


def test_scan_finds_host_path_secret_and_private_names_inside_asar(packaged, tmp_path):
    _, app = packaged
    resources = app / "Contents/Resources"
    host = str(tmp_path / "home-of-builder")
    (resources / "leak.txt").write_text(f"built in {host}/src\n")
    (resources / "key.txt").write_text("sk-proj-" + "a" * 40 + "\n")
    _write_asar(
        resources / "app.asar",
        {**APP_FILES, "config.toml": b"x", ".meeting-wiki/jobs.json": b"{}"},
    )

    findings = release_integrity.scan_app(app, [host])

    assert "host path leak in Contents/Resources/leak.txt" in findings
    assert "secret-like content in Contents/Resources/key.txt" in findings
    assert "private file in app.asar: config.toml" in findings
    assert "private file in app.asar: .meeting-wiki/jobs.json" in findings


def test_scan_passes_clean_app(packaged, tmp_path):
    _, app = packaged

    assert release_integrity.scan_app(app, [str(tmp_path / "elsewhere")]) == []


def test_release_manifest_records_identity_hashes_and_no_host_paths(repo, packaged, tmp_path):
    desktop, app = packaged
    (repo / "desktop/runtime").mkdir(parents=True)
    (repo / "desktop/runtime/manifest.json").write_text(
        json.dumps(
            {
                "tree_sha256": "abc",
                "python": {"version": "3.12.12"},
                "dependency_lock_sha256": "lock",
                "audio_tools": {"status": "ok"},
            }
        )
    )
    extension = repo / "desktop/browser-extension/google-meet"
    extension.mkdir(parents=True)
    (extension / "manifest.json").write_bytes(EXTENSION_FILES["google-meet/manifest.json"])
    for name in ("LICENSE", "NOTICE"):
        (repo / name).write_text(f"{name}\n")
    offer = tmp_path / "SOURCE-OFFER.txt"
    offer.write_text("offer\n")
    dmg = tmp_path / "Meeting-Wiki-1.2.3-arm64.dmg"
    dmg.write_bytes(b"dmg")
    identity = release_integrity.preflight(repo, "candidate")
    app_inventory = release_integrity.inventory(app, desktop)

    manifest = release_integrity.build_release_manifest(repo, identity, app_inventory, [dmg], offer)

    assert manifest["version"] == "1.2.3"
    assert manifest["mode"] == "candidate"
    assert manifest["publishable"] is False
    assert manifest["source"]["commit"] == identity["commit"]
    assert manifest["runtime"]["tree_sha256"] == "abc"
    assert manifest["google_meet_extension"]["version"] == "0.4.2"
    assert manifest["claude_skill"]["sha256"] == app_inventory["skill_sha256"]
    assert manifest["source_offer_sha256"] == _sha(b"offer\n")
    assert manifest["artifacts"] == [{"name": dmg.name, "sha256": _sha(b"dmg"), "size": 3}]
    serialized = json.dumps(manifest)
    assert str(tmp_path) not in serialized
    assert str(Path.home()) not in serialized


def test_source_offer_command_fails_closed_when_offer_differs(packaged, tmp_path):
    _, app = packaged
    offer = tmp_path / "offer.txt"
    offer.write_text("different\n")

    assert (
        release_integrity.main(["source-offer", "--app", str(app), "--source-offer", str(offer)])
        == 1
    )
    offer.write_text("offer\n")
    assert (
        release_integrity.main(["source-offer", "--app", str(app), "--source-offer", str(offer)])
        == 0
    )
    assert (
        release_integrity.main(
            ["source-offer", "--app", str(app), "--source-offer", str(tmp_path / "none")]
        )
        == 1
    )
