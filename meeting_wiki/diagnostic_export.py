"""User-initiated, privacy-safe diagnostic report.

Every value is reduced to an allowlisted code, a version, a timestamp, or a bounded number when
it is read. The export is offline: it builds no providers, makes no network call, and creates
nothing in the data directory. Databases are opened read-only. A final scan rejects anything that
is not a short code, and a failed scan blocks the whole export instead of redacting it.
"""

from __future__ import annotations

import contextlib
import datetime
import json
import os
import platform
import re
import sqlite3
import sys
from collections.abc import Mapping
from pathlib import Path

from .config import load_config
from .diagnostics import decode_diagnostic, safe_identifier
from .events import _IDENTIFIER, _REF, Component, EventCode, component_version
from .models import JobStage, JobState, JobType

REPORT_FORMAT = "meeting-wiki-diagnostics"
REPORT_VERSION = 1
MAX_EVENTS = 200
MAX_LIVE_LOG_ENTRIES = 100
MAX_FAILED_JOBS = 50

_STAGES = frozenset(stage.value for stage in JobStage)
_JOB_TYPES = frozenset(job_type.value for job_type in JobType)
_JOB_STATES = tuple(state.value for state in JobState)
_OUTCOMES = frozenset(
    {
        "abandoned",
        "correction",
        "dead",
        "delivered",
        "dismissed",
        "done",
        "failed",
        "in_flight",
        "lease_expired",
        "pending",
        "planned",
        "reused",
        "running",
        "sending",
        "skipped",
    }
)
_PROVIDERS = frozenset(
    {
        "chunked_mlx_whisper",
        "gemini",
        "local",
        "mlx_whisper",
        "ollama",
        "openai_compatible",
        "s3",
        "text",
    }
)
_PROVIDER_FIELDS = ("transcription", "llm", "live_transcription", "live_language", "storage")
_LIVE_EVENTS = frozenset(
    {
        "live_chunk_failed",
        "live_language_failed",
        "live_probe_connection_failed",
        "live_probe_connection_timeout",
        "live_provider_unavailable",
        "live_session_expired",
        "live_transcription_failed",
        "live_transcription_reconnecting",
    }
)
_LIVE_CHANNELS = frozenset({"you", "others"})
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})\Z")
_PROVIDER_STATUS = re.compile(r"[A-Z][A-Z0-9_]{0,63}\Z")
_VERSION = re.compile(r"\d+(\.\d+){0,3}[0-9A-Za-z.+_-]{0,20}\Z")
_SAFE_STRING = re.compile(r"[A-Za-z0-9_.+:\-]{1,80}\Z")
_LONG_RUN = re.compile(r"[A-Za-z0-9]{33,}")
_SECRET_LIKE = re.compile(
    r"(?i)(?<![a-z0-9])(sk[-_]|xox[abprs]-|gh[pousr]_|bearer)|AIza|AKIA[0-9A-Z]{12,}|[0-9a-f]{24,}"
)


