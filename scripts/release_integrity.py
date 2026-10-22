#!/usr/bin/env python3
"""Release preflight, packaged-resource inventory, artifact privacy scan, and release manifest.

Invoked by scripts/release-macos.sh and scripts/build-macos.sh. Standard library only.
Exit code 0 means the check passed; 1 means it failed closed.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import struct
import subprocess
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runtime_manifest  # noqa: E402

SCHEMA_VERSION = 1
MODES = ("release", "candidate")
TAG_PREFIX = "v"
EXTENSION_MANIFEST = "browser-extension/google-meet/manifest.json"
SKILL_PATH = "skills/meeting-wiki-memory/SKILL.md"
NOTICE_FILES = ("LICENSE", "NOTICE")
ASAR_NAME = "app.asar"
IGNORED_NAMES = frozenset({".DS_Store"})


class IntegrityError(Exception):
    """Raised when a release precondition cannot be evaluated."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=check, capture_output=True, text=True
    )


def parse_versions(pyproject: str, package_json: str, package_lock: str) -> dict[str, str]:
    lock = json.loads(package_lock)
    return {
        "pyproject.toml": tomllib.loads(pyproject)["project"]["version"],
        "desktop/package.json": json.loads(package_json)["version"],
        "desktop/package-lock.json": lock["version"],
        'desktop/package-lock.json packages[""]': lock.get("packages", {})
        .get("", {})
        .get("version", ""),
    }


def working_versions(root: Path) -> dict[str, str]:
    return parse_versions(
        (root / "pyproject.toml").read_text(),
        (root / "desktop/package.json").read_text(),
        (root / "desktop/package-lock.json").read_text(),
    )


def committed_versions(root: Path) -> dict[str, str]:
    def show(path: str) -> str:
        return git(root, "show", f"HEAD:{path}").stdout

    return parse_versions(
        show("pyproject.toml"), show("desktop/package.json"), show("desktop/package-lock.json")
    )


def preflight(root: Path, mode: str) -> dict:
    """Return release identity plus errors; errors is empty only when release may proceed."""
    if mode not in MODES:
        raise IntegrityError(f"unknown mode {mode!r}")
    errors: list[str] = []
    status = git(root, "status", "--porcelain=v1", "--untracked-files=all").stdout.splitlines()
    if status:
        shown = ", ".join(line[3:] for line in status[:10])
        more = f" and {len(status) - 10} more" if len(status) > 10 else ""
        errors.append(f"working tree is not clean: {shown}{more}")

    committed = committed_versions(root)
    if len(set(committed.values())) != 1:
        detail = ", ".join(f"{name}={value}" for name, value in committed.items())
        errors.append(f"committed versions differ: {detail}")
    working = working_versions(root)
    if working != committed:
        errors.append("version files differ from HEAD; commit the version bump first")
    version = committed["pyproject.toml"]

    commit = git(root, "rev-parse", "HEAD").stdout.strip()
    tag = f"{TAG_PREFIX}{version}"
    tag_type = git(root, "cat-file", "-t", f"refs/tags/{tag}", check=False).stdout.strip()
    tag_commit = ""
    if tag_type:
        tag_commit = git(root, "rev-parse", f"refs/tags/{tag}^{{commit}}").stdout.strip()

    if mode == "release":
        if not tag_type:
            errors.append(
                f"release mode requires annotated tag {tag} on HEAD; "
                "use --candidate for an untagged build"
            )
        elif tag_type != "tag":
            errors.append(f"tag {tag} is lightweight; release tags must be annotated")
        elif tag_commit != commit:
            errors.append(f"tag {tag} points at {tag_commit[:12]}, not HEAD {commit[:12]}")
    elif tag_type and tag_commit != commit:
        errors.append(
            f"version {version} is already tagged at {tag_commit[:12]}; "
            "bump the version instead of rebuilding a released number"
        )

    return {
        "mode": mode,
        "version": version,
        "commit": commit,
        "tag": tag if mode == "release" else None,
        "errors": errors,
    }


