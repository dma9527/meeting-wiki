"""Transactional outbox for idempotent external task delivery.

Each action item gets a stable key derived from the meeting source id and a
canonical form of the action. The row is committed before any network call,
marked ``sending`` under a lease before the request, and marked ``delivered``
only after the provider accepts it. The provider receives the same key as an
``Idempotency-Key`` on every attempt, so an accepted request whose response
was lost (timeout or crash) is deduplicated by the receiver on resend.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .diagnostics import SafeProviderError
from .events import Component, EventCode, EventJournal
from .models import ActionItem
from .providers.base import TaskProvider

_KEY_NAMESPACE = "meeting-wiki/task-action/v1"
_MAX_URL_LENGTH = 2048

_SCHEMA = """
CREATE TABLE IF NOT EXISTS task_outbox (
    action_key TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_expires_at REAL,
    external_url TEXT,
    outcome TEXT,
    http_status INTEGER,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    delivered_at REAL
);
CREATE TABLE IF NOT EXISTS task_plan (
    job_id INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    action_key TEXT NOT NULL REFERENCES task_outbox(action_key),
    PRIMARY KEY (job_id, action_key)
);
CREATE INDEX IF NOT EXISTS idx_task_outbox_source ON task_outbox(source_id);
"""


class DeliveryState(StrEnum):
    PLANNED = "planned"
    SENDING = "sending"
    DELIVERED = "delivered"
    FAILED = "failed"
    REJECTED = "rejected"


class TaskDeliveryIncomplete(Exception):
    """Carries only an HTTP status; never provider or request text."""

    def __init__(self, code: int | None = None):
        super().__init__("task delivery incomplete")
        if code is not None:
            self.code = code


@dataclass(frozen=True)
class DeliveryReport:
    delivered_urls: list[str]
    delivered: int
    skipped: int
    rejected: int
    pending: int


def _normalize(value: str | None) -> str:
    return " ".join((value or "").split()).casefold()


def canonical_action(item: ActionItem) -> str:
    return json.dumps(
        {
            "owner": _normalize(item.owner),
            "action": _normalize(item.action),
            "due": _normalize(item.due),
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def action_key(source_id: str, item: ActionItem) -> str:
    material = "\x00".join((_KEY_NAMESPACE, source_id, canonical_action(item)))
    return hashlib.sha256(material.encode()).hexdigest()


def journal_ref(key: str) -> str:
    """A short digest of the key for the journal; never the action text."""
    return hashlib.sha256(f"journal\x00{key}".encode()).hexdigest()[:12]


def safe_external_url(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > _MAX_URL_LENGTH:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        return None
    return value


def _classify(error: BaseException) -> tuple[DeliveryState, str, int | None]:
    """Classify by exception type and status code, never by message text."""
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status in {408, 425, 429} or status >= 500:
            return DeliveryState.FAILED, "http_retryable", status
        return DeliveryState.REJECTED, "http_rejected", status
    if isinstance(error, httpx.TimeoutException):
        return DeliveryState.FAILED, "timeout", None
    if isinstance(error, httpx.TransportError):
        return DeliveryState.FAILED, "network_error", None
    if isinstance(error, ValueError):
        return DeliveryState.FAILED, "destination_invalid", None
    return DeliveryState.FAILED, "provider_error", None


class TaskOutbox:
    def __init__(
        self,
        path: Path,
        journal: EventJournal | None = None,
        lease_seconds: float = 60.0,
    ):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        self.journal = journal
        self.lease_seconds = lease_seconds
        with self._connect() as connection:
            connection.executescript(_SCHEMA)
        os.chmod(self.path, 0o600)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _event(self, code: EventCode, key: str, job_id: int | None, **fields: object) -> None:
        if self.journal is not None:
            self.journal.record(
                code, Component.OUTBOX, job_id=job_id, ref=journal_ref(key), **fields
            )

    def plan(
        self,
        source_id: str,
        provider: str,
        meeting_key: str,
        items: list[ActionItem],
        job_id: int | None,
    ) -> list[str]:
        """Persist the delivery plan in one transaction before any network call.

        A retried job reuses its committed plan, so a non-deterministic
        re-analysis cannot mint new keys for actions already in flight.
        """
        now = time.time()
        connection = self._connect()
        created: list[str] = []
        try:
            connection.execute("BEGIN IMMEDIATE")
            if job_id is not None:
                existing = connection.execute(
                    "SELECT action_key FROM task_plan WHERE job_id=? ORDER BY position",
                    (job_id,),
                ).fetchall()
                if existing:
                    connection.execute("COMMIT")
                    return [str(row["action_key"]) for row in existing]
            keys: list[str] = []
            for item in items:
                key = action_key(source_id, item)
                if key in keys:
                    continue
                payload = json.dumps(
                    {"action_item": item.model_dump(mode="json"), "meeting": meeting_key},
                    sort_keys=True,
                )
                cursor = connection.execute(
                    """INSERT OR IGNORE INTO task_outbox
                       (action_key, source_id, provider, state, payload, created_at, updated_at)
                       VALUES (?, ?, ?, 'planned', ?, ?, ?)""",
                    (key, source_id, provider, payload, now, now),
                )
                if cursor.rowcount == 1:
                    created.append(key)
                if job_id is not None:
                    connection.execute(
                        """INSERT OR IGNORE INTO task_plan (job_id, source_id, position, action_key)
                           VALUES (?, ?, ?, ?)""",
                        (job_id, source_id, len(keys), key),
                    )
                keys.append(key)
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()
        for key in created:
            self._event(EventCode.TASK_PLANNED, key, job_id, outcome="planned")
        return keys

    def _acquire(self, key: str) -> sqlite3.Row | None | str:
        """Atomically take the send lease. Returns the row, or a terminal state code."""
        now = time.time()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM task_outbox WHERE action_key=?", (key,)
            ).fetchone()
            if row is None:
                connection.execute("COMMIT")
                return None
            state = DeliveryState(str(row["state"]))
            if state in {DeliveryState.DELIVERED, DeliveryState.REJECTED}:
                connection.execute("COMMIT")
                return state.value
            lease = row["lease_expires_at"]
            if state is DeliveryState.SENDING and lease is not None and float(lease) > now:
                connection.execute("COMMIT")
                return "in_flight"
            connection.execute(
                """UPDATE task_outbox SET state='sending', attempts=attempts+1,
                   lease_expires_at=?, updated_at=? WHERE action_key=?""",
                (now + self.lease_seconds, now, key),
            )
            connection.execute("COMMIT")
            return row
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def _finish(
        self,
        key: str,
        state: DeliveryState,
        outcome: str,
        http_status: int | None = None,
        external_url: str | None = None,
    ) -> None:
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """UPDATE task_outbox SET state=?, outcome=?, http_status=?,
                   external_url=COALESCE(?, external_url), lease_expires_at=NULL,
                   updated_at=?, delivered_at=CASE WHEN ?='delivered' THEN ? ELSE delivered_at END
                   WHERE action_key=? AND state='sending'""",
                (state.value, outcome, http_status, external_url, now, state.value, now, key),
            )

    def deliver(
        self,
        keys: list[str],
        provider: TaskProvider,
        job_id: int | None = None,
    ) -> DeliveryReport:
        urls: list[str] = []
        delivered = skipped = rejected = pending = 0
        last_status: int | None = None
        for key in keys:
            acquired = self._acquire(key)
            if acquired is None:
                continue
            if isinstance(acquired, str):
                if acquired == DeliveryState.DELIVERED.value:
                    skipped += 1
                    url = self.external_url(key)
                    if url:
                        urls.append(url)
                    self._event(EventCode.TASK_SKIPPED_DELIVERED, key, job_id, outcome="delivered")
                elif acquired == DeliveryState.REJECTED.value:
                    rejected += 1
                else:
                    pending += 1
                    self._event(EventCode.TASK_IN_FLIGHT, key, job_id, outcome="in_flight")
                continue
            row = acquired
            attempt = int(row["attempts"]) + 1
            self._event(EventCode.TASK_SENDING, key, job_id, attempt=attempt, outcome="sending")
            payload = json.loads(str(row["payload"]))
            item = ActionItem.model_validate(payload["action_item"])
            try:
                url = provider.propose(item, str(payload["meeting"]), action_key=key)
            except Exception as error:
                state, outcome, status = _classify(error)
                self._finish(key, state, outcome, status)
                code = (
                    EventCode.TASK_REJECTED
                    if state is DeliveryState.REJECTED
                    else EventCode.TASK_FAILED
                )
                self._event(
                    code,
                    key,
                    job_id,
                    attempt=attempt,
                    outcome=outcome,
                    http_status=status,
                    error_type=type(error).__name__,
                )
                if state is DeliveryState.REJECTED:
                    rejected += 1
                else:
                    pending += 1
                    last_status = status
                continue
            safe_url = safe_external_url(url)
            outcome = "accepted_with_url" if safe_url else "accepted"
            self._finish(key, DeliveryState.DELIVERED, outcome, external_url=safe_url)
            self._event(EventCode.TASK_DELIVERED, key, job_id, attempt=attempt, outcome=outcome)
            delivered += 1
            if safe_url:
                urls.append(safe_url)
        report = DeliveryReport(urls, delivered, skipped, rejected, pending)
        if pending:
            raise SafeProviderError(
                getattr(provider, "name", "task"),
                "task_delivery",
                TaskDeliveryIncomplete(last_status),
            )
        return report

    def external_url(self, key: str) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT external_url FROM task_outbox WHERE action_key=?", (key,)
            ).fetchone()
        return str(row["external_url"]) if row and row["external_url"] else None

    def get(self, key: str) -> dict[str, object] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM task_outbox WHERE action_key=?", (key,)
            ).fetchone()
        return dict(row) if row else None

    def summary(self) -> dict[str, int]:
        counts = {state.value: 0 for state in DeliveryState}
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT state, COUNT(*) AS count FROM task_outbox GROUP BY state"
            ).fetchall()
        for row in rows:
            counts[str(row["state"])] = int(row["count"])
        return counts
