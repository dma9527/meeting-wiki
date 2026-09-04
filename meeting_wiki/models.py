"""Typed contracts shared by providers, worker, renderer, and MCP."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MeetingType(StrEnum):
    ONE_ON_ONE = "one-on-one"
    STANDUP = "standup"
    DESIGN_REVIEW = "design-review"
    CUSTOMER = "customer"
    GENERIC = "generic"


class TranscriptSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_seconds: float = Field(default=0, ge=0)
    end_seconds: float = Field(default=0, ge=0)
    speaker: str | None = None
    text: str = Field(min_length=1)


class TranscriptResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1)
    segments: list[TranscriptSegment] = Field(default_factory=list)
    language: str | None = None
    provider: str
    model: str
    diarized: bool = False


class Participant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    role: str | None = Field(default=None, max_length=300)


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=300)
    decision: str = Field(min_length=1)
    rationale: str | None = None
    owner: str | None = Field(default=None, max_length=200)


class ActionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner: str = Field(default="Unassigned", max_length=200)
    action: str = Field(min_length=1)
    due: str | None = Field(default=None, max_length=100)
    done: bool = False


class TopicInsight(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: str = Field(min_length=1, max_length=200)
    insight: str = Field(min_length=1)


class MeetingAnalysis(BaseModel):
    """LLM output. The renderer, not the model, owns Markdown layout."""

    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=300)
    meeting_type: MeetingType = MeetingType.GENERIC
    summary: list[str] = Field(min_length=1, max_length=12)
    participants: list[Participant] = Field(default_factory=list, max_length=50)
    blockers: list[str] = Field(default_factory=list, max_length=30)
    decisions: list[Decision] = Field(default_factory=list, max_length=30)
    action_items: list[ActionItem] = Field(default_factory=list, max_length=100)
    topics: list[TopicInsight] = Field(default_factory=list, max_length=30)
    open_questions: list[str] = Field(default_factory=list, max_length=30)
    risks: list[str] = Field(default_factory=list, max_length=30)
    private: bool = False

    @field_validator("summary")
    @classmethod
    def require_nonempty_summary(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values if value and value.strip()]
        if not cleaned:
            raise ValueError("summary must contain at least one non-empty item")
        return cleaned

    @field_validator("blockers", "open_questions", "risks")
    @classmethod
    def strip_empty_strings(cls, values: list[str]) -> list[str]:
        return [value.strip() for value in values if value and value.strip()]


class MeetingInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    audio_path: Path | None = None
    transcript_path: Path | None = None
    title: str = "Untitled meeting"
    attendees: list[str] = Field(default_factory=list)
    meeting_type: MeetingType | None = None
    private: bool = False
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    notes: str = ""

    @field_validator("audio_path", "transcript_path")
    @classmethod
    def expand_paths(cls, value: Path | None) -> Path | None:
        return value.expanduser().resolve() if value else None


class JobType(StrEnum):
    INGEST = "ingest"
    NOTIFY = "notify"
    MIRROR = "mirror"


class JobState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    DEAD = "dead"


class JobRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int
    job_type: JobType
    state: JobState
    payload: dict[str, object]
    attempts: int
    max_attempts: int
    dedupe_key: str
    last_error: str | None = None
    created_at: float
    updated_at: float