class DiagnosticExportError(Exception):
    """Carries a fixed error code and never any report content."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def assert_privacy_safe(value: object) -> None:
    """Second layer: raise unless every key and string is a short code and the rest are numbers."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            assert_privacy_safe(key)
            assert_privacy_safe(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            assert_privacy_safe(item)
    elif isinstance(value, str):
        if (
            not _SAFE_STRING.fullmatch(value)
            or _LONG_RUN.search(value)
            or _SECRET_LIKE.search(value)
        ):
            raise DiagnosticExportError("diagnostic_report_not_privacy_safe")
    elif value is not None and not isinstance(value, (bool, int, float)):
        raise DiagnosticExportError("diagnostic_report_not_privacy_safe")


def _version_code(value: object) -> str:
    return value if isinstance(value, str) and _VERSION.fullmatch(value) else "unknown"


def _platform_code() -> str:
    return f"{sys.platform}-{platform.machine() or 'unknown'}"


def _os_version() -> str:
    return platform.mac_ver()[0] or platform.release() or "unknown"


def _integer(value: object, low: int, high: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        return None
    return value


def _allowed(value: object, allowed: frozenset[str], fallback: str = "unknown") -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def _open_read_only(path: Path) -> tuple[sqlite3.Connection | None, str]:
    """Returns a connection and a source status: ok, missing, or unreadable."""
    if not path.is_file():
        return None, "missing"
    try:
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None, "unreadable"
    connection.row_factory = sqlite3.Row
    return connection, "ok"


def _provider_code(value: object) -> str:
    return _allowed(value, _PROVIDERS)


def _offline_self_check(config_path: Path):
    """Provider choices and local storage and memory state. Never builds a provider."""
    from .live import live_scope_is_external
    from .self_check import SELF_CHECK_VERSION, _memory_status, _storage_status

    try:
        config = load_config(config_path)
    except Exception:
        return {"version": SELF_CHECK_VERSION, "mode": "offline", "config": "invalid"}, None
    report: dict[str, object] = {
        "version": SELF_CHECK_VERSION,
        "mode": "offline",
        "config": "ok",
        "providers": {
            field: _provider_code(getattr(config.providers, field, None))
            for field in _PROVIDER_FIELDS
        },
        "live_scope": "external" if live_scope_is_external(config) else "local",
        "capabilities": {
            "storage": _storage_status(config),
            "memory": _memory_status(config.data_dir / "memory.db"),
        },
    }
    return report, config


def _job_summary(connection: sqlite3.Connection) -> dict[str, object]:
    counts = dict.fromkeys(_JOB_STATES, 0)
    for row in connection.execute("SELECT state, COUNT(*) AS count FROM jobs GROUP BY state"):
        if row["state"] in counts:
            counts[str(row["state"])] = int(row["count"])
    stages: dict[str, int] = {}
    for row in connection.execute(
        "SELECT stage, COUNT(*) AS count FROM jobs WHERE state='running' GROUP BY stage"
    ):
        if row["stage"] in _STAGES:
            stages[str(row["stage"])] = int(row["count"])
    return {
        **counts,
        "total": sum(counts.values()),
        "active": counts["pending"] + counts["running"] + counts["failed"],
        "action_required": counts["dead"],
        "stages": stages,
    }


def _safe_diagnostic(diagnostic: dict[str, object]) -> dict[str, object]:
    """Keep the structured record's fixed fields, with names limited to known values."""
    safe: dict[str, object] = {
        "version": 1,
        "stage": _allowed(diagnostic.get("stage"), _STAGES),
        "attempt": _integer(diagnostic.get("attempt"), 0, 10_000) or 0,
        "max_attempts": _integer(diagnostic.get("max_attempts"), 0, 10_000) or 0,
        "category": _allowed(
            diagnostic.get("category"), frozenset({"internal_error", "provider_request_failed"})
        ),
        "error_type": safe_identifier(diagnostic.get("error_type")),
    }
    if "provider" in diagnostic:
        safe["provider"] = _provider_code(diagnostic.get("provider"))
    for key in ("operation", "sdk_error_type"):
        value = diagnostic.get(key)
        if isinstance(value, str) and len(value) <= 40 and safe_identifier(value, "") == value:
            safe[key] = value
    status = _integer(diagnostic.get("http_status"), 400, 599)
    if status is not None:
        safe["http_status"] = status
    provider_status = diagnostic.get("provider_status")
    if isinstance(provider_status, str) and _PROVIDER_STATUS.fullmatch(provider_status):
        safe["provider_status"] = provider_status
    return safe


def _failed_jobs(connection: sqlite3.Connection) -> list[dict[str, object]]:
    rows = connection.execute(
        """SELECT id, job_type, state, stage, attempts, max_attempts, last_error
           FROM jobs WHERE state IN ('dead', 'failed') ORDER BY id DESC LIMIT ?""",
        (MAX_FAILED_JOBS,),
    ).fetchall()
    failed: list[dict[str, object]] = []
    for row in reversed(rows):
        record: dict[str, object] = {
            "id": _integer(row["id"], 1, 2**62),
            "job_type": _allowed(row["job_type"], _JOB_TYPES),
            "state": _allowed(row["state"], frozenset({"dead", "failed"})),
            "stage": _allowed(row["stage"], _STAGES),
            "attempts": _integer(row["attempts"], 0, 10_000),
            "max_attempts": _integer(row["max_attempts"], 0, 10_000),
        }
        diagnostic = decode_diagnostic(row["last_error"])
        if diagnostic:
            safe = _safe_diagnostic(diagnostic)
            record["diagnostic"] = safe
            record["error_type"] = safe["error_type"]
        elif row["last_error"]:
            # Older records held free text, so none of it is exported.
            record["error_type"] = "legacy_unstructured"
        failed.append({key: value for key, value in record.items() if value is not None})
    return failed


def _jobs_section(data_dir: Path) -> tuple[dict[str, object] | None, str]:
    connection, status = _open_read_only(data_dir / "jobs.db")
    if connection is None:
        return None, status
    try:
        return {"summary": _job_summary(connection), "failed": _failed_jobs(connection)}, "ok"
    except sqlite3.Error:
        return None, "unreadable"
    finally:
        connection.close()


def _events_section(data_dir: Path, limit: int) -> tuple[list[dict[str, object]], str]:
    connection, status = _open_read_only(data_dir / "events.db")
    if connection is None:
        return [], status
    bounded = max(1, min(int(limit), MAX_EVENTS))
    try:
        rows = connection.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (bounded,)
        ).fetchall()
    except sqlite3.Error:
        return [], "unreadable"
    finally:
        connection.close()
    events: list[dict[str, object]] = []
    for row in reversed(rows):
        try:
            code = EventCode(row["code"]).value
            component = Component(row["component"]).value
        except (ValueError, IndexError):
            continue
        version = _version_code(row["component_version"])
        event: dict[str, object] = {
            "ts": float(row["ts"]) if isinstance(row["ts"], (int, float)) else None,
            "code": code,
            "component": component,
            "component_version": version,
            "job_id": _integer(row["job_id"], 0, 2**62),
            "attempt": _integer(row["attempt"], 0, 10_000),
            "http_status": _integer(row["http_status"], 100, 599),
        }
        for column, allowed in (
            ("stage_from", _STAGES),
            ("stage_to", _STAGES),
            ("outcome", _OUTCOMES),
        ):
            if isinstance(row[column], str) and row[column] in allowed:
                event[column] = row[column]
        if isinstance(row["error_type"], str) and _IDENTIFIER.fullmatch(row["error_type"]):
            event["error_type"] = row["error_type"]
        if isinstance(row["ref"], str) and _REF.fullmatch(row["ref"]):
            event["ref"] = row["ref"]
        events.append({key: value for key, value in event.items() if value is not None})
    return events, "ok"


def _live_log_entry(line: str) -> dict[str, object] | None:
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    when = parsed.get("time")
    name = parsed.get("event")
    if not (isinstance(when, str) and _TIMESTAMP.fullmatch(when) and name in _LIVE_EVENTS):
        return None
    entry: dict[str, object] = {"time": when, "event": name}
    channel = parsed.get("channel")
    if channel in _LIVE_CHANNELS:
        entry["channel"] = channel
    for field in ("error_type", "sdk_error_type"):
        value = parsed.get(field)
        if isinstance(value, str) and len(value) <= 40 and safe_identifier(value, "") == value:
            entry[field] = value
    status = _integer(parsed.get("http_status"), 400, 599)
    if status is not None:
        entry["http_status"] = status
    close_code = _integer(parsed.get("close_code"), 1000, 4999)
    if close_code is not None:
        entry["close_code"] = close_code
    provider_status = parsed.get("provider_status")
    if isinstance(provider_status, str) and _PROVIDER_STATUS.fullmatch(provider_status):
        entry["provider_status"] = provider_status
    return entry


def _live_log_section(data_dir: Path) -> tuple[list[dict[str, object]], str]:
    path = data_dir / "logs" / "live.log"
    if not path.is_file():
        return [], "missing"
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 65_536))
            lines = handle.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return [], "unreadable"
    entries = [entry for entry in (_live_log_entry(line) for line in lines) if entry]
    return entries[-MAX_LIVE_LOG_ENTRIES:], "ok"


