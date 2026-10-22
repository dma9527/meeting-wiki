from __future__ import annotations

import sqlite3

import pytest

from meeting_wiki.diagnostics import encode_diagnostic, safe_job_diagnostic
from meeting_wiki.events import Component, EventCode, EventJournal, component_version
from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import JobStage, JobType


def test_journal_records_codes_timestamps_and_component_version(tmp_path):
    journal = EventJournal(tmp_path / "events.db")
    assert journal.record(
        EventCode.JOB_STAGE,
        Component.QUEUE,
        job_id=3,
        stage_from="queued",
        stage_to="transcribing",
    )
    [event] = journal.recent()
    assert event["code"] == "job.stage"
    assert event["component"] == "queue"
    assert event["component_version"] == component_version()
    assert event["ts"] > 0
    assert (tmp_path / "events.db").stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    "fields",
    [
        {"outcome": "Architecture Design Review"},
        {"stage_to": "/Users/test-user/audio.wav"},
        {"error_type": "https://tasks.example/t?token=secret"},
        {"ref": "not-a-digest"},
        {"http_status": 700},
        {"attempt": True},
    ],
)
def test_journal_rejects_free_text_and_out_of_range_values(tmp_path, fields):
    journal = EventJournal(tmp_path / "events.db")
    with pytest.raises(ValueError):
        journal.record(EventCode.TASK_FAILED, Component.OUTBOX, **fields)
    assert journal.recent() == []


def test_journal_write_failure_never_breaks_the_queue(tmp_path, monkeypatch):
    journal = EventJournal(tmp_path / "events.db")

    def broken_connect():
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(journal, "_connect", broken_connect)
    queue = JobQueue(tmp_path / "jobs.db", journal=journal)
    queue.enqueue(JobType.INGEST, {"title": "x"}, "dedupe-1")
    job = queue.claim()
    queue.set_stage(job.id, JobStage.TRANSCRIBING)
    queue.complete(job.id)
    assert queue.get(job.id).stage is JobStage.DONE


def test_queue_journals_stage_transitions_and_failure_outcome(tmp_path):
    journal = EventJournal(tmp_path / "events.db")
    queue = JobQueue(tmp_path / "jobs.db", max_attempts=1, journal=journal)
    queue.enqueue(JobType.INGEST, {"title": "Architecture Design Review"}, "dedupe-1")
    job = queue.claim()
    queue.set_stage(job.id, JobStage.TRANSCRIBING)
    diagnostic = safe_job_diagnostic(
        TimeoutError("secret provider text"),
        stage="transcribing",
        attempt=1,
        max_attempts=1,
        provider="fake",
    )
    queue.fail(job.id, encode_diagnostic(diagnostic))
    queue.retry(job.id)

    events = journal.recent()
    assert [event["code"] for event in events] == [
        "job.claimed",
        "job.stage",
        "job.dead",
        "job.retried",
    ]
    assert events[1]["stage_from"] == "queued"
    assert events[1]["stage_to"] == "transcribing"
    assert events[2]["error_type"] == "TimeoutError"
    assert events[2]["stage_from"] == "transcribing"
    text = str(events)
    assert "Architecture" not in text
    assert "secret" not in text


def test_journal_ignores_unsafe_legacy_error_text(tmp_path):
    journal = EventJournal(tmp_path / "events.db")
    queue = JobQueue(tmp_path / "jobs.db", journal=journal)
    queue.enqueue(JobType.INGEST, {}, "dedupe-1")
    job = queue.claim()
    queue.fail(job.id, "RuntimeError: /Users/test-user/private/audio.wav failed")
    failed = journal.recent()[-1]
    assert failed["code"] == "job.failed"
    assert "error_type" not in failed
    assert "/Users" not in str(failed)
