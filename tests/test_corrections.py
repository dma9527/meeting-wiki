from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

import meeting_wiki.worker as worker_module
from meeting_wiki.cli import main
from meeting_wiki.config import AppConfig
from meeting_wiki.corrections import (
    apply_correction,
    build_inbox,
    is_ambiguous_label,
    plan_correction,
)
from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import (
    ActionItem,
    JobType,
    MeetingAnalysis,
    MeetingInput,
    Participant,
    TopicInsight,
    TranscriptResult,
    TranscriptSegment,
)
from meeting_wiki.providers.base import CalendarEvent
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.providers.registry import ProviderBundle
from meeting_wiki.worker import Worker, enqueue_meeting

REMOTE_TEXT = "Please finish the migration by Friday."


class _FakeTranscriber:
    name = "fake"

    def __init__(self, result: TranscriptResult):
        self.result = result

    def transcribe(self, audio_path, language=None, context=None):
        return self.result

    def health(self):
        return True, "ok"


class _FakeLLM:
    name = "fake"

    def __init__(self, result: MeetingAnalysis):
        self.result = result

    def analyze(self, meeting, transcript):
        return self.result

    def health(self):
        return True, "ok"


class _FakeCalendar:
    name = "none"

    def upcoming(self, within_minutes):
        return []

    def match(self, occurred_at, tolerance_minutes=15):
        return None


class _RewritingCalendar:
    """Unconditionally rewrites a meeting's title and occurred_at (stays shared)."""

    name = "ics"

    def __init__(self, event: CalendarEvent):
        self.event = event

    def upcoming(self, within_minutes):
        return []

    def match(self, occurred_at, tolerance_minutes=15):
        return self.event


class _FakeNotification:
    name = "fake"

    def notify(self, title, body, level="info"):
        return None


class _FakeTask:
    name = "fake"

    def propose(self, item, meeting_key):
        return None


def _transcript() -> TranscriptResult:
    return TranscriptResult(
        text=(
            f"Local User: I will own the rollout.\nRemote participant: {REMOTE_TEXT}\nspk_1: Noted."
        ),
        segments=[
            TranscriptSegment(speaker="Local User", text="I will own the rollout."),
            TranscriptSegment(speaker="Remote participant", text=REMOTE_TEXT),
            TranscriptSegment(speaker="spk_1", text="Noted."),
        ],
        provider="fake",
        model="fake",
        diarized=True,
    )


def _analysis() -> MeetingAnalysis:
    return MeetingAnalysis(
        title="Weekly rollout sync",
        summary=["The team synced on rollout ownership."],
        participants=[Participant(name="Local User"), Participant(name="Remote participant")],
        action_items=[ActionItem(owner="Remote participant", action="Finish the migration")],
        topics=[TopicInsight(topic="Rollout", insight="Ownership still ambiguous")],
    )


def _bundle(storage, calendar=None):
    return ProviderBundle(
        transcription=_FakeTranscriber(_transcript()),
        llm=_FakeLLM(_analysis()),
        storage=storage,
        private_storage=storage,
        calendar=calendar or _FakeCalendar(),
        notification=_FakeNotification(),
        task=_FakeTask(),
    )


def _meeting(tmp_path, *, private=False) -> MeetingInput:
    audio = tmp_path / "audio" / "rollout.wav"
    audio.parent.mkdir(parents=True, exist_ok=True)
    audio.write_bytes(b"fake")
    return MeetingInput(
        title="Weekly rollout sync",
        audio_path=audio,
        attendees=["Local User", "Alex"],
        private=private,
        occurred_at=datetime(2026, 9, 4, 15, 0, tzinfo=UTC),
    )


def _auto_meeting(tmp_path) -> MeetingInput:
    """A recording with no explicit title/time, as the desktop app enqueues it."""
    audio = tmp_path / "audio" / "auto.wav"
    audio.parent.mkdir(parents=True, exist_ok=True)
    audio.write_bytes(b"fake")
    return MeetingInput(
        title="Meeting 2026-09-03 231500",
        title_explicit=False,
        audio_path=audio,
        attendees=[],
        occurred_at=datetime(2026, 9, 3, 23, 15, tzinfo=UTC),
        occurred_at_explicit=False,
    )


def _prepare(tmp_path, monkeypatch, *, private=False, meeting=None, calendar=None):
    """Ingest one meeting through the worker so a shared wiki and a job both exist."""
    config = AppConfig(data_dir=tmp_path)
    storage = LocalFileStorage(tmp_path)
    monkeypatch.setattr(
        worker_module, "build_providers", lambda _config: _bundle(storage, calendar)
    )
    enqueue_meeting(config, meeting if meeting is not None else _meeting(tmp_path, private=private))
    worker = Worker(config)
    assert worker.run_once() is True
    return config, storage, worker.queue


