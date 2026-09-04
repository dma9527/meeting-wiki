"""Provider contracts. Core business logic imports only these protocols."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Protocol, runtime_checkable

from ..models import ActionItem, MeetingAnalysis, MeetingInput, TranscriptResult


@runtime_checkable
class TranscriptionProvider(Protocol):
    name: str

    def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptResult: ...

    def health(self) -> tuple[bool, str]: ...


@runtime_checkable
class LLMProvider(Protocol):
    name: str

    def analyze(self, meeting: MeetingInput, transcript: TranscriptResult) -> MeetingAnalysis: ...

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
    ):
        self.event_id = event_id
        self.title = title
        self.start = start
        self.end = end
        self.attendees = attendees or []
        self.private_hint = private_hint


@runtime_checkable
class CalendarProvider(Protocol):
    name: str

    def upcoming(self, within_minutes: int) -> list[CalendarEvent]: ...


@runtime_checkable
class NotificationProvider(Protocol):
    name: str

    def notify(self, title: str, body: str, level: str = "info") -> None: ...


@runtime_checkable
class TaskProvider(Protocol):
    name: str

    def propose(self, item: ActionItem, meeting_key: str) -> str | None: ...