def build_diagnostic_report(
    config_path: Path, *, event_limit: int = MAX_EVENTS
) -> dict[str, object]:
    """Build the report. Raises DiagnosticExportError if any value is not a fixed code."""
    self_check, config = _offline_self_check(Path(config_path).expanduser())
    jobs: dict[str, object] | None = None
    events: list[dict[str, object]] = []
    live_log: list[dict[str, object]] = []
    sources = {"jobs": "unavailable", "events": "unavailable", "live_log": "unavailable"}
    if config is not None:
        jobs, sources["jobs"] = _jobs_section(config.data_dir)
        events, sources["events"] = _events_section(config.data_dir, event_limit)
        live_log, sources["live_log"] = _live_log_section(config.data_dir)
    report: dict[str, object] = {
        "format": REPORT_FORMAT,
        "version": REPORT_VERSION,
        "generated_at": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "app": {
            "component_version": _version_code(component_version()),
            "python": platform.python_version(),
            "platform": _platform_code(),
            "os_version": _os_version(),
        },
        "self_check": self_check,
        "sources": sources,
        "jobs": jobs,
        "events": events,
        "live_log": live_log,
    }
    assert_privacy_safe(report)
    return report


def write_diagnostic_report(config_path: Path, output: Path) -> Path:
    """Write the report to a new owner-only file; an existing file is never replaced."""
    report = build_diagnostic_report(config_path)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    output = Path(output).expanduser()
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise DiagnosticExportError("output_io_error") from None
    try:
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise DiagnosticExportError("output_exists") from None
    except OSError:
        raise DiagnosticExportError("output_io_error") from None
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        # A partial file would make every retry report output_exists.
        with contextlib.suppress(OSError):
            output.unlink()
        raise DiagnosticExportError("output_io_error") from None
    return output
