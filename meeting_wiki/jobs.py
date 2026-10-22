"""Durable local job queue with at-least-once delivery and idempotent keys."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

from .diagnostics import decode_diagnostic
from .events import Component, EventCode, EventJournal
from .models import JobRecord, JobStage, JobState, JobType

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    not_before REAL NOT NULL DEFAULT 0,
    dedupe_key TEXT NOT NULL UNIQUE,
    last_error TEXT,
    claimed_at REAL,
    stage TEXT NOT NULL DEFAULT 'queued',
    lease_expires_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(state, not_before, id);
"""


class JobQueue:
    def __init__(
        self,
        path: Path,
        max_attempts: int = 5,
        backoff_base_seconds: int = 2,
        visibility_timeout_seconds: int = 900,
        journal: EventJournal | None = None,
    ):
        self.journal = journal
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        self.max_attempts = max_attempts
        self.backoff_base_seconds = backoff_base_seconds
        self.visibility_timeout_seconds = visibility_timeout_seconds
        self._initialize()

    def _event(self, code: EventCode, **fields: object) -> None:
        if self.journal is not None:
            self.journal.record(code, Component.QUEUE, **fields)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(_SCHEMA)
            columns = {
                str(row["name"]) for row in connection.execute("PRAGMA table_info(jobs)").fetchall()
            }
            added_stage = "stage" not in columns
            if added_stage:
                connection.execute(
                    "ALTER TABLE jobs ADD COLUMN stage TEXT NOT NULL DEFAULT 'queued'"
                )
            if "lease_expires_at" not in columns:
                connection.execute("ALTER TABLE jobs ADD COLUMN lease_expires_at REAL")
            if added_stage:
                connection.execute(
                    """UPDATE jobs SET stage=CASE
                       WHEN state='done' THEN 'done'
                       ELSE 'queued' END"""
                )
        os.chmod(self.path, 0o600)

    def enqueue(self, job_type: JobType, payload: dict[str, object], dedupe_key: str) -> int:
        now = time.time()
        with self._connect() as connection:
            try:
                cursor = connection.execute(
                    """INSERT INTO jobs
                    (job_type, state, payload, attempts, max_attempts, not_before,
                     dedupe_key, created_at, updated_at)
                    VALUES (?, 'pending', ?, 0, ?, 0, ?, ?, ?)""",
                    (
                        job_type.value,
                        json.dumps(payload, sort_keys=True),
                        self.max_attempts,
                        dedupe_key,
                        now,
                        now,
                    ),
                )
                return int(cursor.lastrowid)
            except sqlite3.IntegrityError:
                row = connection.execute(
                    "SELECT id FROM jobs WHERE dedupe_key = ?", (dedupe_key,)
                ).fetchone()
                return int(row["id"])

    def reclaim_stale(self) -> int:
        cutoff = time.time() - self.visibility_timeout_seconds
        with self._connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs
                SET state=CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
                    stage='queued', claimed_at=NULL, lease_expires_at=NULL, updated_at=?
                WHERE state='running' AND (
                    (lease_expires_at IS NOT NULL AND lease_expires_at < ?)
                    OR (lease_expires_at IS NULL AND claimed_at < ?)
                )""",
                (time.time(), time.time(), cutoff),
            )
            reclaimed = cursor.rowcount
        if reclaimed:
            self._event(EventCode.JOB_RECLAIMED, outcome="lease_expired")
        return reclaimed

    def claim(self) -> JobRecord | None:
        now = time.time()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """SELECT * FROM jobs
                WHERE state IN ('pending','failed') AND not_before <= ?
                  AND attempts < max_attempts
                ORDER BY id LIMIT 1""",
                (now,),
            ).fetchone()
            if row is None:
                connection.execute("COMMIT")
                return None
            lease_expires_at = now + self.visibility_timeout_seconds
            connection.execute(
                """UPDATE jobs SET state='running', attempts=attempts+1,
                   claimed_at=?, lease_expires_at=?, updated_at=? WHERE id=?""",
                (now, lease_expires_at, now, row["id"]),
            )
            connection.execute("COMMIT")
            self._event(
                EventCode.JOB_CLAIMED,
                job_id=int(row["id"]),
                attempt=int(row["attempts"]) + 1,
                stage_from=str(row["stage"]),
            )
            updated = dict(row)
            updated.update(
                state="running",
                attempts=row["attempts"] + 1,
                lease_expires_at=lease_expires_at,
                updated_at=now,
            )
            return self._record(updated)
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def complete(self, job_id: int) -> None:
        with self._connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs SET state='done', stage='done', last_error=NULL,
                   claimed_at=NULL, lease_expires_at=NULL, updated_at=?
                   WHERE id=? AND state='running'""",
                (time.time(), job_id),
            )
            if cursor.rowcount != 1:
                raise ValueError(f"Job {job_id} is not running")
        self._event(EventCode.JOB_COMPLETED, job_id=job_id, stage_to=JobStage.DONE.value)

    def fail(self, job_id: int, error: str) -> JobState:
        now = time.time()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT state, attempts, max_attempts FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            if row is None:
                raise KeyError(job_id)
            if JobState(str(row["state"])) is not JobState.RUNNING:
                raise ValueError(f"Job {job_id} is not running")
            dead = row["attempts"] >= row["max_attempts"]
            state = JobState.DEAD if dead else JobState.FAILED
            delay = 0 if dead else self.backoff_base_seconds * (2 ** max(0, row["attempts"] - 1))
            cursor = connection.execute(
                """UPDATE jobs SET state=?, last_error=?, not_before=?,
                   claimed_at=NULL, lease_expires_at=NULL, updated_at=?
                   WHERE id=? AND state='running'""",
                (state.value, error[:4000], now + delay, now, job_id),
            )
            if cursor.rowcount != 1:
                raise ValueError(f"Job {job_id} is not running")
        diagnostic = decode_diagnostic(error) or {}
        error_type = diagnostic.get("error_type")
        stage = diagnostic.get("stage")
        http_status = diagnostic.get("http_status")
        self._event(
            EventCode.JOB_DEAD if dead else EventCode.JOB_FAILED,
            job_id=job_id,
            attempt=int(row["attempts"]),
            stage_from=stage if isinstance(stage, str) else None,
            outcome=state.value,
            error_type=error_type if isinstance(error_type, str) else None,
            http_status=http_status if isinstance(http_status, int) else None,
        )
        return state

    def heartbeat(self, job_id: int) -> bool:
        now = time.time()
        with self._connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs SET lease_expires_at=?, updated_at=?
                   WHERE id=? AND state='running'""",
                (now + self.visibility_timeout_seconds, now, job_id),
            )
            return cursor.rowcount == 1

    def set_stage(self, job_id: int, stage: JobStage) -> None:
        if stage in {JobStage.QUEUED, JobStage.DONE}:
            raise ValueError(f"Worker cannot set terminal stage: {stage.value}")
        with self._connect() as connection:
            previous = connection.execute(
                "SELECT stage FROM jobs WHERE id=? AND state='running'", (job_id,)
            ).fetchone()
            cursor = connection.execute(
                """UPDATE jobs SET stage=?, updated_at=?
                   WHERE id=? AND state='running'""",
                (stage.value, time.time(), job_id),
            )
            if cursor.rowcount != 1:
                raise ValueError(f"Job {job_id} is not running")
        self._event(
            EventCode.JOB_STAGE,
            job_id=job_id,
            stage_from=str(previous["stage"]) if previous else None,
            stage_to=stage.value,
        )

    def freeze_payload(self, job_id: int, payload: dict[str, object]) -> None:
        """Persist the resolved meeting once, before any transcript or wiki side effect."""
        if payload.get("classification_frozen") is not True:
            raise ValueError("Frozen payload must set classification_frozen")
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT state, payload FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            if row is None or JobState(str(row["state"])) is not JobState.RUNNING:
                raise ValueError(f"Job {job_id} is not running")
            if json.loads(str(row["payload"])).get("classification_frozen") is True:
                raise ValueError(f"Job {job_id} payload is already frozen")
            connection.execute(
                "UPDATE jobs SET payload=?, updated_at=? WHERE id=?",
                (json.dumps(payload, sort_keys=True), time.time(), job_id),
            )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def get(self, job_id: int) -> JobRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            return self._record(dict(row)) if row else None

    def list(self, state: JobState | None = None) -> list[JobRecord]:
        with self._connect() as connection:
            if state:
                rows = connection.execute(
                    "SELECT * FROM jobs WHERE state=? ORDER BY id", (state.value,)
                ).fetchall()
            else:
                rows = connection.execute("SELECT * FROM jobs ORDER BY id").fetchall()
            return [self._record(dict(row)) for row in rows]

    def summary(self) -> dict[str, object]:
        counts = {state.value: 0 for state in JobState}
        stage_counts = {
            stage.value: 0 for stage in JobStage if stage not in {JobStage.QUEUED, JobStage.DONE}
        }
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT state, COUNT(*) AS count FROM jobs GROUP BY state"
            ).fetchall()
            stage_rows = connection.execute(
                """SELECT stage, COUNT(*) AS count FROM jobs
                   WHERE state='running' GROUP BY stage"""
            ).fetchall()
        for row in rows:
            counts[str(row["state"])] = int(row["count"])
        for row in stage_rows:
            stage = str(row["stage"])
            if stage in stage_counts:
                stage_counts[stage] = int(row["count"])
        counts["total"] = sum(counts[state.value] for state in JobState)
        counts["active"] = (
            counts[JobState.PENDING.value]
            + counts[JobState.RUNNING.value]
            + counts[JobState.FAILED.value]
        )
        counts["action_required"] = counts[JobState.DEAD.value]
        return {**counts, "stages": stage_counts}

    def dismiss(self, job_id: int) -> JobRecord:
        """Hide a dead job from active recovery without deleting meeting data."""
        now = time.time()
        with self._connect() as connection:
            row = connection.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            state = JobState(str(row["state"]))
            if state is not JobState.DEAD:
                raise ValueError(f"Job {job_id} is {state.value}; only dead jobs can dismiss")
            connection.execute(
                """UPDATE jobs SET state='dismissed', claimed_at=NULL,
                   lease_expires_at=NULL, updated_at=? WHERE id=?""",
                (now, job_id),
            )
        dismissed = self.get(job_id)
        if dismissed is None:
            raise KeyError(job_id)
        self._event(EventCode.JOB_DISMISSED, job_id=job_id, outcome="dismissed")
        return dismissed

    def restore(self, job_id: int) -> JobRecord:
        """Return a dismissed job to the dead-letter list without discarding diagnostics."""
        now = time.time()
        with self._connect() as connection:
            row = connection.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            state = JobState(str(row["state"]))
            if state is not JobState.DISMISSED:
                raise ValueError(f"Job {job_id} is {state.value}; only dismissed jobs can restore")
            connection.execute(
                """UPDATE jobs SET state='dead', claimed_at=NULL,
                   lease_expires_at=NULL, updated_at=? WHERE id=?""",
                (now, job_id),
            )
        restored = self.get(job_id)
        if restored is None:
            raise KeyError(job_id)
        self._event(EventCode.JOB_RESTORED, job_id=job_id, outcome="dead")
        return restored

    def cleanup_dismissed(self, older_than_seconds: float) -> int:
        """Delete only aged, dismissed queue rows. Meeting artifacts remain untouched."""
        if older_than_seconds < 0:
            raise ValueError("Dismissed job retention must not be negative")
        cutoff = time.time() - older_than_seconds
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM jobs WHERE state='dismissed' AND updated_at < ?", (cutoff,)
            )
            return cursor.rowcount

    def retry(self, job_id: int) -> JobRecord:
        now = time.time()
        with self._connect() as connection:
            row = connection.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            state = JobState(str(row["state"]))
            if state not in {JobState.FAILED, JobState.DEAD}:
                raise ValueError(
                    f"Job {job_id} is {state.value}; only failed or dead jobs can retry"
                )
            connection.execute(
                """UPDATE jobs SET state='pending', stage='queued', attempts=0,
                   not_before=0, last_error=NULL, claimed_at=NULL,
                   lease_expires_at=NULL, updated_at=? WHERE id=?""",
                (now, job_id),
            )
        retried = self.get(job_id)
        if retried is None:
            raise KeyError(job_id)
        self._event(EventCode.JOB_RETRIED, job_id=job_id, stage_to=JobStage.QUEUED.value)
        return retried

    @staticmethod
    def _record(row: dict[str, object]) -> JobRecord:
        return JobRecord(
            id=int(row["id"]),
            job_type=JobType(str(row["job_type"])),
            state=JobState(str(row["state"])),
            payload=json.loads(str(row["payload"])),
            attempts=int(row["attempts"]),
            max_attempts=int(row["max_attempts"]),
            dedupe_key=str(row["dedupe_key"]),
            stage=JobStage(str(row.get("stage") or JobStage.QUEUED.value)),
            lease_expires_at=(
                float(row["lease_expires_at"]) if row.get("lease_expires_at") is not None else None
            ),
            last_error=str(row["last_error"]) if row.get("last_error") else None,
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )
