"""Read-only meeting deletion preview.

The preview enumerates every artifact a meeting deletion would touch, and how,
without modifying anything. Databases are opened read-only. Nothing in this
module deletes, rewrites, or calls an external service. External task links
are reported by host and digest only, never by full URL or action text.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

from .backup import connect_read_only
from .outbox import journal_ref
from .providers.base import StorageProvider
from .providers.local_storage import LocalFileStorage
from .wiki import parse_frontmatter, stable_id

_STEM = re.compile(r"\d{4}-\d{2}-\d{2}-([0-9a-f]{16})")
_INGEST_ID = re.compile(r"[0-9a-f]{16}")
_SHARED_PREFIX = "wiki/meetings/"
_PRIVATE_PREFIX = "private/meetings/"


class DeletionPreviewError(ValueError):
    """Fixed reason code only; never echoes the key or any meeting content."""


def _normalize_key(meeting_key: str) -> tuple[str, bool]:
    normalized = (meeting_key or "").replace("\\", "/").lstrip("/")
    parts = PurePosixPath(normalized).parts
    if not normalized or "\x00" in normalized or ".." in parts:
        raise DeletionPreviewError("invalid_meeting_key")
    if not normalized.endswith(".md") or normalized.endswith("/index.md"):
        raise DeletionPreviewError("invalid_meeting_key")
    for prefix, private in ((_SHARED_PREFIX, False), (_PRIVATE_PREFIX, True)):
        if normalized.startswith(prefix) and "/" not in normalized[len(prefix) :]:
            return normalized, private
    raise DeletionPreviewError("invalid_meeting_key")


def _artifact(kind: str, key: str, location: str, effect: str, exists: bool, **extra: object):
    return {
        "kind": kind,
        "key": key,
        "location": location,
        "effect": effect,
        "exists": exists,
        **extra,
    }


def _open(path: Path) -> sqlite3.Connection | None:
    if not path.is_file():
        return None
    try:
        connection = connect_read_only(path)
    except sqlite3.Error:
        return None
    connection.row_factory = sqlite3.Row
    return connection


def _external_host(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    parsed = urlparse(value)
    return f"{parsed.scheme}://{parsed.hostname}" if parsed.hostname else None


def _linked_pages(
    storage: StorageProvider, prefix: str, needle: str, kind: str, effect: str, skip: str
) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    for key in storage.list_keys(prefix):
        if not key.endswith(".md") or key == skip:
            continue
        text = storage.read_text(key) or ""
        occurrences = text.count(needle)
        if occurrences:
            found.append(_artifact(kind, key, storage.name, effect, True, references=occurrences))
    return found


def _job_audio(
    data_dir: Path, rows: list[sqlite3.Row], private: bool, stem: str
) -> list[dict[str, object]]:
    managed = (data_dir / "audio").resolve()
    audio: list[dict[str, object]] = []
    seen: set[str] = set()
    for row in rows:
        try:
            payload = json.loads(str(row["payload"]))
        except json.JSONDecodeError:
            continue
        for field in ("audio_path", "mic_audio_path", "system_audio_path"):
            raw = payload.get(field)
            if not isinstance(raw, str) or not raw:
                continue
            path = Path(raw)
            try:
                relative = path.resolve().relative_to(managed)
            except (OSError, ValueError):
                # Imported files outside the data directory are never deleted; no path shown.
                if "external" not in seen:
                    seen.add("external")
                    audio.append(_artifact("imported_audio", "", "local", "retain", True))
                continue
            key = f"audio/{PurePosixPath(*relative.parts)}"
            if key not in seen:
                seen.add(key)
                audio.append(_artifact("audio", key, "local", "delete", path.is_file()))
    if private:
        directory = data_dir / "private" / "audio"
        if directory.is_dir() and not directory.is_symlink():
            for path in sorted(directory.glob(f"{stem}-*")):
                if path.is_file() and not path.is_symlink():
                    audio.append(
                        _artifact("audio", f"private/audio/{path.name}", "local", "delete", True)
                    )
    return audio


def preview_meeting_deletion(
    data_dir: Path,
    shared_storage: StorageProvider,
    meeting_key: str,
    *,
    allow_private: bool = False,
) -> dict[str, object]:
    root = data_dir.expanduser().resolve()
    key, private = _normalize_key(meeting_key)
    if private and not allow_private:
        raise DeletionPreviewError("private_meeting_requires_allow_private")
    storage: StorageProvider = LocalFileStorage(root) if private else shared_storage
    text = storage.read_text(key)
    if text is None:
        raise DeletionPreviewError("meeting_not_found")
    fields, _body = parse_frontmatter(text)
    page_private = fields.get("privacy") == "private" or fields.get("type") == "private-meeting"
    if page_private != private:
        raise DeletionPreviewError("privacy_mismatch")
    tree = "private/" if private else ""
    resource = str(fields.get("resource") or "")
    expected = f"{tree}transcripts/"
    stem = resource[len(expected) : -len(".txt")] if resource.startswith(expected) else ""
    match = _STEM.fullmatch(stem) if resource.endswith(".txt") else None
    if match is None:
        raise DeletionPreviewError("meeting_has_no_transcript_record")
    source_id = match.group(1)
    ingest_id = str(fields.get("ingest_id") or "")
    if not _INGEST_ID.fullmatch(ingest_id):
        ingest_id = source_id
    page_stem = PurePosixPath(key).stem
    location = storage.name

    artifacts = [_artifact("meeting_page", key, location, "delete", True)]
    for kind, artifact_key in (
        ("transcript_text", f"{tree}transcripts/{stem}.txt"),
        ("transcript_data", f"{tree}transcript-data/{stem}.json"),
        ("analysis", f"{tree}analysis/{stem}.json"),
    ):
        artifacts.append(
            _artifact(kind, artifact_key, location, "delete", storage.exists(artifact_key))
        )

    link = f"[[meetings/{page_stem}]]"
    if private:
        artifacts += _linked_pages(storage, "private/briefs/", link, "brief", "edit", key)
    else:
        decision_keys: list[str] = []
        for decision_key in storage.list_keys("wiki/decisions/"):
            if not decision_key.endswith(".md") or decision_key.endswith("/index.md"):
                continue
            decision_fields, _ = parse_frontmatter(storage.read_text(decision_key) or "")
            if decision_fields.get("source") == f"meetings/{page_stem}":
                decision_keys.append(decision_key)
                artifacts.append(_artifact("decision", decision_key, location, "delete", True))
        superseded_refs = {f"decisions/{PurePosixPath(item).stem}" for item in decision_keys}
        for decision_key in storage.list_keys("wiki/decisions/"):
            if decision_key in decision_keys or not decision_key.endswith(".md"):
                continue
            decision_fields, _ = parse_frontmatter(storage.read_text(decision_key) or "")
            if decision_fields.get("superseded_by") in superseded_refs:
                artifacts.append(
                    _artifact("decision_supersession", decision_key, location, "edit", True)
                )
        marker = f"<!-- source:{page_stem} -->"
        artifacts += _linked_pages(storage, "wiki/people/", marker, "person_timeline", "edit", key)
        artifacts += _linked_pages(storage, "wiki/topics/", marker, "topic_timeline", "edit", key)
        artifacts += _linked_pages(
            storage, "wiki/action-items/", link, "action_item_rows", "edit", key
        )
        artifacts += _linked_pages(storage, "wiki/briefs/", link, "brief", "edit", key)
        for index_key in ("wiki/meetings/index.md", "wiki/decisions/index.md"):
            if storage.exists(index_key):
                artifacts.append(_artifact("index", index_key, location, "rebuild", True))

    jobs: list[dict[str, object]] = []
    job_rows: list[sqlite3.Row] = []
    connection = _open(root / "jobs.db")
    if connection is not None:
        with closing(connection):
            for row in connection.execute("SELECT id, state, stage, payload FROM jobs ORDER BY id"):
                try:
                    payload = json.loads(str(row["payload"]))
                except json.JSONDecodeError:
                    continue
                if payload.get("ingest_id") != ingest_id:
                    continue
                job_rows.append(row)
                jobs.append(
                    {
                        "job_id": row["id"],
                        "state": row["state"],
                        "stage": row["stage"],
                        "effect": "delete",
                    }
                )
    artifacts += _job_audio(root, job_rows, private, stem)

    memory: dict[str, object] = {
        "nodes": {},
        "edges": 0,
        "resources": [],
        "shared_entities_effect": "retain",
    }
    connection = _open(root / "memory.db")
    if connection is not None:
        privacy = "private" if private else "shared"
        with closing(connection):
            nodes = {
                str(row["node_type"]): int(row["count"])
                for row in connection.execute(
                    "SELECT node_type, COUNT(*) AS count FROM memory_nodes "
                    "WHERE source_id=? AND privacy=? GROUP BY node_type ORDER BY node_type",
                    (ingest_id, privacy),
                )
            }
            edges = connection.execute(
                "SELECT COUNT(*) FROM memory_edges WHERE source_id=?", (ingest_id,)
            ).fetchone()[0]
            meeting_node = f"meeting:{stable_id(ingest_id)}"
            resources = [
                {
                    "resource_id": row["resource_id"],
                    "host": _external_host(row["url"]),
                    "effect": "delete",
                }
                for row in connection.execute(
                    "SELECT resource_id, url FROM memory_resources WHERE meeting_node_id=? "
                    "ORDER BY resource_id",
                    (meeting_node,),
                )
            ]
        memory.update(
            {
                "nodes": nodes,
                "edges": int(edges),
                "resources": resources,
                "meeting_node_id": meeting_node,
            }
        )

    tasks: list[dict[str, object]] = []
    connection = None if private else _open(root / "outbox.db")
    if connection is not None:
        with closing(connection):
            for row in connection.execute(
                "SELECT action_key, provider, state, external_url FROM task_outbox "
                "WHERE source_id=? ORDER BY action_key",
                (source_id,),
            ):
                host = _external_host(row["external_url"])
                tasks.append(
                    {
                        "ref": journal_ref(str(row["action_key"])),
                        "provider": row["provider"],
                        "state": row["state"],
                        "external_host": host,
                        "local_effect": "delete",
                        "external_effect": "retain_external"
                        if host or row["state"] in {"delivered", "sending"}
                        else "none",
                    }
                )

    event_count = 0
    connection = _open(root / "events.db")
    if connection is not None and jobs:
        ids = [int(job["job_id"]) for job in jobs]
        with closing(connection):
            placeholders = ",".join("?" for _ in ids)
            event_count = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM events WHERE job_id IN ({placeholders})", ids
                ).fetchone()[0]
            )
    backups_dir = root / "backups"
    backups = (
        sum(1 for path in backups_dir.glob("*.mwbackup") if path.is_file())
        if backups_dir.is_dir()
        else 0
    )

    plan = {
        "meeting_key": key,
        "privacy": "private" if private else "shared",
        "ingest_id": ingest_id,
        "artifacts": artifacts,
        "jobs": jobs,
        "memory": memory,
        "tasks": tasks,
    }
    digest = hashlib.sha256(
        json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    notes = [
        "preview_only_nothing_deleted",
        "imported_source_files_are_never_deleted",
        "shared_person_and_topic_nodes_are_retained",
    ]
    if tasks:
        notes.append("external_tasks_must_be_removed_in_the_task_system")
    if location != "local":
        notes.append("shared_artifacts_are_remote_copies")
    if backups:
        notes.append("existing_backups_still_contain_this_meeting")
    return {
        **plan,
        "storage": location,
        "events": {"rows": event_count, "effect": "retain", "content": "codes_only"},
        "backups": {"archives": backups, "effect": "retain"},
        "plan_digest": digest,
        "deleted": False,
        "notes": notes,
    }
