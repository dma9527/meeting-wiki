"""Provider contracts. Core business logic imports only these protocols."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager
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


@runtime_checkable
class LiveLanguageProvider(Protocol):
    """Translate final transcript text and derive a rolling display-only summary."""

    name: str

    def translate(self, text: str, target_language: str) -> str: ...

    def summarize(self, transcript: str) -> list[str]: ...

    def health(self) -> tuple[bool, str]: ...


@runtime_checkable
class StorageProvider(Protocol):
    name: str

    def read_text(self, key: str) -> str | None: ...

    def write_text(self, key: str, content: str, private: bool = False) -> None: ...

    def exists(self, key: str) -> bool: ...

    def list_keys(self, prefix: str = "") -> list[str]: ...


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
