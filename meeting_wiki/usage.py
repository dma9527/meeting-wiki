"""Local provider usage counts and a month-to-date cost estimate.

Only numbers are stored: token counts, audio seconds, and call counts per day, provider,
model, and operation. Recording is best effort and never interrupts processing.
"""

from __future__ import annotations

import contextlib
import os
import re
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}\Z")
_MAX_COUNT = 10**12

_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage (
    day TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    operation TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    audio_seconds REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider, model, operation)
)
"""


@dataclass(frozen=True)
class Price:
    """USD per million tokens, or per audio minute for streaming transcription."""

    input_per_million: float = 0.0
    output_per_million: float = 0.0
    audio_per_minute: float = 0.0


# Paid-tier list prices from ai.google.dev/gemini-api/docs/pricing, checked 2026-11-17.
# Each model maps to (first day the price applies, price), newest last.
_PRICES: dict[str, tuple[tuple[date, Price], ...]] = {
    "gemini-3.6-flash": (
        (date(2026, 1, 1), Price(0.75, 3.75)),
        (date(2027, 1, 1), Price(1.50, 7.50)),
    ),
    "gemini-3.5-flash-lite": ((date(2026, 1, 1), Price(0.30, 2.50)),),
    "gemini-3.5-transcribe": ((date(2026, 1, 1), Price(2.00, 12.00)),),
    # Google's blended estimate: 25 audio tokens per second in, 175 text tokens per minute out.
    "gemini-3.5-transcribe-live": ((date(2026, 1, 1), Price(audio_per_minute=0.009)),),
}
# Retired names Google routes to a current model and bills at its price.
_ALIASES = {"gemini-3.5-flash": "gemini-3.6-flash"}


def price_for(model: str, day: date) -> Price | None:
    schedule = _PRICES.get(_ALIASES.get(model, model))
    if not schedule:
        return None
    current = None
    for start, price in schedule:
        if day >= start:
            current = price
    return current


def _count(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float) or value != value:
        return 0
    return int(min(max(value, 0), _MAX_COUNT))


class UsageLog:
    def __init__(self, path: Path):
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute(_SCHEMA)
        with contextlib.suppress(OSError):
            os.chmod(self.path, 0o600)
        return connection

    def record(
        self,
        provider: str,
        model: str,
        operation: str,
        *,
        input_tokens: object = 0,
        output_tokens: object = 0,
        audio_seconds: object = 0,
        day: date | None = None,
    ) -> None:
        if not all(
            isinstance(name, str) and _NAME.fullmatch(name) for name in (provider, model, operation)
        ):
            return
        seconds = 0.0
        numeric = isinstance(audio_seconds, int | float) and not isinstance(audio_seconds, bool)
        if numeric and audio_seconds == audio_seconds:
            seconds = min(max(float(audio_seconds), 0.0), 1e9)
        stamp = (day or datetime.now(UTC).date()).isoformat()
        with contextlib.closing(self._connect()) as connection, connection:
            connection.execute(
                """INSERT INTO usage (day, provider, model, operation, calls, input_tokens,
                       output_tokens, audio_seconds) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                   ON CONFLICT (day, provider, model, operation) DO UPDATE SET
                       calls = calls + 1,
                       input_tokens = input_tokens + excluded.input_tokens,
                       output_tokens = output_tokens + excluded.output_tokens,
                       audio_seconds = audio_seconds + excluded.audio_seconds""",
                (
                    stamp,
                    provider,
                    model,
                    operation,
                    _count(input_tokens),
                    _count(output_tokens),
                    seconds,
                ),
            )

    def month(self, month: str) -> dict[str, Any]:
        """Usage rows for one YYYY-MM month with a cost estimate where the model is priced."""
        if not re.fullmatch(r"\d{4}-\d{2}", month):
            raise ValueError("month must be YYYY-MM")
        items: dict[tuple[str, str, str], dict[str, Any]] = {}
        if self.path.exists():
            with contextlib.closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT * FROM usage WHERE day LIKE ? ORDER BY day", (f"{month}-%",)
                ).fetchall()
        else:
            rows = []
        for row in rows:
            key = (row["provider"], row["model"], row["operation"])
            item = items.setdefault(
                key,
                {
                    "provider": key[0],
                    "model": key[1],
                    "operation": key[2],
                    "calls": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "audio_seconds": 0.0,
                    "estimated_usd": 0.0,
                },
            )
            item["calls"] += row["calls"]
            item["input_tokens"] += row["input_tokens"]
            item["output_tokens"] += row["output_tokens"]
            item["audio_seconds"] += row["audio_seconds"]
            price = price_for(row["model"], date.fromisoformat(row["day"]))
            if price is None or item["estimated_usd"] is None:
                item["estimated_usd"] = None
                continue
            item["estimated_usd"] += (
                row["input_tokens"] * price.input_per_million / 1_000_000
                + row["output_tokens"] * price.output_per_million / 1_000_000
                + row["audio_seconds"] / 60 * price.audio_per_minute
            )
        listed = sorted(
            items.values(), key=lambda item: (item["provider"], item["model"], item["operation"])
        )
        for item in listed:
            item["audio_seconds"] = round(item["audio_seconds"], 1)
            if item["estimated_usd"] is not None:
                item["estimated_usd"] = round(item["estimated_usd"], 4)
        priced = [item["estimated_usd"] for item in listed if item["estimated_usd"] is not None]
        return {
            "month": month,
            "items": listed,
            "estimated_usd": round(sum(priced), 2),
            "unpriced": any(item["estimated_usd"] is None for item in listed),
        }


_log: UsageLog | None = None


def use_log(data_dir: Path) -> UsageLog:
    """Point this process's usage reports at data_dir/usage.db."""
    global _log
    _log = UsageLog(data_dir / "usage.db")
    return _log


def current_month() -> str:
    return datetime.now(UTC).strftime("%Y-%m")


def report(provider: str, model: str, operation: str, **counts: object) -> None:
    if _log is None:
        return
    with contextlib.suppress(Exception):
        _log.record(provider, model, operation, **counts)


def report_gemini(response: object, model: str, operation: str) -> None:
    """Record the token counts a google-genai response reports, thinking included."""
    metadata = getattr(response, "usage_metadata", None)
    if metadata is None:
        return
    output = _count(getattr(metadata, "candidates_token_count", 0)) + _count(
        getattr(metadata, "thoughts_token_count", 0)
    )
    report(
        "gemini",
        model,
        operation,
        input_tokens=getattr(metadata, "prompt_token_count", 0),
        output_tokens=output,
    )


def report_openai(body: Mapping[str, object], model: str, operation: str) -> None:
    """Record usage or audio duration from an OpenAI-compatible JSON response."""
    usage = body.get("usage") if isinstance(body, Mapping) else None
    usage = usage if isinstance(usage, Mapping) else {}
    report(
        "openai_compatible",
        model,
        operation,
        input_tokens=usage.get("prompt_tokens", 0),
        output_tokens=usage.get("completion_tokens", 0),
        audio_seconds=body.get("duration", 0) if isinstance(body, Mapping) else 0,
    )


def live_budget_reached(data_dir: Path, budget_usd: int) -> bool:
    """True when a positive monthly live budget is used up by this month's estimate."""
    if budget_usd <= 0:
        return False
    try:
        estimate = UsageLog(data_dir / "usage.db").month(current_month())["estimated_usd"]
    except Exception:
        return False
    return estimate >= budget_usd
