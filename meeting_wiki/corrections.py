"""Speaker-label corrections.

Correction candidates are derived only from shared ``transcript-data`` and
``analysis`` records; ``private/`` is never read. A correction is a two-phase,
review-before-reprocess flow:

- ``plan_correction`` returns a privacy-safe plan. It reports the one surface a
  reprocess overwrites cleanly (the meeting page) and the append-only surfaces
  that keep the old label because the deterministic renderer never deletes
  content it did not load. Re-analysis is LLM-driven and non-deterministic.
- ``apply_correction`` re-enqueues the meeting's original ingest job with an
  exact OLD=NEW mapping merged in, preserving meeting identity. The reprocess
  job never proposes external tasks; tasks delivered earlier stay as they are
  and the plan reports them by count and host only.

Neither phase returns transcript text, analysis bodies, or job payloads to
callers; only labels, counts, and surface keys cross the boundary.
"""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import closing
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

from .jobs import JobQueue
from .models import JobState, JobType, MeetingInput
from .providers.base import StorageProvider
from .wiki import slugify, stable_id

_REMOTE_SENTINEL = "Remote participant"
_AUTO_LABEL = re.compile(r"(?:spk|speaker)[ _-]?\d+", re.IGNORECASE)


def is_ambiguous_label(label: str | None) -> bool:
    """A label is ambiguous if it is the remote sentinel or an auto-diarized id."""
    if not label:
        return False
    stripped = label.strip()
    return stripped == _REMOTE_SENTINEL or bool(_AUTO_LABEL.fullmatch(stripped))


def _frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return {}
    result: dict[str, str] = {}
    for line in lines[1:]:
        if line == "---":
            break
        if ":" in line:
            key, value = line.split(":", 1)
            result[key.strip()] = value.strip().strip('"')
    return result


def _has_private_part(key: str) -> bool:
    normalized = key.replace("\\", "/").lstrip("/")
    return any(part.lower() == "private" for part in PurePosixPath(normalized).parts)


def _stem_from_resource(resource: str) -> str | None:
    """Map a shared ``transcripts/<stem>.txt`` resource to its stem."""
    if not resource:
        return None
    normalized = resource.replace("\\", "/").lstrip("/")
    parts = PurePosixPath(normalized).parts
    if ".." in parts or _has_private_part(normalized):
        return None
    if not normalized.startswith("transcripts/") or not normalized.endswith(".txt"):
        return None
    return normalized[len("transcripts/") : -len(".txt")]


def _load_json(raw: str | None) -> dict[str, object]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _ambiguous_label_counts(raw: str | None) -> list[dict[str, object]]:
    """Extract ambiguous speaker labels and segment counts, never text."""
    data = _load_json(raw)
    counts: dict[str, int] = {}
    for segment in data.get("segments", []):
        if not isinstance(segment, dict):
            continue
        speaker = segment.get("speaker")
        if isinstance(speaker, str) and is_ambiguous_label(speaker):
            counts[speaker] = counts.get(speaker, 0) + 1
    return [{"label": label, "segments": counts[label]} for label in sorted(counts)]


def build_inbox(storage: StorageProvider) -> list[dict[str, object]]:
    """List shared meetings whose transcript records still carry ambiguous labels."""
    entries: list[dict[str, object]] = []
    for key in storage.list_keys("wiki/meetings/"):
        if not key.endswith(".md") or key.endswith("/index.md") or _has_private_part(key):
            continue
        meta = _frontmatter(storage.read_text(key) or "")
        if meta.get("privacy") == "private" or meta.get("type") == "private-meeting":
            continue
        stem = _stem_from_resource(meta.get("resource", ""))
        if stem is None:
            continue
        transcript_data_key = f"transcript-data/{stem}.json"
        if _has_private_part(transcript_data_key):
            continue
        labels = _ambiguous_label_counts(storage.read_text(transcript_data_key))
        if not labels:
            continue
        entries.append(
            {
                "meeting_key": key,
                "title": meta.get("title", stem),
                "timestamp": meta.get("timestamp", ""),
                "meeting_type": meta.get("meeting_type", "generic"),
                "labels": labels,
            }
        )
    entries.sort(
        key=lambda entry: (str(entry["timestamp"]), str(entry["meeting_key"])),
        reverse=True,
    )
    return entries


def _validate_new_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned or len(cleaned) > 200:
        raise ValueError("replacement name must be 1-200 characters")
    if "|" in cleaned or any(ord(character) < 32 for character in cleaned):
        raise ValueError("replacement name has invalid characters")
    if is_ambiguous_label(cleaned):
        raise ValueError("replacement name is itself ambiguous")
    return cleaned