def _only_meeting_key(storage) -> str:
    keys = [
        key
        for key in storage.list_keys("wiki/meetings/")
        if key.endswith(".md") and not key.endswith("index.md")
    ]
    assert len(keys) == 1
    return keys[0]


def test_is_ambiguous_label_matches_sentinel_and_auto_ids():
    for label in ["Remote participant", "spk_0", "spk_12", "SPEAKER_01", "speaker 2", "spk-3"]:
        assert is_ambiguous_label(label) is True
    for label in ["Local User", "Sam Rivera", "Remote", "speaker of the house", "", None]:
        assert is_ambiguous_label(label) is False


def test_build_inbox_derives_from_shared_records_without_exposing_text(tmp_path, monkeypatch):
    _config, storage, _queue = _prepare(tmp_path, monkeypatch)
    inbox = build_inbox(storage)
    assert len(inbox) == 1
    entry = inbox[0]
    assert entry["meeting_key"].startswith("wiki/meetings/")
    assert entry["title"] == "Weekly rollout sync"
    labels = {item["label"]: item["segments"] for item in entry["labels"]}
    assert labels == {"Remote participant": 1, "spk_1": 1}
    assert REMOTE_TEXT not in json.dumps(inbox)


def test_build_inbox_excludes_private_meetings(tmp_path, monkeypatch):
    _config, storage, _queue = _prepare(tmp_path, monkeypatch, private=True)
    assert storage.list_keys("wiki/") == []
    assert build_inbox(storage) == []


def test_plan_identifies_clean_and_stale_surfaces(tmp_path, monkeypatch):
    _config, storage, _queue = _prepare(tmp_path, monkeypatch)
    meeting_key = _only_meeting_key(storage)
    plan = plan_correction(storage, meeting_key, {"Remote participant": "Sam Rivera"})
    assert plan.mapping == {"Remote participant": "Sam Rivera"}
    assert plan.clean_surfaces == [meeting_key]
    assert plan.reanalysis_nondeterministic is True
    assert plan.requires_original_source is True
    kinds = {(surface["kind"], surface["key"]) for surface in plan.stale_surfaces}
    assert ("person-timeline", "wiki/people/remote-participant.md") in kinds
    assert ("action-items", "wiki/action-items/active.md") in kinds


def test_plan_rejects_unknown_nonambiguous_or_invalid_names(tmp_path, monkeypatch):
    _config, storage, _queue = _prepare(tmp_path, monkeypatch)
    meeting_key = _only_meeting_key(storage)
    with pytest.raises(ValueError, match="not an ambiguous label"):
        plan_correction(storage, meeting_key, {"Local User": "Sam"})
    with pytest.raises(ValueError, match="not present in meeting"):
        plan_correction(storage, meeting_key, {"spk_9": "Sam"})
    with pytest.raises(ValueError, match="itself ambiguous"):
        plan_correction(storage, meeting_key, {"Remote participant": "spk_2"})
    with pytest.raises(ValueError, match="invalid characters"):
        plan_correction(storage, meeting_key, {"Remote participant": "Sam | Injected"})


def test_plan_rejects_private_or_out_of_tree_keys(tmp_path, monkeypatch):
    _config, storage, _queue = _prepare(tmp_path, monkeypatch)
    for bad_key in [
        "private/meetings/secret.md",
        "wiki/meetings/../../private/x.md",
        "analysis/2026-09-04-x.json",
    ]:
        with pytest.raises(ValueError):
            plan_correction(storage, bad_key, {"Remote participant": "Sam"})


def test_stale_surfaces_names_the_concrete_decision_page():
    """A decision owned by a corrected label reports its exact page key."""
    from meeting_wiki.corrections import _stale_surfaces
    from meeting_wiki.wiki import slugify, stable_id

    source = "2026-09-04-weekly-rollout-sync-0123456789abcdef"
    analysis = {"decisions": [{"title": "Adopt staged rollout", "owner": "Remote participant"}]}
    surfaces = _stale_surfaces(analysis, {"Remote participant": "Sam Rivera"}, source)
    decision = next(surface for surface in surfaces if surface["kind"] == "decision-owner")
    slug = slugify("Adopt staged rollout")
    expected_id = stable_id(source, "Adopt staged rollout")
    assert decision["key"] == f"wiki/decisions/2026-09-04-{slug}-{expected_id}.md"
    assert decision["label"] == "Remote participant"


