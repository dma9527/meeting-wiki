from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from test_engine import FakeCalendar, bundle

from meeting_wiki.captures import CaptureManifest, meeting_from_manifest
from meeting_wiki.cli import build_parser, meeting_from_args, redacted_job_record
from meeting_wiki.config import AppConfig
from meeting_wiki.engine import MeetingEngine
from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import JobType, MeetingInput
from meeting_wiki.providers.base import CalendarEvent

STARTED = datetime(2026, 9, 4, 15, 5, tzinfo=UTC)


def _meeting(tmp_path, **overrides):
    values = {
        "audio_path": tmp_path / "meeting.wav",
        "title": "Zoom meeting",
        "title_explicit": False,
        "occurred_at": STARTED,
        "recording_started_at": STARTED,
    }
    values.update(overrides)
    return MeetingInput(**values)


def _event(private_hint: bool) -> CalendarEvent:
    return CalendarEvent(
        event_id="event-1",
        title="Architecture sync",
        start=STARTED - timedelta(minutes=5),
        end=STARTED + timedelta(minutes=55),
        attendees=["Alex", "Sam", "Kim"],
        private_hint=private_hint,
    )


def test_calendar_mode_without_a_matching_event_is_private(tmp_path, transcript, analysis):
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(None)
    engine = MeetingEngine(AppConfig(data_dir=tmp_path), providers)

    resolved = engine.resolve(_meeting(tmp_path, require_calendar_match=True))

    assert resolved.classification_frozen is True
    assert resolved.private is True


def test_calendar_mode_follows_a_matching_shared_or_private_event(tmp_path, transcript, analysis):
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    engine = MeetingEngine(AppConfig(data_dir=tmp_path), providers)

    providers.calendar = FakeCalendar(_event(private_hint=False))
    shared = engine.resolve(_meeting(tmp_path, require_calendar_match=True))
    assert shared.private is False
    assert shared.calendar_event_id == "event-1"

    providers.calendar = FakeCalendar(_event(private_hint=True))
    assert engine.resolve(_meeting(tmp_path, require_calendar_match=True)).private is True


def test_default_mode_keeps_unmatched_recordings_shared(tmp_path, transcript, analysis):
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(None)
    engine = MeetingEngine(AppConfig(data_dir=tmp_path), providers)
    assert engine.resolve(_meeting(tmp_path)).private is False


def test_capture_manifest_carries_the_calendar_requirement(tmp_path):
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    audio = audio_dir / "meeting.wav"
    audio.write_bytes(b"fake")
    base = {
        "version": 1,
        "audio_path": str(audio),
        "title": "Zoom meeting",
        "title_explicit": False,
        "private": False,
        "recording_started_at": STARTED.isoformat(),
    }
    config = AppConfig(data_dir=tmp_path)
    legacy = meeting_from_manifest(config, CaptureManifest.model_validate(base))
    assert legacy.require_calendar_match is False
    manifest = CaptureManifest.model_validate({**base, "require_calendar_match": True})
    assert meeting_from_manifest(config, manifest).require_calendar_match is True


def test_ingest_flag_sets_the_calendar_requirement():
    args = build_parser().parse_args(
        ["ingest", "--audio", "x.wav", "--title", "Zoom", "--require-calendar-match"]
    )
    assert meeting_from_args(args).require_calendar_match is True
    plain = build_parser().parse_args(["ingest", "--audio", "x.wav"])
    assert meeting_from_args(plain).require_calendar_match is False


def _job(tmp_path, payload, job_type=JobType.INGEST):
    queue = JobQueue(tmp_path / "jobs.db")
    job_id = queue.enqueue(job_type, payload, dedupe_key=json.dumps(payload, sort_keys=True))
    return queue.get(job_id)


def test_recovery_label_never_shows_private_or_unclassified_titles(tmp_path):
    private = _job(tmp_path, {
        "title": "Career talk with Sam",
        "private": True,
        "audio_path": "/tmp/a.wav",
        "recording_started_at": "2026-09-04T15:05:00+00:00",
    })
    record = redacted_job_record(private)
    assert record["label"] == "Private recording"
    assert record["captured_at"] == "2026-09-04T15:05:00+00:00"
    assert "Career" not in json.dumps(record)

    unfrozen = _job(tmp_path, {
        "title": "Budget review",
        "private": False,
        "audio_path": "/tmp/b.wav",
        "recording_started_at": "2026-09-04T16:05:00+00:00",
    })
    assert redacted_job_record(unfrozen)["label"] == "Recording"
    assert "Budget" not in json.dumps(redacted_job_record(unfrozen))


def test_recovery_label_shows_a_frozen_shared_title_and_imports(tmp_path):
    shared = _job(tmp_path, {
        "title": "Architecture sync\nwith\tteam " + "x" * 200,
        "private": False,
        "classification_frozen": True,
        "audio_path": "/tmp/c.wav",
        "occurred_at": "2026-09-04T17:00:00+00:00",
        "occurred_at_explicit": True,
    })
    record = redacted_job_record(shared)
    assert record["label"].startswith("Architecture sync with team ")
    assert len(record["label"]) <= 80
    assert "\n" not in record["label"]
    assert record["captured_at"] == "2026-09-04T17:00:00+00:00"

    imported = _job(
        tmp_path,
        {"title": "Imported meeting", "private": False, "transcript_path": "/tmp/t.txt"},
    )
    record = redacted_job_record(imported)
    assert record["label"] == "Imported transcript"
    assert record["captured_at"] is None

    notify = _job(tmp_path, {"meeting": "x"}, job_type=JobType.NOTIFY)
    assert redacted_job_record(notify)["label"] == "Notification"
