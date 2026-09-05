from __future__ import annotations

import json
import sqlite3
import time

import pytest

from meeting_wiki.cli import main
from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import JobStage, JobState, JobType


def test_queue_dedupes_and_completes(tmp_path):
    queue = JobQueue(tmp_path / "jobs.db")
    first = queue.enqueue(JobType.INGEST, {"title": "A"}, "same")
    second = queue.enqueue(JobType.INGEST, {"title": "B"}, "same")
    assert first == second
    job = queue.claim()
    assert job.id == first
    assert job.attempts == 1
    assert job.payload == {"title": "A"}
    queue.complete(job.id)
    assert queue.get(job.id).state is JobState.DONE
    assert queue.claim() is None


def test_failure_backoff_and_dead_letter(tmp_path, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(time, "time", lambda: now[0])
    queue = JobQueue(tmp_path / "jobs.db", max_attempts=2, backoff_base_seconds=5)
    job_id = queue.enqueue(JobType.INGEST, {"x": 1}, "job")
    first = queue.claim()
    assert queue.fail(first.id, "first") is JobState.FAILED
    assert queue.claim() is None
    now[0] += 5
    second = queue.claim()
    assert second.attempts == 2
    assert queue.fail(second.id, "second") is JobState.DEAD
    assert queue.get(job_id).last_error == "second"
    assert queue.claim() is None


def test_reclaim_stale_running_job(tmp_path):
    queue = JobQueue(tmp_path / "jobs.db", visibility_timeout_seconds=10)
    job_id = queue.enqueue(JobType.INGEST, {"x": 1}, "job")
    queue.claim()
    with sqlite3.connect(queue.path) as connection:
        connection.execute(
            "UPDATE jobs SET claimed_at=?, lease_expires_at=? WHERE id=?",
            (time.time() - 20, time.time() - 1, job_id),
        )
    assert queue.reclaim_stale() == 1
    reclaimed = queue.claim()
    assert reclaimed.id == job_id
    assert reclaimed.attempts == 2


def test_claim_order_is_fifo(tmp_path):
    queue = JobQueue(tmp_path / "jobs.db")
    ids = [queue.enqueue(JobType.INGEST, {"n": number}, f"job-{number}") for number in range(3)]
    claimed = []
    for _ in ids:
        job = queue.claim()
        claimed.append(job.id)
        queue.complete(job.id)
    assert claimed == ids


def test_reclaim_exhausted_running_job_marks_dead(tmp_path):
    queue = JobQueue(tmp_path / "jobs.db", max_attempts=1, visibility_timeout_seconds=10)
    job_id = queue.enqueue(JobType.INGEST, {"x": 1}, "job")
    queue.claim()
    with sqlite3.connect(queue.path) as connection:
        connection.execute(
            "UPDATE jobs SET claimed_at=?, lease_expires_at=? WHERE id=?",
            (time.time() - 20, time.time() - 1, job_id),
        )
    assert queue.reclaim_stale() == 1
    assert queue.get(job_id).state is JobState.DEAD
    assert queue.claim() is None


def test_summary_counts_all_job_states(tmp_path, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(time, "time", lambda: now[0])
    queue = JobQueue(tmp_path / "jobs.db", max_attempts=1)
    pending_id = queue.enqueue(JobType.INGEST, {"title": "Pending"}, "pending")
    running_id = queue.enqueue(JobType.INGEST, {"title": "Running"}, "running")
    dead_id = queue.enqueue(JobType.INGEST, {"title": "Dead"}, "dead")

    assert queue.claim().id == pending_id
    queue.complete(pending_id)
    assert queue.claim().id == running_id
    assert queue.claim().id == dead_id
    queue.fail(dead_id, "dead")

    assert queue.summary() == {
        "total": 3,
        "pending": 0,
        "running": 1,
        "failed": 0,
        "dead": 1,
        "done": 1,
        "action_required": 1,
        "active": 1,
        "stages": {
            "transcribing": 0,
            "analyzing": 0,
            "rendering": 0,
            "integrating": 0,
        },
    }


def test_retry_resets_failed_or_dead_job_without_exposing_payload(tmp_path):
    queue = JobQueue(tmp_path / "jobs.db", max_attempts=1)
    job_id = queue.enqueue(JobType.INGEST, {"private": True, "title": "Secret"}, "job")
    job = queue.claim()
    queue.fail(job.id, "RuntimeError: secret provider response")

    retried = queue.retry(job_id)

    assert retried.id == job_id
    assert retried.state is JobState.PENDING
    assert retried.attempts == 0
    assert retried.last_error is None
    assert queue.claim().id == job_id


def test_retry_rejects_running_or_completed_jobs(tmp_path):
    queue = JobQueue(tmp_path / "jobs.db")
    job_id = queue.enqueue(JobType.INGEST, {"title": "Meeting"}, "job")
    queue.claim()
    with pytest.raises(ValueError, match="running"):
        queue.retry(job_id)
    queue.complete(job_id)
    with pytest.raises(ValueError, match="done"):
        queue.retry(job_id)


def test_cli_status_summary_and_retry_are_payload_safe(tmp_path, capsys):
    data_dir = tmp_path / "data"
    config = tmp_path / "config.toml"
    config.write_text(f'data_dir = "{data_dir}"\n')
    queue = JobQueue(data_dir / "jobs.db", max_attempts=1)
    job_id = queue.enqueue(
        JobType.INGEST,
        {"private": True, "title": "Private career conversation"},
        "private-job",
    )
    job = queue.claim()
    queue.fail(job.id, "RuntimeError: sensitive provider response")

    assert main(["--config", str(config), "status", "--summary"]) == 0
    summary_output = capsys.readouterr().out
    summary = json.loads(summary_output)
    assert summary["dead"] == 1
    assert summary["action_required"] == 1
    assert "Private career conversation" not in summary_output
    assert "sensitive provider response" not in summary_output

    assert main(["--config", str(config), "retry", str(job_id)]) == 0
    retry_output = capsys.readouterr().out
    assert json.loads(retry_output) == {
        "job_id": job_id,
        "state": "pending",
        "retried": True,
    }
    assert "Private career conversation" not in retry_output


def test_stage_and_heartbeat_renew_running_lease(tmp_path, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(time, "time", lambda: now[0])
    queue = JobQueue(tmp_path / "jobs.db", visibility_timeout_seconds=10)
    job_id = queue.enqueue(JobType.INGEST, {"title": "Meeting"}, "job")
    queue.claim()

    queue.set_stage(job_id, JobStage.ANALYZING)
    now[0] += 9
    assert queue.heartbeat(job_id) is True
    now[0] += 2
    assert queue.reclaim_stale() == 0
    assert queue.get(job_id).stage is JobStage.ANALYZING

    now[0] += 9
    assert queue.reclaim_stale() == 1
    reclaimed = queue.get(job_id)
    assert reclaimed.state is JobState.PENDING
    assert reclaimed.stage is JobStage.QUEUED


def test_old_database_schema_migrates_without_losing_jobs(tmp_path):
    path = tmp_path / "jobs.db"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type TEXT NOT NULL,
                state TEXT NOT NULL,
                payload TEXT NOT NULL,
                attempts INTEGER NOT NULL,
                max_attempts INTEGER NOT NULL,
                not_before REAL NOT NULL,
                dedupe_key TEXT NOT NULL UNIQUE,
                last_error TEXT,
                claimed_at REAL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            INSERT INTO jobs
                (job_type, state, payload, attempts, max_attempts, not_before,
                 dedupe_key, created_at, updated_at)
            VALUES ('ingest', 'done', '{"title":"Preserved"}', 1, 5, 0,
                    'legacy', 1, 1);
            """
        )

    queue = JobQueue(path)

    job = queue.get(1)
    assert job.payload == {"title": "Preserved"}
    assert job.stage is JobStage.DONE
    with sqlite3.connect(path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
    assert {"stage", "lease_expires_at"}.issubset(columns)


def test_terminal_updates_require_running_state(tmp_path):
    queue = JobQueue(tmp_path / "jobs.db")
    job_id = queue.enqueue(JobType.INGEST, {"title": "Meeting"}, "job")
    queue.claim()
    queue.complete(job_id)

    with pytest.raises(ValueError, match="not running"):
        queue.complete(job_id)
    with pytest.raises(ValueError, match="not running"):
        queue.fail(job_id, "stale worker")