def read_asar_header(path: Path) -> dict:
    """Parse the Chromium-pickle JSON header at the start of an Electron asar archive."""
    with path.open("rb") as source:
        prefix = source.read(16)
        if len(prefix) < 16:
            raise IntegrityError(f"{path.name} is too small to be an asar archive")
        _, _, _, json_size = struct.unpack("<4I", prefix)
        raw = source.read(json_size)
    if len(raw) != json_size:
        raise IntegrityError(f"{path.name} header is truncated")
    return json.loads(raw)


def asar_files(header: dict, prefix: str = "") -> dict[str, dict]:
    """Flatten the asar tree to {relative path: file entry}."""
    found: dict[str, dict] = {}
    for name, entry in header.get("files", {}).items():
        relative = f"{prefix}{name}"
        if "files" in entry:
            found.update(asar_files(entry, f"{relative}/"))
        else:
            found[relative] = entry
    return found


def source_files(directory: Path) -> list[str]:
    return sorted(
        path.relative_to(directory).as_posix()
        for path in directory.rglob("*")
        if (path.is_file() or path.is_symlink()) and path.name not in IGNORED_NAMES
    )


def declared_app_files(desktop: Path, patterns: list[str]) -> list[str]:
    """Expand build.files into the source paths electron-builder must place in app.asar."""
    every = source_files(desktop)
    expected: set[str] = set()
    for pattern in patterns:
        if pattern.endswith("/**"):
            base = pattern[:-3]
            matches = [path for path in every if path.startswith(f"{base}/")]
        else:
            matches = [path for path in every if fnmatch.fnmatchcase(path, pattern)]
        if not matches:
            raise IntegrityError(f"build.files entry {pattern!r} matches no source file")
        expected.update(matches)
    return sorted(expected)


def declared_extra_resources(desktop: Path, resources: list[dict]) -> list[tuple[str, str]]:
    """Return (source path relative to desktop, destination under Resources) pairs."""
    pairs: list[tuple[str, str]] = []
    for resource in resources:
        source_dir = desktop / resource["from"]
        if not source_dir.is_dir():
            raise IntegrityError(f"extraResources source {resource['from']}/ does not exist")
        files = source_files(source_dir)
        filters = resource.get("filter", ["**/*"])
        selected = [
            path
            for path in files
            if any(item == "**/*" or fnmatch.fnmatchcase(path, item) for item in filters)
        ]
        for item in filters:
            if item != "**/*" and item not in selected:
                raise IntegrityError(f"extraResources filter {resource['from']}/{item} is missing")
        if not selected:
            raise IntegrityError(f"extraResources {resource['from']}/ selects no files")
        pairs.extend(
            (f"{resource['from']}/{path}", f"{resource['to']}/{path}") for path in selected
        )
    return pairs


def _same_content(source: Path, packaged: Path) -> bool:
    if source.is_symlink() or packaged.is_symlink():
        return (
            source.is_symlink()
            and packaged.is_symlink()
            and os.readlink(source) == os.readlink(packaged)
        )
    if runtime_manifest._is_macho(str(source)):
        # Signing may rewrite Mach-O signatures; presence and executability are what matter.
        return os.access(packaged, os.X_OK) == os.access(source, os.X_OK)
    return sha256_file(source) == sha256_file(packaged)