@dataclass
class CorrectionPlan:
    meeting_key: str
    mapping: dict[str, str]
    clean_surfaces: list[str]
    stale_surfaces: list[dict[str, object]] = field(default_factory=list)
    reanalysis_nondeterministic: bool = True
    requires_original_source: bool = True
    task_delivery: str = "suppressed"
    retained_external_tasks: dict[str, object] = field(
        default_factory=lambda: {"count": 0, "hosts": []}
    )

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _resolve_shared_records(
    storage: StorageProvider, meeting_key: str
) -> tuple[str, str, str, str, str]:
    """Return (normalized_key, stem, ingest_id, transcript_data_key, analysis_key)."""
    normalized = meeting_key.replace("\\", "/").lstrip("/")
    parts = PurePosixPath(normalized).parts
    if ".." in parts or _has_private_part(normalized):
        raise ValueError("meeting key is not a shared wiki meeting")
    if (
        not normalized.startswith("wiki/meetings/")
        or not normalized.endswith(".md")
        or normalized.endswith("/index.md")
    ):
        raise ValueError("meeting key is not a shared wiki meeting")
    text = storage.read_text(normalized)
    if text is None:
        raise ValueError("meeting not found")
    meta = _frontmatter(text)
    if meta.get("privacy") == "private" or meta.get("type") == "private-meeting":
        raise ValueError("meeting is private")
    stem = _stem_from_resource(meta.get("resource", ""))
    if stem is None:
        raise ValueError("meeting has no shared transcript record")
    ingest_id = meta.get("ingest_id", "")
    return normalized, stem, ingest_id, f"transcript-data/{stem}.json", f"analysis/{stem}.json"


def _stale_surfaces(
    analysis: dict[str, object], mapping: dict[str, str], source: str
) -> list[dict[str, object]]:
    # ``source`` is the meeting-page stem ``{date}-{slug}-{id}``; its leading 10
    # chars are the date the renderer uses to name each decision page.
    date = source[:10]
    surfaces: list[dict[str, object]] = []
    participants = analysis.get("participants", [])
    action_items = analysis.get("action_items", [])
    decisions = analysis.get("decisions", [])
    for old in sorted(mapping):
        people = sum(
            1 for item in participants if isinstance(item, dict) and item.get("name") == old
        )
        if people:
            surfaces.append(
                {
                    "key": f"wiki/people/{slugify(old)}.md",
                    "kind": "person-timeline",
                    "label": old,
                    "count": people,
                }
            )
        # Open rows carry forward on active.md, completed rows on archive.md;
        # report each surface the OLD label actually sits on after reprocess.
        open_actions = sum(
            1
            for item in action_items
            if isinstance(item, dict) and item.get("owner") == old and not item.get("done")
        )
        done_actions = sum(
            1
            for item in action_items
            if isinstance(item, dict) and item.get("owner") == old and item.get("done")
        )
        if open_actions:
            surfaces.append(
                {
                    "key": "wiki/action-items/active.md",
                    "kind": "action-items",
                    "label": old,
                    "count": open_actions,
                }
            )
        if done_actions:
            surfaces.append(
                {
                    "key": "wiki/action-items/archive.md",
                    "kind": "action-items",
                    "label": old,
                    "count": done_actions,
                }
            )
        for item in decisions:
            if isinstance(item, dict) and item.get("owner") == old:
                title = str(item.get("title", ""))
                decision_id = stable_id(source, title)
                surfaces.append(
                    {
                        "key": f"wiki/decisions/{date}-{slugify(title)}-{decision_id}.md",
                        "kind": "decision-owner",
                        "label": old,
                        "count": 1,
                    }
                )
    return surfaces


def _retained_external_tasks(outbox_path: Path | None, source_id: str) -> dict[str, object]:
    """Count tasks already sent for this meeting; hosts only, never URLs or text."""
    retained: dict[str, object] = {"count": 0, "hosts": []}
    if outbox_path is None or not outbox_path.is_file():
        return retained
    try:
        connection = sqlite3.connect(f"{outbox_path.resolve().as_uri()}?mode=ro", uri=True)
    except sqlite3.Error:
        return retained
    hosts: set[str] = set()
    count = 0
    with closing(connection):
        try:
            rows = connection.execute(
                "SELECT external_url FROM task_outbox WHERE source_id=? "
                "AND state IN ('delivered', 'sending')",
                (source_id,),
            ).fetchall()
        except sqlite3.Error:
            return retained
    for (url,) in rows:
        count += 1
        parsed = urlparse(url) if isinstance(url, str) else None
        if parsed is not None and parsed.hostname:
            hosts.add(f"{parsed.scheme}://{parsed.hostname}")
    return {"count": count, "hosts": sorted(hosts)}


