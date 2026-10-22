#!/usr/bin/env python3
"""Audio tool licensing, relocation, privacy scan, and manifest for the portable runtime.

Invoked by scripts/prepare-runtime-macos.sh with the staged interpreter. Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCHEMA_VERSION = 1
EXIT_BLOCKED = 3
SYSTEM_PREFIXES = ("/usr/lib/", "/System/")
CELLAR_RE = re.compile(r"^(?P<prefix>.+)/Cellar/(?P<formula>[^/]+)/(?P<version>[^/]+)/")
LICENSE_FILE_RE = re.compile(r"^(COPYING|LICENSE|COPYRIGHT|NOTICE)([._-].*)?$", re.IGNORECASE)
COPYLEFT_PREFIXES = ("GPL-", "LGPL-", "AGPL-")
PERMISSIVE_LICENSES = frozenset(
    {
        "Apache-2.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "ISC",
        "Libpng",
        "libpng-2.0",
        "LicenseRef-Homebrew-public-domain",
        "MIT",
        "X11",
        "Zlib",
    }
)
SPDX_OPERATORS = frozenset({"AND", "OR", "WITH"})
AUDIO_TOOLS = ("rec", "sox")
SOURCE_OFFER_ENV = "MEETING_WIKI_GPL_SOURCE_OFFER"

FORBIDDEN_TOP_LEVEL_DIRS = frozenset(
    {"jobs", "logs", "models", "private", "recordings", "transcripts", "wiki"}
)
FORBIDDEN_NAMES = frozenset({"config.toml", ".env", ".DS_Store"})
FORBIDDEN_SUFFIXES = (
    ".db",
    ".db-shm",
    ".db-wal",
    ".flac",
    ".gguf",
    ".key",
    ".m4a",
    ".mp3",
    ".npz",
    ".ogg",
    ".onnx",
    ".p8",
    ".safetensors",
    ".wav",
    ".webm",
)
CODE_SUFFIXES = (".py", ".pyc", ".pyi")
SECRET_PATTERNS = (
    re.compile(
        rb"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}"
    ),
    re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}"),
    re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
)


class BlockedError(Exception):
    """Raised when a component cannot be staged defensibly."""


def run(args: list[str]) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def license_tokens(expression: str) -> list[str]:
    cleaned = expression.replace("(", " ").replace(")", " ")
    return [token for token in cleaned.split() if token not in SPDX_OPERATORS]


def classify_license(expression: str | None) -> tuple[str, list[str]]:
    """Return (category, unknown_tokens); category is copyleft, permissive, or unknown."""
    if not expression:
        return "unknown", []
    tokens = license_tokens(expression)
    unknown = [
        token
        for token in tokens
        if token not in PERMISSIVE_LICENSES and not token.startswith(COPYLEFT_PREFIXES)
    ]
    if unknown or not tokens:
        return "unknown", unknown
    if any(token.startswith(COPYLEFT_PREFIXES) for token in tokens):
        return "copyleft", []
    return "permissive", []


def keg_for(path: str) -> tuple[str, str, Path] | None:
    match = CELLAR_RE.match(path)
    if not match:
        return None
    keg = Path(match.group("prefix")) / "Cellar" / match.group("formula") / match.group("version")
    return match.group("formula"), match.group("version"), keg


def license_files(keg: Path) -> list[str]:
    return sorted(entry.name for entry in keg.iterdir() if LICENSE_FILE_RE.match(entry.name))


def macho_references(path: str) -> list[str]:
    own_id = run(["otool", "-D", path]).splitlines()[1:]
    lines = run(["otool", "-L", path]).splitlines()[1:]
    refs = [line.strip().split(" (compatibility")[0] for line in lines if line.strip()]
    return [ref for ref in refs if ref not in own_id]


def rpaths(path: str) -> list[str]:
    lines = run(["otool", "-l", path]).splitlines()
    found = []
    for index, line in enumerate(lines):
        if line.strip() == "cmd LC_RPATH":
            for follow in lines[index + 1 : index + 4]:
                if follow.strip().startswith("path "):
                    found.append(follow.strip().split()[1])
    return found


def is_system(ref: str) -> bool:
    return ref.startswith(SYSTEM_PREFIXES)


def brew_licenses(formulas: list[str]) -> dict[str, str | None]:
    if not formulas:
        return {}
    if not shutil.which("brew"):
        return dict.fromkeys(formulas)
    data = json.loads(run(["brew", "info", "--json=v2", *formulas]))
    return {item["name"]: item.get("license") for item in data.get("formulae", [])}


def plan_audio_tools(
    tool_paths: dict[str, str],
    source_offer: str | None,
    licenses_lookup=brew_licenses,
) -> dict:
    """Inspect rec/sox and their dylib closure; record license and redistribution notes."""
    blockers: list[str] = []
    tools: dict[str, dict] = {}
    libraries: dict[str, str] = {}
    origins: dict[str, tuple[str, str, Path]] = {}

    def register(real: str, label: str) -> bool:
        keg = keg_for(real)
        if keg is None:
            blockers.append(
                f"{label} at {real} is not inside a Homebrew keg, so its license and "
                "redistribution terms cannot be verified"
            )
            return False
        origins[real] = keg
        return True

    queue: list[str] = []
    for name in AUDIO_TOOLS:
        raw = tool_paths.get(name) or ""
        if not raw:
            blockers.append(f"{name} not found; install SoX or set MEETING_WIKI_{name.upper()}_BIN")
            continue
        real = os.path.realpath(raw)
        if not os.path.isfile(real) or not os.access(real, os.X_OK):
            blockers.append(f"{name} at {raw} is not an executable file")
            continue
        archs = run(["lipo", "-archs", real]).split() if _is_macho(real) else []
        if not any(arch.startswith("arm64") for arch in archs):
            blockers.append(f"{name} at {raw} is not an arm64 Mach-O executable")
            continue
        if register(real, name):
            tools[name] = {"source": raw, "real": real}
            queue.append(real)

    seen: set[str] = set()
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        for rpath in rpaths(current):
            if not rpath.startswith("@"):
                blockers.append(f"{os.path.basename(current)} has absolute LC_RPATH {rpath}")
        for ref in macho_references(current):
            if is_system(ref):
                continue
            if ref.startswith("@"):
                blockers.append(f"{os.path.basename(current)} uses unresolved reference {ref}")
                continue
            real = os.path.realpath(ref)
            if not os.path.isfile(real):
                blockers.append(f"{os.path.basename(current)} links missing library {ref}")
                continue
            base = os.path.basename(ref)
            if libraries.get(base, real) != real:
                blockers.append(f"two different libraries are named {base}")
                continue
            if base not in libraries and register(real, base):
                libraries[base] = real
                queue.append(real)

    formulas = sorted({keg[0] for keg in origins.values()})
    looked_up = licenses_lookup(formulas)
    components = []
    copyleft = []
    for formula in formulas:
        version, keg = next((v, k) for f, v, k in origins.values() if f == formula)
        expression = looked_up.get(formula)
        category, unknown = classify_license(expression)
        files = license_files(keg)
        if category == "unknown":
            detail = f" (unrecognized: {', '.join(unknown)})" if unknown else ""
            blockers.append(f"{formula} has no verifiable SPDX license{detail}")
        if not files:
            blockers.append(f"{formula} keg ships no COPYING/LICENSE file to redistribute")
        if category == "copyleft":
            copyleft.append(formula)
            note = (
                "copyleft: redistributable only with license text and an offer of "
                f"corresponding source ({SOURCE_OFFER_ENV})"
            )
        elif category == "permissive":
            note = "permissive: redistributable with license text included"
        else:
            note = "unknown: not redistributable"
        components.append(
            {
                "formula": formula,
                "version": version,
                "license": expression,
                "category": category,
                "license_files": files,
                "keg": str(keg),
                "redistribution": note,
            }
        )

    offer_ok = (
        bool(source_offer) and os.path.isfile(source_offer) and os.path.getsize(source_offer) > 0
    )
    if copyleft and not offer_ok:
        blockers.append(
            "copyleft components "
            + ", ".join(copyleft)
            + f" require a written offer of corresponding source; set {SOURCE_OFFER_ENV} "
            "to a non-empty file that the release owner commits to honor"
        )

    return {
        "status": "blocked" if blockers else "ok",
        "blockers": blockers,
        "tools": tools,
        "libraries": [
            {"name": name, "real": real, "formula": origins[real][0]}
            for name, real in sorted(libraries.items())
            if real in origins
        ],
        "components": components,
        "source_offer": source_offer if offer_ok else None,
    }


def _is_macho(path: str) -> bool:
    with open(path, "rb") as source:
        magic = source.read(4)
    return magic in {b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}


def stage_audio_tools(plan: dict, runtime: Path) -> None:
    """Copy tools, dylibs, and license texts; rewrite load paths to stay inside runtime."""
    bin_dir, lib_dir, license_dir = runtime / "bin", runtime / "lib", runtime / "licenses"
    for directory in (bin_dir, lib_dir, license_dir):
        directory.mkdir(parents=True, exist_ok=True)

    lib_names = {entry["name"] for entry in plan["libraries"]}
    staged: list[tuple[Path, str]] = []
    for entry in plan["libraries"]:
        target = lib_dir / entry["name"]
        if target.exists():
            raise SystemExit(f"runtime/lib already contains {entry['name']}")
        shutil.copyfile(entry["real"], target)
        target.chmod(0o755)
        staged.append((target, "@loader_path/"))

    copied: dict[str, str] = {}
    for name in ("sox", "rec"):
        real = plan["tools"][name]["real"]
        target = bin_dir / name
        if real in copied:
            target.symlink_to(copied[real])
            continue
        shutil.copyfile(real, target)
        target.chmod(0o755)
        copied[real] = name
        staged.append((target, "@executable_path/../lib/"))

    for path, prefix in staged:
        args = ["install_name_tool"]
        if path.parent == lib_dir:
            args += ["-id", f"@loader_path/{path.name}"]
        for ref in macho_references(str(path)):
            if not is_system(ref) and os.path.basename(ref) in lib_names:
                args += ["-change", ref, prefix + os.path.basename(ref)]
        for rpath in rpaths(str(path)):
            if not rpath.startswith("@"):
                args += ["-delete_rpath", rpath]
        if len(args) > 1:
            subprocess.run([*args, str(path)], check=True, capture_output=True)
        subprocess.run(
            ["codesign", "--force", "--sign", "-", str(path)], check=True, capture_output=True
        )

    for component in plan["components"]:
        destination = license_dir / f"{component['formula']}-{component['version']}"
        destination.mkdir(parents=True, exist_ok=True)
        for name in component["license_files"]:
            shutil.copyfile(Path(component["keg"]) / name, destination / name)
            (destination / name).chmod(0o644)
    if plan.get("source_offer"):
        shutil.copyfile(plan["source_offer"], license_dir / "SOURCE-OFFER.txt")
        (license_dir / "SOURCE-OFFER.txt").chmod(0o644)

    verify_relocated(runtime, [path for path, _ in staged])


def verify_relocated(runtime: Path, binaries: list[Path]) -> None:
    for path in binaries:
        for ref in macho_references(str(path)):
            if is_system(ref):
                continue
            if ref.startswith("@loader_path/"):
                resolved = path.parent / ref.removeprefix("@loader_path/")
            elif ref.startswith("@executable_path/"):
                resolved = runtime / "bin" / ref.removeprefix("@executable_path/")
            else:
                raise SystemExit(f"{path.name} still references {ref} outside the runtime")
            if not resolved.resolve().is_file():
                raise SystemExit(f"{path.name} references missing {ref}")
        for rpath in rpaths(str(path)):
            if not rpath.startswith("@"):
                raise SystemExit(f"{path.name} keeps absolute LC_RPATH {rpath}")
    env = {key: value for key, value in os.environ.items() if not key.startswith("DYLD_")}
    sox = runtime / "bin" / "sox"
    subprocess.run([str(sox), "--version"], check=True, capture_output=True, env=env)
    with tempfile.TemporaryDirectory() as scratch:
        tone = Path(scratch) / "tone.flac"
        subprocess.run(
            [str(sox), "-n", "-r", "16000", "-c", "1", str(tone), "synth", "0.05", "sine", "440"],
            check=True,
            capture_output=True,
            env=env,
        )


def scan_runtime(runtime: Path, forbidden_paths: list[str]) -> list[str]:
    """Return privacy findings: user data, secrets, models, or host path leaks."""
    findings = []
    needles = [path.encode() for path in forbidden_paths if path and path != "/"]
    for entry in sorted(runtime.iterdir()):
        if entry.is_dir() and entry.name in FORBIDDEN_TOP_LEVEL_DIRS:
            findings.append(f"forbidden data directory: {entry.name}/")
    for path in sorted(runtime.rglob("*")):
        relative = path.relative_to(runtime).as_posix()
        if ".meeting-wiki" in path.parts:
            findings.append(f"user data directory: {relative}")
        name = path.name
        credential_file = (
            path.is_file() and "credentials" in name.lower() and not name.endswith(CODE_SUFFIXES)
        )
        if name in FORBIDDEN_NAMES or name.startswith(".env.") or credential_file:
            findings.append(f"private file: {relative}")
        if name.lower().endswith(FORBIDDEN_SUFFIXES):
            findings.append(f"private or model artifact: {relative}")
        if path.is_symlink():
            target = os.path.realpath(path)
            if not target.startswith(str(runtime.resolve()) + os.sep):
                findings.append(f"symlink escapes runtime: {relative}")
            continue
        if not path.is_file():
            continue
        data = path.read_bytes()
        for needle in needles:
            if needle in data:
                findings.append(f"host path leak in {relative}")
                break
        for pattern in SECRET_PATTERNS:
            if pattern.search(data):
                findings.append(f"secret-like content in {relative}")
                break
    return findings


def normalize_dist_info(site_packages: Path) -> None:
    """Drop installer cache files and RECORD rows for files pruned from the runtime."""
    for dist_info in sorted(site_packages.glob("*.dist-info")):
        for transient in ("direct_url.json", "uv_cache.json"):
            (dist_info / transient).unlink(missing_ok=True)
        record = dist_info / "RECORD"
        if not record.is_file():
            continue
        kept = []
        for row in record.read_text(encoding="utf-8").splitlines():
            relative = row.rsplit(",", 2)[0]
            if (site_packages / relative).exists() or (site_packages / relative).is_symlink():
                kept.append(row)
        record.write_text("".join(f"{row}\n" for row in kept), encoding="utf-8")


def neutralize_prefix(runtime: Path, prefix: str, placeholder: str = "/install") -> list[str]:
    """Replace the uv install prefix that uv patches into text build metadata."""
    changed = []
    needle = prefix.encode()
    for path in sorted(runtime.rglob("*")):
        if path.is_symlink() or not path.is_file() or _is_macho(str(path)):
            continue
        data = path.read_bytes()
        if needle in data:
            path.write_bytes(data.replace(needle, placeholder.encode()))
            changed.append(path.relative_to(runtime).as_posix())
    return changed


def tree_digest(runtime: Path, exclude: frozenset[str] = frozenset({"manifest.json"})) -> str:
    digest = hashlib.sha256()
    for path in sorted(runtime.rglob("*"), key=lambda item: item.relative_to(runtime).as_posix()):
        relative = path.relative_to(runtime).as_posix()
        if relative in exclude:
            continue
        if path.is_symlink():
            record = f"L {relative} {os.readlink(path)}"
        elif path.is_dir():
            record = f"D {relative}"
        else:
            mode = "x" if os.access(path, os.X_OK) else "-"
            record = f"F {relative} {mode} {hashlib.sha256(path.read_bytes()).hexdigest()}"
        digest.update(record.encode() + b"\n")
    return digest.hexdigest()


def installed_packages(site_packages: Path) -> list[dict]:
    packages = []
    for dist_info in sorted(site_packages.glob("*.dist-info")):
        metadata = (dist_info / "METADATA").read_text(encoding="utf-8", errors="replace")
        fields: dict[str, str] = {}
        for line in metadata.splitlines():
            if not line:
                break
            key, _, value = line.partition(": ")
            fields.setdefault(key, value.strip())
        license_files = sorted(
            path.relative_to(site_packages).as_posix()
            for path in dist_info.rglob("*")
            if path.is_file() and LICENSE_FILE_RE.match(path.name)
        )
        packages.append(
            {
                "name": fields.get("Name", dist_info.name),
                "version": fields.get("Version", ""),
                "license": fields.get("License-Expression") or fields.get("License") or None,
                "license_files": license_files,
            }
        )
    return sorted(packages, key=lambda item: item["name"].lower())


def build_manifest(runtime: Path, plan: dict, python_version: str, lock: Path) -> dict:
    site_packages = runtime / "lib" / f"python{python_version.rsplit('.', 1)[0]}" / "site-packages"
    return {
        "schema_version": SCHEMA_VERSION,
        "platform": "darwin-arm64",
        "python": {
            "implementation": "cpython",
            "version": python_version,
            "distribution": "uv-managed python-build-standalone",
            "license": "PSF-2.0",
            "entrypoint": "bin/python",
        },
        "dependency_lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
        "packages": installed_packages(site_packages),
        "audio_tools": {
            "status": plan["status"],
            "tools": {name: f"bin/{name}" for name in AUDIO_TOOLS if name in plan.get("tools", {})},
            "libraries": [f"lib/{entry['name']}" for entry in plan.get("libraries", [])],
            "components": [
                {key: value for key, value in component.items() if key != "keg"}
                for component in plan.get("components", [])
            ],
            "source_offer": "licenses/SOURCE-OFFER.txt" if plan.get("source_offer") else None,
        },
        "excluded": [
            "user config (config.toml)",
            "API keys and credentials",
            "jobs database, logs, audio, transcripts, wiki, private meetings",
            "ASR and language model files",
        ],
        "tree_sha256": tree_digest(runtime),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    plan_cmd = commands.add_parser("audio-plan")
    plan_cmd.add_argument("--rec", default="")
    plan_cmd.add_argument("--sox", default="")
    plan_cmd.add_argument("--source-offer", default="")
    plan_cmd.add_argument("--out", required=True, type=Path)

    stage_cmd = commands.add_parser("stage-audio")
    stage_cmd.add_argument("--plan", required=True, type=Path)
    stage_cmd.add_argument("--runtime", required=True, type=Path)

    scan_cmd = commands.add_parser("scan")
    scan_cmd.add_argument("--runtime", required=True, type=Path)
    scan_cmd.add_argument("--forbid-path", action="append", default=[])

    manifest_cmd = commands.add_parser("manifest")
    manifest_cmd.add_argument("--runtime", required=True, type=Path)
    manifest_cmd.add_argument("--plan", required=True, type=Path)
    manifest_cmd.add_argument("--python-version", required=True)
    manifest_cmd.add_argument("--lock", required=True, type=Path)

    digest_cmd = commands.add_parser("digest")
    digest_cmd.add_argument("--runtime", required=True, type=Path)

    prefix_cmd = commands.add_parser("neutralize-prefix")
    prefix_cmd.add_argument("--runtime", required=True, type=Path)
    prefix_cmd.add_argument("--prefix", required=True)

    dist_cmd = commands.add_parser("normalize-dist-info")
    dist_cmd.add_argument("--site-packages", required=True, type=Path)

    args = parser.parse_args(argv)
    if args.command == "normalize-dist-info":
        normalize_dist_info(args.site_packages)
        return 0
    if args.command == "neutralize-prefix":
        for relative in neutralize_prefix(args.runtime, args.prefix):
            print(f"  neutralized install prefix in {relative}")
        return 0
    if args.command == "audio-plan":
        plan = plan_audio_tools({"rec": args.rec, "sox": args.sox}, args.source_offer or None)
        args.out.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
        for component in plan["components"]:
            print(
                f"  {component['formula']} {component['version']}: {component['license']} "
                f"[{component['redistribution']}]"
            )
        if plan["status"] != "ok":
            print("\nAUDIO TOOLS BLOCKED: rec/sox cannot be bundled defensibly.", file=sys.stderr)
            for blocker in plan["blockers"]:
                print(f"  - {blocker}", file=sys.stderr)
            return EXIT_BLOCKED
        return 0
    if args.command == "stage-audio":
        stage_audio_tools(json.loads(args.plan.read_text()), args.runtime)
        return 0
    if args.command == "scan":
        findings = scan_runtime(args.runtime, args.forbid_path)
        for finding in findings:
            print(f"  - {finding}", file=sys.stderr)
        return 1 if findings else 0
    if args.command == "manifest":
        manifest = build_manifest(
            args.runtime, json.loads(args.plan.read_text()), args.python_version, args.lock
        )
        (args.runtime / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        )
        return 0
    if args.command == "digest":
        print(tree_digest(args.runtime))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