def inventory(app: Path, desktop: Path) -> dict:
    """Verify every declared app file and extra resource is inside the packaged app."""
    errors: list[str] = []
    build = json.loads((desktop / "package.json").read_text())["build"]
    resources_dir = app / "Contents" / "Resources"
    asar = resources_dir / ASAR_NAME
    if not asar.is_file():
        return {"errors": [f"{ASAR_NAME} is missing from {app.name}"]}

    packed = asar_files(read_asar_header(asar))
    for relative in declared_app_files(desktop, build["files"]):
        entry = packed.get(relative)
        if entry is None:
            errors.append(f"app.asar is missing {relative}")
            continue
        recorded = entry.get("integrity", {}).get("hash")
        if recorded and recorded != sha256_file(desktop / relative):
            errors.append(f"app.asar {relative} differs from the committed source")

    declared_destinations: dict[str, set[str]] = {}
    for source_rel, destination_rel in declared_extra_resources(desktop, build["extraResources"]):
        top = destination_rel.split("/", 1)[0]
        declared_destinations.setdefault(top, set()).add(destination_rel)
        packaged = resources_dir / destination_rel
        if not (packaged.exists() or packaged.is_symlink()):
            errors.append(f"Resources/{destination_rel} is missing")
        elif not _same_content(desktop / source_rel, packaged):
            errors.append(f"Resources/{destination_rel} differs from desktop/{source_rel}")
    for top, declared in sorted(declared_destinations.items()):
        destination = resources_dir / top
        if not destination.is_dir():
            continue
        for relative in source_files(destination):
            if f"{top}/{relative}" not in declared:
                errors.append(f"Resources/{top}/{relative} is not a declared resource")

    skill = packed.get(SKILL_PATH)
    extension = resources_dir / EXTENSION_MANIFEST
    extension_version = None
    if extension.is_file():
        extension_version = json.loads(extension.read_text()).get("version")
        if not extension_version:
            errors.append("Google Meet extension manifest has no version")
    else:
        errors.append(f"Resources/{EXTENSION_MANIFEST} is missing")
    if skill is None:
        errors.append(f"app.asar is missing the Claude skill {SKILL_PATH}")

    runtime_dir = resources_dir / "runtime"
    runtime_tree = None
    runtime_recorded = None
    if (runtime_dir / "manifest.json").is_file():
        runtime_recorded = json.loads((runtime_dir / "manifest.json").read_text()).get(
            "tree_sha256"
        )
        runtime_tree = runtime_manifest.tree_digest(runtime_dir)
    else:
        errors.append("Resources/runtime/manifest.json is missing")

    return {
        "errors": list(dict.fromkeys(errors)),
        "extension_version": extension_version,
        "skill_sha256": skill.get("integrity", {}).get("hash") if skill else None,
        "runtime_recorded_tree_sha256": runtime_recorded,
        "runtime_packaged_tree_sha256": runtime_tree,
        "asar_file_count": len(packed),
    }


def scan_app(app: Path, forbidden_paths: list[str]) -> list[str]:
    """Privacy findings for the packaged app, including file names inside app.asar."""
    findings = runtime_manifest.scan_runtime(app, forbidden_paths)
    asar = app / "Contents" / "Resources" / ASAR_NAME
    if asar.is_file():
        for relative in asar_files(read_asar_header(asar)):
            parts = relative.split("/")
            name = parts[-1]
            if ".meeting-wiki" in parts or name in runtime_manifest.FORBIDDEN_NAMES:
                findings.append(f"private file in app.asar: {relative}")
            elif name.lower().endswith(runtime_manifest.FORBIDDEN_SUFFIXES):
                findings.append(f"private or model artifact in app.asar: {relative}")
    return findings


def build_release_manifest(
    root: Path,
    identity: dict,
    app_inventory: dict,
    artifacts: list[Path],
    source_offer: Path,
) -> dict:
    """Release manifest; paths are basenames or repository-relative, never host paths."""
    commit_time = git(root, "show", "-s", "--format=%cI", identity["commit"]).stdout.strip()
    runtime = json.loads((root / "desktop/runtime/manifest.json").read_text())
    return {
        "schema_version": SCHEMA_VERSION,
        "product": "Meeting Wiki",
        "version": identity["version"],
        "mode": identity["mode"],
        "publishable": identity["mode"] == "release",
        "source": {
            "commit": identity["commit"],
            "tag": identity["tag"],
            "commit_time": commit_time,
        },
        "runtime": {
            "tree_sha256": runtime["tree_sha256"],
            "packaged_tree_sha256": app_inventory["runtime_packaged_tree_sha256"],
            "python": runtime["python"]["version"],
            "dependency_lock_sha256": runtime["dependency_lock_sha256"],
            "audio_tools_status": runtime["audio_tools"]["status"],
        },
        "google_meet_extension": {
            "version": app_inventory["extension_version"],
            "manifest_sha256": sha256_file(root / "desktop" / EXTENSION_MANIFEST),
        },
        "claude_skill": {"path": SKILL_PATH, "sha256": app_inventory["skill_sha256"]},
        "notices": {name: sha256_file(root / name) for name in NOTICE_FILES},
        "source_offer_sha256": sha256_file(source_offer),
        "artifacts": [
            {"name": path.name, "sha256": sha256_file(path), "size": path.stat().st_size}
            for path in sorted(artifacts, key=lambda item: item.name)
        ],
    }