def plan_correction(
    storage: StorageProvider,
    meeting_key: str,
    mapping: dict[str, str],
    *,
    outbox_path: Path | None = None,
) -> CorrectionPlan:
    """Validate a mapping against shared records and describe reprocess effects."""
    if not mapping:
        raise ValueError("at least one OLD=NEW mapping is required")
    normalized_key, stem, _ingest_id, transcript_data_key, analysis_key = _resolve_shared_records(
        storage, meeting_key
    )
    present = {
        str(entry["label"])
        for entry in _ambiguous_label_counts(storage.read_text(transcript_data_key))
    }
    validated: dict[str, str] = {}
    for old, new in mapping.items():
        if not is_ambiguous_label(old):
            raise ValueError(f"not an ambiguous label: {old}")
        if old not in present:
            raise ValueError(f"label not present in meeting: {old}")
        validated[old] = _validate_new_name(new)
    source = normalized_key.removeprefix("wiki/meetings/").removesuffix(".md")
    stale = _stale_surfaces(_load_json(storage.read_text(analysis_key)), validated, source)
    return CorrectionPlan(
        meeting_key=normalized_key,
        mapping=validated,
        clean_surfaces=[normalized_key],
        stale_surfaces=stale,
        # The outbox keys tasks by the engine source id, the stem after its date.
        retained_external_tasks=_retained_external_tasks(outbox_path, stem[11:]),
    )


def _meeting_stem(meeting: MeetingInput) -> str:
    """Reproduce the engine's transcript stem for a meeting input."""
    date = meeting.occurred_at.strftime("%Y-%m-%d")
    source_id = stable_id(
        meeting.occurred_at.isoformat(),
        meeting.title,
        str(meeting.audio_path or meeting.transcript_path or "manual"),
    )
    return f"{date}-{source_id}"


def _find_ingest_job(queue: JobQueue, ingest_id: str, stem: str) -> tuple[int, MeetingInput] | None:
    """Locate the meeting's MOST RECENT ingest job so corrections accumulate.

    Prefer the enrichment-invariant ``ingest_id`` carried by both the meeting
    page and the job payload; fall back to the recomputed stem only for pages
    written before ``ingest_id`` existed. Each reprocess re-enqueues a new job
    that preserves ``ingest_id`` and the merged ``speaker_corrections``, so the
    highest-id match is the correct merge base. Matching the first (original,
    empty) job would silently drop every prior correction on the next reprocess.
    """
    latest: tuple[int, MeetingInput] | None = None
    for job in queue.list():
        if job.job_type is not JobType.INGEST:
            continue
        try:
            meeting = MeetingInput.model_validate(job.payload)
        except Exception:
            continue
        matched = meeting.ingest_id == ingest_id if ingest_id else _meeting_stem(meeting) == stem
        if matched and (latest is None or job.id > latest[0]):
            latest = (job.id, meeting)
    return latest


def _source_available(meeting: MeetingInput) -> bool:
    """Best-effort check that the sources reprocess re-reads still exist.

    Mirrors ``MeetingEngine._transcribe`` selection order so the UI does not show
    a success toast for a reprocess that would fail asynchronously.
    """
    if meeting.transcript_path is not None:
        return meeting.transcript_path.exists()
    streams = [path for path in (meeting.mic_audio_path, meeting.system_audio_path) if path]
    if streams:
        return all(path.exists() for path in streams)
    if meeting.audio_path is not None:
        return meeting.audio_path.exists()
    return False


def apply_correction(
    storage: StorageProvider,
    queue: JobQueue,
    meeting_key: str,
    mapping: dict[str, str],
    *,
    outbox_path: Path | None = None,
) -> dict[str, object]:
    """Re-enqueue the meeting's original ingest job with the OLD=NEW mapping merged in."""
    plan = plan_correction(storage, meeting_key, mapping, outbox_path=outbox_path)
    _key, stem, ingest_id, _transcript_data_key, _analysis_key = _resolve_shared_records(
        storage, meeting_key
    )
    match = _find_ingest_job(queue, ingest_id, stem)
    if match is None:
        return {"error": "original_job_unavailable", "plan": plan.to_dict()}
    _job_id, meeting = match
    if not _source_available(meeting):
        # The job exists but its audio/transcript is gone, so an async reprocess
        # would fail. Report a distinct status instead of a misleading success.
        return {"error": "original_source_unavailable", "plan": plan.to_dict()}
    merged = {**meeting.speaker_corrections, **plan.mapping}
    corrected = meeting.model_copy(
        update={"speaker_corrections": merged, "suppress_task_delivery": True}
    )
    source = str(corrected.audio_path or corrected.transcript_path or corrected.title)
    base = f"ingest:{corrected.occurred_at.isoformat()}:{source}"
    dedupe = f"{base}:correct:{stable_id(json.dumps(merged, sort_keys=True))}"
    new_job_id = queue.enqueue(JobType.INGEST, corrected.model_dump(mode="json"), dedupe)
    # The same mapping dedupes to an existing job, which may never run again.
    job = queue.get(new_job_id)
    state = job.state if job is not None else JobState.DEAD
    if state is JobState.DONE:
        return {
            "error": "correction_already_applied",
            "job_id": new_job_id,
            "job_state": state.value,
            "queued": False,
            "plan": plan.to_dict(),
        }
    if state in {JobState.DEAD, JobState.DISMISSED}:
        return {
            "error": "correction_job_inactive",
            "job_id": new_job_id,
            "job_state": state.value,
            "queued": False,
            "plan": plan.to_dict(),
        }
    return {"job_id": new_job_id, "queued": True, "plan": plan.to_dict()}
