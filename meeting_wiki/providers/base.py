"""Provider contracts. Core business logic imports only these protocols."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, AbstractContextManager, nullcontext
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Protocol, runtime_checkable

from ..models import ActionItem, MeetingAnalysis, MeetingInput, TranscriptResult, TranscriptSegment


@dataclass(frozen=True)
class TranscriptionCapabilities:
    diarization: bool = False
    timestamps: bool = False
    streaming: bool = False
    hotwords: bool = False
    max_duration_minutes: int | None = None
    supported_languages: tuple[str, ...] = ()
    hardware: str = "any"


@dataclass(frozen=True)
class TranscriptionContext:
    expected_speakers: tuple[str, ...] = ()
    hotwords: tuple[str, ...] = ()
    meeting_title: str = ""


@dataclass(frozen=True)
class LiveTranscriptRequest:
    audio_path: Path
    sequence: int
    language: str | None = None


class EmptyTranscriptError(RuntimeError):
    """A provider completed successfully but found no speech in an audio stream."""


@runtime_checkable
class TranscriptionProvider(Protocol):
    name: str
    capabilities: TranscriptionCapabilities

    def transcribe(
        self,
        audio_path: Path,
        language: str | None = None,
        context: TranscriptionContext | None = None,
    ) -> TranscriptResult: ...

    def health(self) -> tuple[bool, str]: ...


@runtime_checkable
class LiveTranscriptionProvider(Protocol):
    """Chunked live contract: turn a bounded audio file chunk into ordered final segments."""

    name: str

    def transcribe_chunk(self, request: LiveTranscriptRequest) -> list[TranscriptSegment]: ...

    def health(self) -> tuple[bool, str]: ...


class LiveTranscriptKind(StrEnum):
    INTERIM = "interim"
    FINAL = "final"


@dataclass(frozen=True)
class LiveTranscriptEvent:
    """Display-only live text. Interim text may be revised; final text is settled."""

    kind: LiveTranscriptKind
    text: str

    @property
    def is_final(self) -> bool:
        return self.kind is LiveTranscriptKind.FINAL


class LiveSessionStatusCode(StrEnum):
    """Fixed, content-free provider connection notices."""

    RENEWING = "renewing"
    RESUMED = "resumed"
    RESTARTED = "restarted"


@dataclass(frozen=True)
class LiveSessionStatus:
    """Provider connection notice, yielded in order with transcript events."""

    code: LiveSessionStatusCode


class LiveSessionExpiredError(RuntimeError):
    """The provider ended its connection and the session could not be renewed."""

    def __init__(self) -> None:
        super().__init__("Live provider session expired and could not be renewed")


class LiveProviderError(RuntimeError):
    """A live provider failure that carries only allowlisted SDK metadata, never its text."""

    def __init__(self, provider: str, action: str, error: BaseException):
        from ..diagnostics import safe_provider_metadata

        self.metadata: dict[str, object] = safe_provider_metadata(error)
        code = getattr(error, "code", None)
        # Live API errors arrive as WebSocket close codes, for example 1007 or 1008.
        if isinstance(code, int) and not isinstance(code, bool) and 1000 <= code <= 4999:
            self.metadata["close_code"] = code
        details = [str(self.metadata["sdk_error_type"])]
        for key, label in (("http_status", "HTTP "), ("close_code", "close ")):
            if key in self.metadata:
                details.append(f"{label}{self.metadata[key]}")
        if "provider_status" in self.metadata:
            details.append(str(self.metadata["provider_status"]))
        super().__init__(f"{provider} live {action} failed ({', '.join(details)})")


@runtime_checkable
class LiveTranscriptionSession(Protocol):
    """One open streaming session fed raw 16-bit mono PCM at 16 kHz."""

    async def send_audio(self, pcm: bytes) -> None: ...

    async def end_audio(self) -> None: ...

    def events(self) -> AsyncIterator[LiveTranscriptEvent | LiveSessionStatus]: ...

    async def close(self) -> None: ...


@runtime_checkable
class LiveSessionTranscriptionProvider(Protocol):
    """Session live contract: open_session is an async context manager that closes on exit."""

    name: str

    def open_session(
        self, language: str | None = None
    ) -> AbstractAsyncContextManager[LiveTranscriptionSession]: ...

    def health(self) -> tuple[bool, str]: ...


AnyLiveTranscriptionProvider = LiveTranscriptionProvider | LiveSessionTranscriptionProvider


@runtime_checkable
class LLMProvider(Protocol):
    name: str

    def analyze(self, meeting: MeetingInput, transcript: TranscriptResult) -> MeetingAnalysis: ...

    def health(self) -> tuple[bool, str]: ...


# Shared by live summary providers so a short transcript never yields commentary about itself.
LIVE_SUMMARY_RULES = (
    "Summarize only what the speakers said. Never describe, quote, or comment on the "
    "transcript itself, its length, or the user."
)


def language_display_name(value: str) -> str:
    if value in {"zh", "zh-CN"}:
        return "Simplified Chinese"
    if value == "en":
        return "English"
    return value if re.fullmatch(r"[A-Za-z][A-Za-z0-9 -]{0,39}", value) else "English"


@runtime_checkable
class LiveLanguageProvider(Protocol):
    """Translate final transcript text and derive a rolling display-only summary."""

    name: str

    def translate(self, text: str, target_language: str) -> str: ...

    def summarize(self, transcript: str, output_language: str) -> list[str]: ...

    def health(self) -> tuple[bool, str]: ...


@runtime_checkable
class StorageProvider(Protocol):
    name: str

    def read_text(self, key: str) -> str | None: ...

    def write_text(self, key: str, content: str, private: bool = False) -> None: ...

    def exists(self, key: str) -> bool: ...

    def list_keys(self, prefix: str = "") -> list[str]: ...


def storage_revision(storage: StorageProvider) -> AbstractContextManager[None]:
    """Group writes into one atomic revision when the provider supports it."""
    begin = getattr(storage, "revision", None)
    return begin() if callable(begin) else nullcontext()


class CalendarEvent:
    def __init__(
        self,
        event_id: str,
        title: str,
        start: datetime,
        end: datetime,
        attendees: list[str] | None = None,
        private_hint: bool = False,
        all_day: bool = False,
        description: str = "",
    ):
        self.event_id = event_id
        self.title = title
        self.start = start if start.tzinfo else start.replace(tzinfo=UTC)
        self.end = end if end.tzinfo else end.replace(tzinfo=UTC)
        self.attendees = attendees or []
        self.private_hint = private_hint
        self.all_day = all_day
        self.description = description


@runtime_checkable
class CalendarProvider(Protocol):
    name: str

    def upcoming(self, within_minutes: int) -> list[CalendarEvent]: ...

    def match(
        self,
        occurred_at: datetime,
        tolerance_minutes: int = 15,
    ) -> CalendarEvent | None: ...


@runtime_checkable
class NotificationProvider(Protocol):
    name: str

    def notify(self, title: str, body: str, level: str = "info") -> None: ...


@runtime_checkable
class TaskProvider(Protocol):
    name: str

    def propose(
        self, item: ActionItem, meeting_key: str, *, action_key: str | None = None
    ) -> str | None: ...
