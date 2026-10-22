"""Encrypted local backup, verification, and non-destructive restore.

Archive layout: a fixed magic, a plaintext header (KDF and cipher parameters
only, no content metadata), then AES-256-GCM frames. Each frame carries a
final flag and its index in the authenticated data, so reordering, truncation,
and tampering all fail authentication. The plaintext is a streamed tar whose
last member, ``manifest.json``, lists every member with its SHA-256.

The passphrase is accepted only as a function argument from the caller. It is
never written, logged, placed in errors, or stored in the archive.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import secrets
import shutil
import sqlite3
import struct
import tarfile
import tempfile
import time
import tomllib
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from .events import component_version

MAGIC = b"MWBKUP01"
FORMAT = "meeting-wiki-backup"
FORMAT_VERSION = 1
ARCHIVE_SUFFIX = ".mwbackup"
MANIFEST_NAME = "manifest.json"
MIN_PASSPHRASE_LENGTH = 12
MAX_PASSPHRASE_LENGTH = 1024

DEFAULT_SCRYPT_N = 2**17
_MAX_SCRYPT_N = 2**20
_CHUNK_SIZE = 1024 * 1024
_MAX_FRAME = _CHUNK_SIZE + 16
_MAX_HEADER = 4096
_MAX_MANIFEST = 64 * 1024 * 1024
_FINAL = 1

DATABASES = ("memory.db", "jobs.db", "outbox.db", "events.db")
# Directory roots under the data directory, mapped to their manifest category.
_TREE_ROOTS: dict[str, str] = {
    "wiki": "wiki",
    "private/meetings": "wiki",
    "private/briefs": "wiki",
    "transcripts": "transcripts",
    "transcript-data": "transcripts",
    "private/transcripts": "transcripts",
    "private/transcript-data": "transcripts",
    "analysis": "analysis",
    "private/analysis": "analysis",
    "audio": "audio",
    "private/audio": "audio",
    "integrations": "integration_state",
}
_FILE_ROOTS: dict[str, str] = {"desktop-settings.json": "config"}
# Known top-level entries that are deliberately never archived.
_EXCLUDED_TOP_LEVEL: dict[str, str] = {
    "secrets.json": "secret_store",
    "venv": "runtime",
    "runtime": "runtime",
    "logs": "logs",
    "tmp": "temporary",
    "backups": "backups",
}
_SECRET_SUFFIXES = (".key", ".pem", ".p12")
_SKIP_NAMES = {".DS_Store"}


def connect_read_only(path: Path, *, immutable: bool = False) -> sqlite3.Connection:
    """Open SQLite without write access.

    With a ``-wal`` file present, ``mode=ro`` reads committed WAL frames. Without one,
    the database is fully checkpointed, so ``immutable`` reads it without creating
    ``-wal``/``-shm`` side files. Callers use this only for advisory, read-only views.
    """
    resolved = path.resolve()
    if not immutable and not resolved.with_name(resolved.name + "-wal").exists():
        immutable = True
    flag = "immutable=1" if immutable else "mode=ro"
    return sqlite3.connect(f"{resolved.as_uri()}?{flag}", uri=True, timeout=30)


class BackupError(Exception):
    """Carries only a fixed reason code, never paths, contents, or the passphrase."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class _Member:
    name: str
    category: str
    privacy: str
    source: Path


@dataclass
class BackupReport:
    archive: Path
    members: int
    bytes: int
    categories: dict[str, dict[str, int]]
    skipped: dict[str, int]
    remote_shared_storage: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "created": True,
            "archive": str(self.archive),
            "members": self.members,
            "bytes": self.bytes,
            "categories": self.categories,
            "skipped": self.skipped,
            "secrets_included": False,
            "remote_shared_storage": self.remote_shared_storage,
        }


@dataclass
class VerifyReport:
    created_at: str
    app_version: str
    members: int
    categories: dict[str, dict[str, int]]
    databases: dict[str, str] = field(default_factory=dict)
    memory: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "verified": True,
            "created_at": self.created_at,
            "app_version": self.app_version,
            "members": self.members,
            "categories": self.categories,
            "databases": self.databases,
            "memory": self.memory,
        }


