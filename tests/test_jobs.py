from __future__ import annotations

import sqlite3
import time

from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import JobState, JobType


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
        connection.execute("UPDATE jobs SET claimed_at=? WHERE id=?", (time.time() - 20, job_id))
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
        connection.execute("UPDATE jobs SET claimed_at=? WHERE id=?", (time.time() - 20, job_id))
    assert queue.reclaim_stale() == 1
    assert queue.get(job_id).state is JobState.DEAD
    assert queue.claim() is None
