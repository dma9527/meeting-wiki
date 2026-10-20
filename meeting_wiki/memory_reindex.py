"""Rebuild local canonical memory from stored meeting artifacts."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from pydantic import ValidationError

from .memory import MemoryEntry, MemoryStore
from .models import MeetingAnalysis, MeetingInput, MeetingType, TranscriptResult
from .wiki import parse_frontmatter

_STEM = r"\d{4}-\d{2}-\d{2}-[0-9a-f]{16}"
_SHARED_RESOURCE = re.compile(rf"transcripts/({_STEM})\.txt")
_PRIVATE_RESOURCE = re.compile(rf"private/transcripts/({_STEM})\.txt")
_INGEST_ID = re.compile(r"[0-9a-f]{16}")
_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024


@dataclass
class ReindexReport:
    """Counts only; no titles, paths, or meeting text, so it is safe to print."""

    shared: int = 0
    private: int = 0
    skipped: Counter[str] = field(default_factory=Counter)

    def to_dict(self) -> dict[str, object]:
        return {
            "meetings_indexed": self.shared + self.private,
            "shared": self.shared,
            "private": self.private,
            "skipped": dict(sorted(self.skipped.items())),
        }


class _Skip(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _read_regular_file(root: Path, key: str) -> str:
    """Read ``root/key`` only when it is a regular file reached without any symlink."""
    candidate = root.joinpath(*PurePosixPath(key).parts)
    try:
        resolved = candidate.resolve(strict=True)
    except (FileNotFoundError, NotADirectoryError):
        raise _Skip("missing_artifacts") from None
    except OSError:
        raise _Skip("unreadable_artifacts") from None
    try:
        relative = resolved.relative_to(root)
    except ValueError:
        raise _Skip("unsafe_path") from None
    # A symlink anywhere in the chain would change the canonical path.
    if PurePosixPath(*relative.parts) != PurePosixPath(key):
        raise _Skip("unsafe_path")
    if not resolved.is_file():
        raise _Skip("missing_artifacts")
    if resolved.stat().st_size > _MAX_ARTIFACT_BYTES:
        raise _Skip("oversized_artifacts")
    try:
        return resolved.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        raise _Skip("unreadable_artifacts") from None


def _meeting_keys(root: Path, prefix: str) -> list[str]:
    directory = root.joinpath(*PurePosixPath(prefix).parts)
    if directory.is_symlink() or not directory.is_dir():
        return []
    return sorted(
        f"{prefix}/{path.name}"
        for path in directory.iterdir()
        if path.name.endswith(".md") and path.name != "index.md"
    )


def _occurred_at(raw: object, stem: str) -> datetime:
    if isinstance(raw, str) and raw:
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except ValueError:
            pass
    return datetime.fromisoformat(stem[:10]).replace(tzinfo=UTC)


def _load_entry(root: Path, meeting_key: str, private_tree: bool) -> tuple[str, MemoryEntry]:
    fields, _body = parse_frontmatter(_read_regular_file(root, meeting_key))
    page_private = fields.get("privacy") == "private" or fields.get("type") == "private-meeting"
    if page_private and not private_tree:
        # A shared-tree page that claims to be private is never indexed as shared.
        raise _Skip("privacy_mismatch")
    pattern = _PRIVATE_RESOURCE if private_tree else _SHARED_RESOURCE
    match = pattern.fullmatch(str(fields.get("resource") or ""))
    if match is None:
        raise _Skip("unrecognized_source")
    stem = match.group(1)
    tree = "private/" if private_tree else ""
    try:
        analysis = MeetingAnalysis.model_validate_json(
            _read_regular_file(root, f"{tree}analysis/{stem}.json")
        )
        transcript = TranscriptResult.model_validate_json(
            _read_regular_file(root, f"{tree}transcript-data/{stem}.json")
        )
    except ValidationError:
        raise _Skip("invalid_artifacts") from None
    if (analysis.private or analysis.meeting_type is MeetingType.ONE_ON_ONE) and not private_tree:
        raise _Skip("privacy_mismatch")
    ingest_id = str(fields.get("ingest_id") or "")
    if not _INGEST_ID.fullmatch(ingest_id):
        ingest_id = stem[11:]
    meeting = MeetingInput(
        title=analysis.title,
        occurred_at=_occurred_at(fields.get("timestamp"), stem),
        meeting_type=analysis.meeting_type,
        private=private_tree,
        ingest_id=ingest_id,
    )
    analysis = analysis.model_copy(update={"private": private_tree})
    return ingest_id, (meeting, analysis, transcript, meeting_key)


def collect_entries(data_dir: Path) -> tuple[list[MemoryEntry], ReindexReport]:
    """Load shared and private meetings; private wins when both share an ingest id."""
    root = data_dir.expanduser().resolve()
    report = ReindexReport()
    selected: dict[str, MemoryEntry] = {}
    # The private tree is read last so a private copy replaces a shared one.
    for prefix, private_tree in (("wiki/meetings", False), ("private/meetings", True)):
        for meeting_key in _meeting_keys(root, prefix):
            try:
                ingest_id, entry = _load_entry(root, meeting_key, private_tree)
            except _Skip as skip:
                report.skipped[skip.reason] += 1
                continue
            if ingest_id in selected:
                report.skipped["superseded_duplicate"] += 1
            selected[ingest_id] = entry
    entries = sorted(selected.values(), key=lambda entry: (entry[0].occurred_at, entry[3]))
    for _meeting, analysis, _transcript, _key in entries:
        if analysis.private:
            report.private += 1
        else:
            report.shared += 1
    return entries, report


def reindex_memory(data_dir: Path) -> ReindexReport:
    """Atomically replace data_dir/memory.db contents with the stored artifacts."""
    entries, report = collect_entries(data_dir)
    MemoryStore(data_dir.expanduser().resolve() / "memory.db").rebuild(entries)
    return report
