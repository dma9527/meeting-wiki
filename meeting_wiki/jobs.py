"""Durable local job queue with at-least-once delivery and idempotent keys."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

from .models import JobRecord, JobState, JobType

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
    ):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        self.max_attempts = max_attempts
        self.backoff_base_seconds = backoff_base_seconds
        self.visibility_timeout_seconds = visibility_timeout_seconds
        self._initialize()

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
                    claimed_at=NULL, updated_at=?
                WHERE state='running' AND claimed_at < ?""",
                (time.time(), cutoff),
            )
            return cursor.rowcount

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
            connection.execute(
                """UPDATE jobs SET state='running', attempts=attempts+1,
                   claimed_at=?, updated_at=? WHERE id=?""",
                (now, now, row["id"]),
            )
            connection.execute("COMMIT")
            updated = dict(row)
            updated.update(state="running", attempts=row["attempts"] + 1, updated_at=now)
            return self._record(updated)
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def complete(self, job_id: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE jobs SET state='done', last_error=NULL, updated_at=? WHERE id=?",
                (time.time(), job_id),
            )

    def fail(self, job_id: int, error: str) -> JobState:
        now = time.time()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT attempts, max_attempts FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            if row is None:
                raise KeyError(job_id)
            dead = row["attempts"] >= row["max_attempts"]
            state = JobState.DEAD if dead else JobState.FAILED
            delay = 0 if dead else self.backoff_base_seconds * (2 ** max(0, row["attempts"] - 1))
            connection.execute(
                """UPDATE jobs SET state=?, last_error=?, not_before=?,
                   claimed_at=NULL, updated_at=? WHERE id=?""",
                (state.value, error[:4000], now + delay, now, job_id),
            )
            return state

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
            last_error=str(row["last_error"]) if row.get("last_error") else None,
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )
