"""Privacy-safe local event journal.

Every field is a fixed code, a bounded integer, a timestamp, or a short
digest. Free text (titles, transcripts, paths, URLs, error messages, secrets)
is rejected at write time, not filtered after the fact.
"""

from __future__ import annotations

import os
import re
import sqlite3
import time
from enum import StrEnum
from importlib import metadata
from pathlib import Path

from . import __version__ as _fallback_version


class EventCode(StrEnum):
    JOB_CLAIMED = "job.claimed"
    JOB_STAGE = "job.stage"
    JOB_COMPLETED = "job.completed"
    JOB_FAILED = "job.failed"
    JOB_DEAD = "job.dead"
    JOB_RECLAIMED = "job.reclaimed"
    JOB_RETRIED = "job.retried"
    JOB_DISMISSED = "job.dismissed"
    JOB_RESTORED = "job.restored"
    TASK_PLANNED = "task.planned"
    TASK_SENDING = "task.sending"
    TASK_DELIVERED = "task.delivered"
    TASK_SKIPPED_DELIVERED = "task.skipped_delivered"
    TASK_IN_FLIGHT = "task.in_flight"
    TASK_FAILED = "task.failed"
    TASK_REJECTED = "task.rejected"


class Component(StrEnum):
    QUEUE = "queue"
    WORKER = "worker"
    ENGINE = "engine"
    OUTBOX = "outbox"


_CODE = re.compile(r"[a-z][a-z0-9_]{0,31}\Z")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,79}\Z")
_REF = re.compile(r"[0-9a-f]{12}\Z")
_VERSION = re.compile(r"[0-9A-Za-z.+_-]{1,40}\Z")
_MAX_ROWS = 20_000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    code TEXT NOT NULL,
    component TEXT NOT NULL,
    component_version TEXT NOT NULL,
    job_id INTEGER,
    attempt INTEGER,
    stage_from TEXT,
    stage_to TEXT,
    outcome TEXT,
    http_status INTEGER,
    error_type TEXT,
    ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
"""

_COLUMNS = (
    "id",
    "ts",
    "code",
    "component",
    "component_version",
    "job_id",
    "attempt",
    "stage_from",
    "stage_to",
    "outcome",
    "http_status",
    "error_type",
    "ref",
)


def component_version() -> str:
    try:
        version = metadata.version("meeting-wiki")
    except metadata.PackageNotFoundError:
        version = _fallback_version
    return version if _VERSION.fullmatch(version) else "unknown"


def _bounded_int(value: int | None, low: int, high: int) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError("Event integer field is out of range")
    return value


def _match(value: str | None, pattern: re.Pattern[str]) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError("Event field is not an allowlisted code")
    return value


class EventJournal:
    """Append-only, best-effort journal. Write failures never break the pipeline."""

    def __init__(self, path: Path, max_rows: int = _MAX_ROWS):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        self.max_rows = max_rows
        self.version = component_version()
        with self._connect() as connection:
            connection.executescript(_SCHEMA)
        os.chmod(self.path, 0o600)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def record(
        self,
        code: EventCode,
        component: Component,
        *,
        job_id: int | None = None,
        attempt: int | None = None,
        stage_from: str | None = None,
        stage_to: str | None = None,
        outcome: str | None = None,
        http_status: int | None = None,
        error_type: str | None = None,
        ref: str | None = None,
    ) -> bool:
        row = (
            time.time(),
            EventCode(code).value,
            Component(component).value,
            self.version,
            _bounded_int(job_id, 0, 2**62),
            _bounded_int(attempt, 0, 10_000),
            _match(stage_from, _CODE),
            _match(stage_to, _CODE),
            _match(outcome, _CODE),
            _bounded_int(http_status, 100, 599),
            _match(error_type, _IDENTIFIER),
            _match(ref, _REF),
        )
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    """INSERT INTO events (ts, code, component, component_version, job_id,
                       attempt, stage_from, stage_to, outcome, http_status, error_type, ref)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    row,
                )
                if cursor.lastrowid and cursor.lastrowid % 500 == 0:
                    connection.execute(
                        "DELETE FROM events WHERE id <= ?",
                        (cursor.lastrowid - self.max_rows,),
                    )
            return True
        except sqlite3.Error:
            return False

    def recent(self, limit: int = 100) -> list[dict[str, object]]:
        bounded = max(1, min(int(limit), 1000))
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (bounded,)
            ).fetchall()
        return [
            {key: row[key] for key in _COLUMNS if row[key] is not None}
            for row in reversed(rows)
        ]


def open_journal(data_dir: Path) -> EventJournal | None:
    """Open the default journal; a broken journal must not stop local processing."""
    try:
        return EventJournal(data_dir / "events.db")
    except (OSError, sqlite3.Error):
        return None
