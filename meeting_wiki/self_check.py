"""Capability self-check for the desktop app.

The report carries only fixed status codes and allowlisted provider identifiers. It never
includes provider health text, exception messages, paths, secrets, or meeting content.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from .config import load_config
from .diagnostics import safe_identifier

SELF_CHECK_VERSION = 1
CAPABILITIES = ("transcription", "analysis", "live", "storage", "memory")
_PROVIDER_FIELDS = ("transcription", "llm", "live_transcription", "live_language", "storage")
_SQLITE_HEADER = b"SQLite format 3\x00"


def _health(provider) -> str:
    try:
        ok, _detail = provider.health()
    except Exception:
        return "failed"
    return "ready" if ok else "failed"


def _live_status(providers) -> str:
    if providers.live_transcription is None or providers.live_language is None:
        return "no_adapter"
    statuses = {_health(providers.live_transcription), _health(providers.live_language)}
    return "ready" if statuses == {"ready"} else "failed"


def _storage_status(config) -> str:
    if config.providers.storage != "local":
        return "remote_unverified"
    data_dir = config.data_dir
    if not data_dir.exists():
        return "missing"
    return "ready" if data_dir.is_dir() and os.access(data_dir, os.R_OK | os.W_OK) else "failed"


def _memory_status(path: Path) -> str:
    """Read-only probe; never creates or migrates memory.db."""
    if not path.is_file():
        return "missing"
    # A stale -wal sidecar can make a non-SQLite main file look readable.
    try:
        with path.open("rb") as handle:
            if handle.read(len(_SQLITE_HEADER)) != _SQLITE_HEADER:
                return "failed"
    except OSError:
        return "failed"
    try:
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=5)
        try:
            row = connection.execute("SELECT EXISTS(SELECT 1 FROM memory_nodes LIMIT 1)").fetchone()
        finally:
            connection.close()
    except sqlite3.Error:
        return "failed"
    return "ready" if row and row[0] else "empty"


def run_self_check(config_path: Path) -> dict[str, object]:
    from .live import live_scope_is_external
    from .providers.registry import build_providers

    try:
        config = load_config(config_path)
    except Exception:
        return {
            "version": SELF_CHECK_VERSION,
            "config": "invalid",
            "capabilities": dict.fromkeys(CAPABILITIES, "not_checked"),
        }
    capabilities: dict[str, str] = {}
    try:
        providers = build_providers(config)
    except RuntimeError:
        # Raised by AppConfig.secret when a required key environment variable is absent.
        providers = None
        build_status = "credentials_missing"
    except Exception:
        providers = None
        build_status = "not_configured"
    if providers is None:
        for name in ("transcription", "analysis", "live"):
            capabilities[name] = build_status
    else:
        capabilities["transcription"] = _health(providers.transcription)
        capabilities["analysis"] = _health(providers.llm)
        capabilities["live"] = _live_status(providers)
    capabilities["storage"] = _storage_status(config)
    capabilities["memory"] = _memory_status(config.data_dir / "memory.db")
    return {
        "version": SELF_CHECK_VERSION,
        "config": "ok",
        "providers": {
            field: safe_identifier(getattr(config.providers, field), "unknown")
            for field in _PROVIDER_FIELDS
        },
        "live_scope": "external" if live_scope_is_external(config) else "local",
        "capabilities": capabilities,
    }