def test_stale_surfaces_reports_archive_for_completed_actions():
    """A completed action owned by a corrected label sits on archive.md, not active.md."""
    from meeting_wiki.corrections import _stale_surfaces

    source = "2026-09-04-weekly-rollout-sync-0123456789abcdef"
    analysis = {
        "action_items": [
            {"owner": "Remote participant", "action": "Finish the migration", "done": True}
        ]
    }
    surfaces = _stale_surfaces(analysis, {"Remote participant": "Sam Rivera"}, source)
    kinds = {(surface["kind"], surface["key"]) for surface in surfaces}
    assert ("action-items", "wiki/action-items/archive.md") in kinds
    assert ("action-items", "wiki/action-items/active.md") not in kinds
    archive = next(s for s in surfaces if s["key"] == "wiki/action-items/archive.md")
    assert archive["label"] == "Remote participant"
    assert archive["count"] == 1


def test_apply_reenqueues_original_job_with_merged_mapping(tmp_path, monkeypatch):
    _config, storage, queue = _prepare(tmp_path, monkeypatch)
    meeting_key = _only_meeting_key(storage)
    before = len(queue.list())

    result = apply_correction(storage, queue, meeting_key, {"Remote participant": "Sam Rivera"})

    assert result["queued"] is True
    assert "job_id" in result
    assert len(queue.list()) == before + 1
    new_job = queue.get(int(result["job_id"]))
    assert new_job.job_type is JobType.INGEST
    assert new_job.payload["speaker_corrections"] == {"Remote participant": "Sam Rivera"}
    serialized = json.dumps(result)
    assert REMOTE_TEXT not in serialized
    assert "audio" not in serialized
    assert "payload" not in serialized


def test_reprocess_corrects_transcript_records_and_clears_inbox(tmp_path, monkeypatch):
    config, storage, queue = _prepare(tmp_path, monkeypatch)
    meeting_key = _only_meeting_key(storage)
    apply_correction(storage, queue, meeting_key, {"Remote participant": "Sam Rivera"})

    worker = Worker(config)
    assert worker.run_once() is True

    assert _only_meeting_key(storage) == meeting_key
    transcript_data = [
        key for key in storage.list_keys("transcript-data/") if key.endswith(".json")
    ]
    assert len(transcript_data) == 1
    data = json.loads(storage.read_text(transcript_data[0]))
    speakers = {segment["speaker"] for segment in data["segments"]}
    assert "Sam Rivera" in speakers
    assert "Remote participant" not in speakers
    remaining = {item["label"] for entry in build_inbox(storage) for item in entry["labels"]}
    assert "Remote participant" not in remaining
    # The old label persists on append-only surfaces: this is the documented limit.
    assert storage.exists("wiki/people/remote-participant.md")


def test_apply_without_matching_job_reports_unavailable(tmp_path, monkeypatch):
    _config, storage, _queue = _prepare(tmp_path, monkeypatch)
    meeting_key = _only_meeting_key(storage)
    empty_queue = JobQueue(tmp_path / "empty.db")
    result = apply_correction(storage, empty_queue, meeting_key, {"Remote participant": "Sam"})
    assert result["error"] == "original_job_unavailable"
    assert "plan" in result
    assert "job_id" not in result


def test_sequential_corrections_accumulate_and_do_not_revert(tmp_path, monkeypatch):
    """A second correction must build on the first, never revert it."""
    config, storage, queue = _prepare(tmp_path, monkeypatch)
    meeting_key = _only_meeting_key(storage)

    first = apply_correction(storage, queue, meeting_key, {"Remote participant": "Sam Rivera"})
    assert first["queued"] is True
    assert Worker(config).run_once() is True

    # Only spk_1 is still ambiguous, so that is all the next correction can target.
    remaining = {item["label"] for entry in build_inbox(storage) for item in entry["labels"]}
    assert remaining == {"spk_1"}

    second = apply_correction(storage, queue, meeting_key, {"spk_1": "Alex Chen"})
    assert second["queued"] is True
    second_job = queue.get(int(second["job_id"]))
    assert second_job.payload["speaker_corrections"] == {
        "Remote participant": "Sam Rivera",
        "spk_1": "Alex Chen",
    }
    assert Worker(config).run_once() is True

    transcript_data = [
        key for key in storage.list_keys("transcript-data/") if key.endswith(".json")
    ]
    assert len(transcript_data) == 1
    data = json.loads(storage.read_text(transcript_data[0]))
    speakers = {segment["speaker"] for segment in data["segments"]}
    assert {"Sam Rivera", "Alex Chen"} <= speakers
    assert "Remote participant" not in speakers
    assert "spk_1" not in speakers
    assert build_inbox(storage) == []