def validate_passphrase(passphrase: str, *, creating: bool) -> bytes:
    if not isinstance(passphrase, str) or len(passphrase) > MAX_PASSPHRASE_LENGTH:
        raise BackupError("invalid_passphrase")
    if creating and len(passphrase) < MIN_PASSPHRASE_LENGTH:
        raise BackupError("passphrase_too_short")
    if not passphrase:
        raise BackupError("invalid_passphrase")
    return passphrase.encode("utf-8")


def _derive_key(passphrase: bytes, salt: bytes, n: int, r: int, p: int) -> bytes:
    return Scrypt(salt=salt, length=32, n=n, r=r, p=p).derive(passphrase)


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _unb64(value: object, length: int) -> bytes:
    if not isinstance(value, str):
        raise BackupError("unsupported_archive")
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError:
        raise BackupError("unsupported_archive") from None
    if len(decoded) != length:
        raise BackupError("unsupported_archive")
    return decoded


class _EncryptingWriter(io.RawIOBase):
    def __init__(self, out, key: bytes, nonce_prefix: bytes, header_digest: bytes):
        self._out = out
        self._aead = AESGCM(key)
        self._prefix = nonce_prefix
        self._digest = header_digest
        self._buffer = bytearray()
        self._index = 0
        self._finished = False

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:
        if self._finished:
            raise BackupError("archive_closed")
        self._buffer.extend(data)
        while len(self._buffer) >= _CHUNK_SIZE:
            chunk = bytes(self._buffer[:_CHUNK_SIZE])
            del self._buffer[:_CHUNK_SIZE]
            self._emit(chunk, final=False)
        return len(data)

    def _emit(self, chunk: bytes, *, final: bool) -> None:
        flag = _FINAL if final else 0
        index = struct.pack(">Q", self._index)
        aad = self._digest + index + bytes([flag])
        ciphertext = self._aead.encrypt(self._prefix + index, chunk, aad)
        self._out.write(struct.pack(">BI", flag, len(ciphertext)) + ciphertext)
        self._index += 1

    def finish(self) -> None:
        if not self._finished:
            self._emit(bytes(self._buffer), final=True)
            self._buffer.clear()
            self._finished = True


class _DecryptingReader(io.RawIOBase):
    def __init__(self, source, key: bytes, nonce_prefix: bytes, header_digest: bytes):
        self._source = source
        self._aead = AESGCM(key)
        self._prefix = nonce_prefix
        self._digest = header_digest
        self._buffer = b""
        self._offset = 0
        self._index = 0
        self._done = False

    def readable(self) -> bool:
        return True

    def _next_frame(self) -> None:
        head = self._source.read(5)
        if len(head) != 5:
            raise BackupError("archive_truncated")
        flag, length = struct.unpack(">BI", head)
        if flag not in {0, _FINAL} or not 16 <= length <= _MAX_FRAME:
            raise BackupError("archive_corrupt")
        ciphertext = self._source.read(length)
        if len(ciphertext) != length:
            raise BackupError("archive_truncated")
        index = struct.pack(">Q", self._index)
        try:
            plain = self._aead.decrypt(
                self._prefix + index, ciphertext, self._digest + index + bytes([flag])
            )
        except InvalidTag:
            code = "wrong_passphrase_or_corrupt" if self._index == 0 else "archive_corrupt"
            raise BackupError(code) from None
        self._index += 1
        if flag == _FINAL:
            if self._source.read(1):
                raise BackupError("archive_corrupt")
            self._done = True
        self._buffer, self._offset = plain, 0

    def readinto(self, target) -> int:
        while self._offset >= len(self._buffer):
            if self._done:
                return 0
            self._next_frame()
        count = min(len(target), len(self._buffer) - self._offset)
        target[:count] = self._buffer[self._offset : self._offset + count]
        self._offset += count
        return count


