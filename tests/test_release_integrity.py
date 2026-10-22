from __future__ import annotations

import hashlib
import importlib.util
import json
import os
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
    "renderer/index.html": b"<html></html>\n",
    "skills/meeting-wiki-memory/SKILL.md": b"# skill\n",
}
EXTENSION_FILES = {
    "google-meet/manifest.json": json.dumps({"version": "0.4.2"}).encode(),
    "google-meet/background.js": b"background\n",
    "google-meet/content.js": b"content\n",
}
RUNTIME_FILES = {
    "manifest.json": json.dumps({"tree_sha256": "abc"}).encode(),
    "licenses/SOURCE-OFFER.txt": b"offer\n",
}


@pytest.fixture
def packaged(tmp_path):
    desktop = tmp_path / "desktop"
    build = {
        "files": ["main.js", "skills/meeting-wiki-memory/SKILL.md", "renderer/**"],
        "extraResources": [
            {"from": "runtime", "to": "runtime", "filter": ["**/*"]},
            {
                "from": "browser-extension",
                "to": "browser-extension",
                "filter": sorted(EXTENSION_FILES),
            },
        ],
    }
    for relative, data in {
        **APP_FILES,
        **{f"browser-extension/{key}": value for key, value in EXTENSION_FILES.items()},
        **{f"runtime/{key}": value for key, value in RUNTIME_FILES.items()},
        "browser-extension/google-meet/README.dev.md": b"not shipped\n",
    }.items():
        target = desktop / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (desktop / "package.json").write_text(json.dumps({"build": build}))

    app = tmp_path / "Meeting Wiki.app"
    resources = app / "Contents" / "Resources"
    resources.mkdir(parents=True)
    _write_asar(resources / "app.asar", APP_FILES)
    for prefix, files in (("browser-extension", EXTENSION_FILES), ("runtime", RUNTIME_FILES)):
        for relative, data in files.items():
            target = resources / prefix / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    return desktop, app


def test_inventory_passes_and_reports_extension_skill_and_runtime(packaged):
    desktop, app = packaged

    result = release_integrity.inventory(app, desktop)

    assert result["errors"] == []
    assert result["extension_version"] == "0.4.2"
    assert result["skill_sha256"] == _sha(APP_FILES["skills/meeting-wiki-memory/SKILL.md"])
    assert result["runtime_recorded_tree_sha256"] == "abc"
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
    assert any("Claude skill" in error for error in errors)


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