def _report(errors: list[str], label: str) -> int:
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    if errors:
        print(f"{label} failed.", file=sys.stderr)
        return 1
    print(f"{label} passed.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    commands = parser.add_subparsers(dest="command", required=True)

    preflight_cmd = commands.add_parser("preflight")
    preflight_cmd.add_argument("--mode", choices=MODES, required=True)

    inventory_cmd = commands.add_parser("inventory")
    inventory_cmd.add_argument("--app", type=Path, required=True)

    scan_cmd = commands.add_parser("scan")
    scan_cmd.add_argument("--app", type=Path, required=True)
    scan_cmd.add_argument("--forbid-path", action="append", default=[])

    offer_cmd = commands.add_parser("source-offer")
    offer_cmd.add_argument("--app", type=Path, required=True)
    offer_cmd.add_argument("--source-offer", type=Path, required=True)

    manifest_cmd = commands.add_parser("manifest")
    manifest_cmd.add_argument("--mode", choices=MODES, required=True)
    manifest_cmd.add_argument("--app", type=Path, required=True)
    manifest_cmd.add_argument("--artifact", type=Path, action="append", required=True)
    manifest_cmd.add_argument("--source-offer", type=Path, required=True)
    manifest_cmd.add_argument("--out", type=Path, required=True)

    args = parser.parse_args(argv)
    root = args.root.resolve()
    desktop = root / "desktop"
    try:
        if args.command == "preflight":
            identity = preflight(root, args.mode)
            if not identity["errors"]:
                print(
                    f"Release identity: {identity['mode']} {identity['version']} "
                    f"at {identity['commit'][:12]}"
                )
            return _report(identity["errors"], "Release preflight")
        if args.command == "inventory":
            result = inventory(args.app, desktop)
            if not result["errors"]:
                print(
                    f"Inventory: {result['asar_file_count']} asar files, extension "
                    f"{result['extension_version']}, runtime "
                    f"{result['runtime_packaged_tree_sha256']}"
                )
            return _report(result["errors"], f"Artifact inventory ({args.app.name})")
        if args.command == "scan":
            return _report(scan_app(args.app, args.forbid_path), f"Artifact scan ({args.app.name})")
        if args.command == "source-offer":
            packaged = args.app / "Contents/Resources/runtime/licenses/SOURCE-OFFER.txt"
            errors = []
            if not args.source_offer.is_file() or args.source_offer.stat().st_size == 0:
                errors.append("MEETING_WIKI_GPL_SOURCE_OFFER is not a non-empty file")
            elif not packaged.is_file():
                errors.append("packaged runtime has no licenses/SOURCE-OFFER.txt")
            elif sha256_file(packaged) != sha256_file(args.source_offer):
                errors.append(
                    "packaged SOURCE-OFFER.txt differs from MEETING_WIKI_GPL_SOURCE_OFFER"
                )
            return _report(errors, "Source offer check")
        if args.command == "manifest":
            identity = preflight(root, args.mode)
            app_inventory = inventory(args.app, desktop)
            errors = identity["errors"] + app_inventory["errors"]
            if errors:
                return _report(errors, "Release manifest")
            manifest = build_release_manifest(
                root, identity, app_inventory, args.artifact, args.source_offer
            )
            args.out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            print(f"Release manifest written: {args.out.name}")
            return 0
    except (IntegrityError, subprocess.CalledProcessError, OSError, KeyError, ValueError) as error:
        print(f"release-integrity: {error}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