def _open_archive(handle, passphrase: bytes) -> _DecryptingReader:
    if handle.read(len(MAGIC)) != MAGIC:
        raise BackupError("not_a_backup")
    raw_length = handle.read(4)
    if len(raw_length) != 4:
        raise BackupError("archive_truncated")
    (length,) = struct.unpack(">I", raw_length)
    if not 0 < length <= _MAX_HEADER:
        raise BackupError("unsupported_archive")
    header_bytes = handle.read(length)
    if len(header_bytes) != length:
        raise BackupError("archive_truncated")
    try:
        header = json.loads(header_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BackupError("unsupported_archive") from None
    if (
        not isinstance(header, dict)
        or header.get("format") != FORMAT
        or header.get("version") != FORMAT_VERSION
        or header.get("cipher") != "aes-256-gcm"
    ):
        raise BackupError("unsupported_archive")
    kdf = header.get("kdf")
    if not isinstance(kdf, dict) or kdf.get("name") != "scrypt":
        raise BackupError("unsupported_archive")
    n, r, p = kdf.get("n"), kdf.get("r"), kdf.get("p")
    valid_n = isinstance(n, int) and 2**10 <= n <= _MAX_SCRYPT_N and n & (n - 1) == 0
    if not valid_n or r != 8 or p != 1:
        raise BackupError("unsupported_archive")
    salt = _unb64(kdf.get("salt"), 16)
    prefix = _unb64(header.get("nonce_prefix"), 4)
    key = _derive_key(passphrase, salt, n, 8, 1)
    digest = hashlib.sha256(MAGIC + raw_length + header_bytes).digest()
    return _DecryptingReader(handle, key, prefix, digest)


def _is_secret_name(name: str) -> bool:
    lowered = name.lower()
    return (
        lowered == "secrets.json"
        or lowered.startswith(".env")
        or lowered.endswith(_SECRET_SUFFIXES)
    )


def _walk_tree(root: Path, prefix: str, category: str, skipped: Counter[str]) -> list[_Member]:
    base = root.joinpath(*PurePosixPath(prefix).parts)
    if base.is_symlink():
        skipped["symlink"] += 1
        return []
    if not base.is_dir():
        return []
    privacy = "private" if prefix.startswith("private/") else "shared"
    members: list[_Member] = []
    for directory, dirnames, filenames in os.walk(base, followlinks=False):
        current = Path(directory)
        relative_dir = PurePosixPath(*current.relative_to(root).parts)
        kept_dirs = []
        for name in sorted(dirnames):
            # Native-messaging spool events are transient and re-created by the browser.
            if category == "integration_state" and name == "events":
                skipped["transient_integration_events"] += 1
                continue
            if (current / name).is_symlink():
                skipped["symlink"] += 1
                continue
            kept_dirs.append(name)
        dirnames[:] = kept_dirs
        for name in sorted(filenames):
            path = current / name
            if name in _SKIP_NAMES:
                continue
            if _is_secret_name(name):
                skipped["secret_like_file"] += 1
                continue
            if path.is_symlink() or not path.is_file():
                skipped["symlink"] += 1
                continue
            relative = relative_dir / name
            members.append(_Member(f"data/{relative}", category, privacy, path))
    return members


def _config_has_credentials(path: Path) -> bool:
    """True when the config holds anything that looks like an inline credential."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError):
        return True
    webhook = raw.get("webhook")
    url = webhook.get("url", "") if isinstance(webhook, dict) else ""
    if isinstance(url, str) and url:
        parsed = urlparse(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            return True
    return False


def collect_members(data_dir: Path, config_path: Path | None) -> tuple[list[_Member], Counter[str]]:
    """Return regular, non-secret files to archive. Databases are snapshotted separately."""
    root = data_dir.expanduser().resolve()
    skipped: Counter[str] = Counter()
    members: list[_Member] = []
    config_resolved = config_path.expanduser().resolve() if config_path else None
    if config_resolved and config_resolved.is_file() and not config_resolved.is_symlink():
        if _config_has_credentials(config_resolved):
            skipped["config_contains_credential"] += 1
        else:
            members.append(_Member("config/config.toml", "config", "shared", config_resolved))
    for name, category in _FILE_ROOTS.items():
        path = root / name
        if path.is_file() and not path.is_symlink():
            members.append(_Member(f"data/{name}", category, "shared", path))
    for prefix, category in _TREE_ROOTS.items():
        members.extend(_walk_tree(root, prefix, category, skipped))
    known_private = {prefix.split("/", 1)[1] for prefix in _TREE_ROOTS if "/" in prefix}
    if root.is_dir():
        for entry in sorted(root.iterdir()):
            name = entry.name
            if name in _SKIP_NAMES or name in _FILE_ROOTS or name in _TREE_ROOTS:
                continue
            if config_resolved and entry.resolve() == config_resolved:
                continue
            if name in DATABASES or name.endswith(("-wal", "-shm", "-journal")):
                continue
            if name == "private":
                if entry.is_dir() and not entry.is_symlink():
                    for child in entry.iterdir():
                        if child.name not in known_private and child.name not in _SKIP_NAMES:
                            skipped["unrecognized"] += 1
                continue
            if _is_secret_name(name):
                skipped["secret_store" if name == "secrets.json" else "secret_like_file"] += 1
                continue
            skipped[_EXCLUDED_TOP_LEVEL.get(name, "unrecognized")] += 1
    return members, skipped


def _snapshot_databases(root: Path, workdir: Path) -> list[_Member]:
    """Copy each database with the SQLite backup API so WAL contents are consistent."""
    members: list[_Member] = []
    for name in DATABASES:
        source_path = root / name
        if not source_path.is_file() or source_path.is_symlink():
            continue
        destination_path = workdir / name
        source = sqlite3.connect(source_path, timeout=30)
        destination = sqlite3.connect(destination_path)
        try:
            source.backup(destination)
            destination.execute("PRAGMA journal_mode=DELETE")
        except sqlite3.Error:
            raise BackupError("database_snapshot_failed") from None
        finally:
            destination.close()
            source.close()
        os.chmod(destination_path, 0o600)
        members.append(_Member(f"data/{name}", "databases", "mixed", destination_path))
    return members


def _memory_counts(path: Path) -> dict[str, int]:
    if not path.is_file():
        return {}
    connection = connect_read_only(path, immutable=True)
    try:
        counts: dict[str, int] = {}
        for table, label in (("memory_nodes", "nodes"), ("memory_resources", "resources")):
            try:
                counts[label] = int(
                    connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                )
            except sqlite3.Error:
                counts[label] = 0
        return counts
    finally:
        connection.close()


class _HashingReader:
    def __init__(self, handle):
        self._handle = handle
        self.digest = hashlib.sha256()
        self.count = 0

    def read(self, size: int = -1) -> bytes:
        data = self._handle.read(size)
        self.digest.update(data)
        self.count += len(data)
        return data


def _tar_info(name: str, size: int, mtime: float) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mtime = int(mtime)
    info.mode = 0o600
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    return info


def _category_summary(entries: list[dict[str, object]]) -> dict[str, dict[str, int]]:
    summary: dict[str, dict[str, int]] = {}
    for entry in entries:
        bucket = summary.setdefault(str(entry["category"]), {"files": 0, "bytes": 0})
        bucket["files"] += 1
        bucket["bytes"] += int(entry["size"])
    return dict(sorted(summary.items()))


def default_archive_path(data_dir: Path, now: datetime | None = None) -> Path:
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    return data_dir.expanduser().resolve() / "backups" / f"meeting-wiki-{stamp}{ARCHIVE_SUFFIX}"


def create_backup(
    data_dir: Path,
    config_path: Path | None,
    output: Path,
    passphrase: str,
    *,
    storage_provider: str = "local",
    scrypt_n: int = DEFAULT_SCRYPT_N,
) -> BackupReport:
    secret = validate_passphrase(passphrase, creating=True)
    root = data_dir.expanduser().resolve()
    output = output.expanduser().resolve()
    if output.exists():
        raise BackupError("archive_exists")
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    members, skipped = collect_members(root, config_path)
    tmp_root = root / "tmp"
    tmp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    workdir = Path(tempfile.mkdtemp(prefix="backup-", dir=tmp_root))
    partial = output.with_name(f".{output.name}.{secrets.token_hex(6)}.partial")
    try:
        members.extend(_snapshot_databases(root, workdir))
        salt, prefix = secrets.token_bytes(16), secrets.token_bytes(4)
        header = json.dumps(
            {
                "format": FORMAT,
                "version": FORMAT_VERSION,
                "cipher": "aes-256-gcm",
                "chunk_size": _CHUNK_SIZE,
                "kdf": {"name": "scrypt", "n": scrypt_n, "r": 8, "p": 1, "salt": _b64(salt)},
                "nonce_prefix": _b64(prefix),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        raw_length = struct.pack(">I", len(header))
        digest = hashlib.sha256(MAGIC + raw_length + header).digest()
        key = _derive_key(secret, salt, scrypt_n, 8, 1)
        entries: list[dict[str, object]] = []
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(MAGIC + raw_length + header)
            writer = _EncryptingWriter(handle, key, prefix, digest)
            with tarfile.open(fileobj=writer, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for member in sorted(members, key=lambda item: item.name):
                    try:
                        stat = member.source.stat()
                        with member.source.open("rb") as source:
                            reader = _HashingReader(source)
                            archive.addfile(
                                _tar_info(member.name, stat.st_size, stat.st_mtime), reader
                            )
                    except OSError:
                        raise BackupError("source_changed_during_backup") from None
                    entries.append(
                        {
                            "name": member.name,
                            "category": member.category,
                            "privacy": member.privacy,
                            "size": reader.count,
                            "sha256": reader.digest.hexdigest(),
                        }
                    )
                manifest = json.dumps(
                    {
                        "format": FORMAT,
                        "version": FORMAT_VERSION,
                        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
                        "app_version": component_version(),
                        "storage_provider": storage_provider,
                        "remote_shared_storage": storage_provider != "local",
                        "secrets_included": False,
                        "categories": _category_summary(entries),
                        "skipped": dict(sorted(skipped.items())),
                        "memory": _memory_counts(workdir / "memory.db"),
                        "members": entries,
                    },
                    indent=2,
                    sort_keys=True,
                ).encode()
                archive.addfile(
                    _tar_info(MANIFEST_NAME, len(manifest), time.time()), io.BytesIO(manifest)
                )
            writer.finish()
            handle.flush()
            os.fsync(handle.fileno())
        # A hard link fails if the destination appeared meanwhile, so nothing is overwritten.
        try:
            os.link(partial, output)
        except FileExistsError:
            raise BackupError("archive_exists") from None
    finally:
        partial.unlink(missing_ok=True)
        shutil.rmtree(workdir, ignore_errors=True)
    total = sum(int(entry["size"]) for entry in entries)
    return BackupReport(
        archive=output,
        members=len(entries),
        bytes=total,
        categories=_category_summary(entries),
        skipped=dict(sorted(skipped.items())),
        remote_shared_storage=storage_provider != "local",
    )


def _safe_member_name(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (
        not name
        or "\x00" in name
        or "\\" in name
        or path.is_absolute()
        or ".." in path.parts
        or "." in path.parts
        or len(path.parts) < 2
        or path.parts[0] not in {"data", "config"}
        or _is_secret_name(path.name)
    ):
        raise BackupError("unsafe_archive_member")
    if path.parts[0] == "config" and name != "config/config.toml":
        raise BackupError("unsafe_archive_member")
    return path


def _iter_members(reader: _DecryptingReader) -> Iterator[tuple[tarfile.TarInfo, object]]:
    try:
        with tarfile.open(fileobj=reader, mode="r|") as archive:
            for info in archive:
                if not info.isreg():
                    raise BackupError("unsafe_archive_member")
                yield info, archive.extractfile(info)
    except tarfile.TarError:
        raise BackupError("archive_corrupt") from None


def _parse_manifest(data: bytes) -> dict[str, object]:
    try:
        manifest = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BackupError("manifest_invalid") from None
    if (
        not isinstance(manifest, dict)
        or manifest.get("format") != FORMAT
        or manifest.get("version") != FORMAT_VERSION
        or not isinstance(manifest.get("members"), list)
    ):
        raise BackupError("manifest_invalid")
    return manifest


def _check_against_manifest(
    manifest: dict[str, object], observed: dict[str, tuple[int, str]]
) -> list[dict[str, object]]:
    expected: dict[str, tuple[int, str]] = {}
    entries = manifest["members"]
    assert isinstance(entries, list)
    for entry in entries:
        if not isinstance(entry, dict):
            raise BackupError("manifest_invalid")
        name, size, digest = entry.get("name"), entry.get("size"), entry.get("sha256")
        if not isinstance(name, str) or not isinstance(size, int) or not isinstance(digest, str):
            raise BackupError("manifest_invalid")
        expected[name] = (size, digest)
    if expected != observed:
        raise BackupError("manifest_mismatch")
    return entries


def _database_status(path: Path) -> str:
    try:
        connection = connect_read_only(path, immutable=True)
        try:
            row = connection.execute("PRAGMA integrity_check").fetchone()
        finally:
            connection.close()
    except sqlite3.Error:
        return "unreadable"
    return "ok" if row and row[0] == "ok" else "integrity_failed"


def _process_archive(
    archive_path: Path, passphrase: str, staging: Path | None
) -> tuple[dict[str, object], list[dict[str, object]], dict[str, Path]]:
    """Stream-decrypt; hash every member; optionally write members under ``staging``."""
    secret = validate_passphrase(passphrase, creating=False)
    observed: dict[str, tuple[int, str]] = {}
    written: dict[str, Path] = {}
    manifest: dict[str, object] | None = None
    try:
        handle = archive_path.expanduser().open("rb")
    except OSError:
        raise BackupError("archive_unreadable") from None
    with handle:
        reader = _open_archive(handle, secret)
        for info, extracted in _iter_members(reader):
            if manifest is not None:
                raise BackupError("archive_corrupt")
            if info.name == MANIFEST_NAME:
                if info.size > _MAX_MANIFEST:
                    raise BackupError("manifest_invalid")
                manifest = _parse_manifest(extracted.read())
                continue
            name = _safe_member_name(info.name)
            if info.name in observed:
                raise BackupError("unsafe_archive_member")
            digest = hashlib.sha256()
            count = 0
            target: Path | None = None
            out = None
            if staging is not None:
                target = (
                    staging.joinpath(*name.parts[1:])
                    if name.parts[0] == "data"
                    else (staging / "config.toml")
                )
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                out = os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")
            try:
                while chunk := extracted.read(_CHUNK_SIZE):
                    digest.update(chunk)
                    count += len(chunk)
                    if out is not None:
                        out.write(chunk)
            finally:
                if out is not None:
                    out.close()
            observed[info.name] = (count, digest.hexdigest())
            if target is not None:
                written[info.name] = target
    if manifest is None:
        raise BackupError("manifest_missing")
    entries = _check_against_manifest(manifest, observed)
    return manifest, entries, written


def _verify_report(manifest: dict[str, object], entries: list[dict[str, object]]) -> VerifyReport:
    memory = manifest.get("memory")
    return VerifyReport(
        created_at=str(manifest.get("created_at", "")),
        app_version=str(manifest.get("app_version", "")),
        members=len(entries),
        categories=_category_summary(entries),
        memory={
            key: value
            for key, value in (memory.items() if isinstance(memory, dict) else [])
            if isinstance(key, str) and isinstance(value, int)
        },
    )


def verify_backup(archive_path: Path, passphrase: str) -> VerifyReport:
    """Decrypt and hash every member without writing plaintext anywhere."""
    manifest, entries, _written = _process_archive(archive_path, passphrase, None)
    return _verify_report(manifest, entries)


def restore_backup(archive_path: Path, target: Path, passphrase: str) -> VerifyReport:
    """Restore into a new or empty directory only. Existing data is never overwritten."""
    target = target.expanduser().resolve()
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise BackupError("restore_target_not_empty")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.restore-", dir=target.parent))
    try:
        manifest, entries, written = _process_archive(archive_path, passphrase, staging)
        report = _verify_report(manifest, entries)
        for name, path in sorted(written.items()):
            if PurePosixPath(name).parent == PurePosixPath("data") and name.endswith(".db"):
                report.databases[PurePosixPath(name).name] = _database_status(path)
        if any(status != "ok" for status in report.databases.values()):
            raise BackupError("restored_database_invalid")
        if target.exists():
            target.rmdir()
        os.rename(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return report