def test_apply_reports_source_unavailable_when_audio_missing(tmp_path, monkeypatch):
    """A matched job whose audio was deleted is not queued for a doomed reprocess."""
    _config, storage, queue = _prepare(tmp_path, monkeypatch)
    meeting_key = _only_meeting_key(storage)
    before = len(queue.list())
    (tmp_path / "audio" / "rollout.wav").unlink()

    result = apply_correction(storage, queue, meeting_key, {"Remote participant": "Sam"})

    assert result["error"] == "original_source_unavailable"
    assert "plan" in result
    assert "job_id" not in result
    assert len(queue.list()) == before


def test_apply_matches_job_after_calendar_rewrote_title_and_time(tmp_path, monkeypatch):
    """The dual-audio case: calendar enrichment shifts the stem, but ingest_id links back."""
    event = CalendarEvent(
        event_id="evt-9",
        title="Weekly rollout sync",
        start=datetime(2026, 9, 4, 15, 0, tzinfo=UTC),
        end=datetime(2026, 9, 4, 16, 0, tzinfo=UTC),
        attendees=["Local User", "Alex", "Jordan"],
        private_hint=False,
    )
    config, storage, queue = _prepare(
        tmp_path,
        monkeypatch,
        meeting=_auto_meeting(tmp_path),
        calendar=_RewritingCalendar(event),
    )
    meeting_key = _only_meeting_key(storage)
    # The rendered stem reflects the enriched title/time, not the raw payload.
    assert "weekly-rollout-sync" in meeting_key
    before = len(queue.list())

    result = apply_correction(storage, queue, meeting_key, {"Remote participant": "Sam Rivera"})

    assert result.get("queued") is True
    assert "job_id" in result
    assert len(queue.list()) == before + 1
    new_job = queue.get(int(result["job_id"]))
    assert new_job.payload["speaker_corrections"] == {"Remote participant": "Sam Rivera"}

    # Reprocessing overwrites the same meeting page rather than creating a new one.
    worker = Worker(config)
    assert worker.run_once() is True
    assert _only_meeting_key(storage) == meeting_key


def test_cli_correct_review_gate_and_payload_privacy(tmp_path, monkeypatch, capsys):
    config_obj, storage, queue = _prepare(tmp_path, monkeypatch)
    config_path = tmp_path / "config.toml"
    config_path.write_text(f'data_dir = "{config_obj.data_dir}"\n')
    meeting_key = _only_meeting_key(storage)
    jobs_before = len(queue.list())
    capsys.readouterr()  # discard the worker's completion output

    assert main(["--config", str(config_path), "correct-inbox"]) == 0
    inbox_output = capsys.readouterr().out
    assert "Remote participant" in inbox_output
    assert REMOTE_TEXT not in inbox_output

    plan_args = [
        "--config",
        str(config_path),
        "correct",
        "--meeting",
        meeting_key,
        "--speaker",
        "Remote participant=Sam Rivera",
    ]
    assert main(plan_args) == 0
    plan_output = capsys.readouterr().out
    assert '"clean_surfaces"' in plan_output
    assert REMOTE_TEXT not in plan_output
    assert len(JobQueue(config_obj.data_dir / "jobs.db").list()) == jobs_before

    assert main([*plan_args, "--reprocess"]) == 0
    reprocess_output = capsys.readouterr().out
    assert '"job_id"' in reprocess_output
    assert REMOTE_TEXT not in reprocess_output
    assert len(JobQueue(config_obj.data_dir / "jobs.db").list()) == jobs_before + 1


def test_cli_correct_rejects_bad_mapping(tmp_path, monkeypatch, capsys):
    config_obj, storage, _queue = _prepare(tmp_path, monkeypatch)
    config_path = tmp_path / "config.toml"
    config_path.write_text(f'data_dir = "{config_obj.data_dir}"\n')
    meeting_key = _only_meeting_key(storage)
    capsys.readouterr()  # discard the worker's completion output
    exit_code = main(
        ["--config", str(config_path), "correct", "--meeting", meeting_key, "--speaker", "bogus"]
    )
    assert exit_code == 1
    assert json.loads(capsys.readouterr().out)["error"] == "invalid_mapping"
