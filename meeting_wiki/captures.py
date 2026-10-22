"""Durable hand-off from a finalized desktop capture to the job queue.

The desktop writes ``<recording>.capture.json`` next to managed audio before it
asks for an ingest. The manifest is deleted only after the job row is durable, so
a crash, quit, or missing runtime leaves it for ``recover_captures`` on startup.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .config import AppConfig
from .models import MeetingInput
from .worker import enqueue_meeting

MANIFEST_SUFFIX = ".capture.json"
_MAX_MANIFEST_BYTES = 64 * 1024


class CaptureManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    audio_path: Path
    mic_audio_path: Path | None = None
    system_audio_path: Path | None = None
    title: str = Field(min_length=1, max_length=300)
    title_explicit: bool
    # Required: a manifest without a privacy choice is never processed.
    private: bool
    recording_started_at: datetime
    occurred_at: datetime | None = None

    @field_validator("recording_started_at", "occurred_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("capture timestamps must include a timezone")
        return value


def _managed(config: AppConfig, path: Path, *, required: bool) -> Path:
    managed_dir = (config.data_dir / "audio").resolve()
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(managed_dir)
    except ValueError as error:
        raise ValueError("capture path must be inside the managed audio directory") from error
    if required and not resolved.is_file():
        raise ValueError("capture audio is missing")
    return resolved


def meeting_from_manifest(config: AppConfig, manifest: CaptureManifest) -> MeetingInput:
    optional = {
        name: _managed(config, value, required=True) if value else None
        for name, value in (
            ("mic_audio_path", manifest.mic_audio_path),
            ("system_audio_path", manifest.system_audio_path),
        )
    }
    return MeetingInput(
        audio_path=_managed(config, manifest.audio_path, required=True),
        **optional,
        title=manifest.title,
        title_explicit=manifest.title_explicit,
        private=manifest.private,
        occurred_at=manifest.occurred_at or manifest.recording_started_at,
        occurred_at_explicit=manifest.occurred_at is not None,
        recording_started_at=manifest.recording_started_at,
    )


def enqueue_capture(config: AppConfig, manifest_path: Path) -> int:
    """Enqueue one manifest idempotently, then delete it. Invalid manifests stay in place."""
    path = _managed(config, manifest_path, required=False)
    if not path.name.endswith(MANIFEST_SUFFIX):
        raise ValueError("capture manifest must end with .capture.json")
    if path.stat().st_size > _MAX_MANIFEST_BYTES:
        raise ValueError("capture manifest is too large")
    try:
        manifest = CaptureManifest.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError as error:
        raise ValueError("capture manifest is invalid") from error
    job_id = enqueue_meeting(config, meeting_from_manifest(config, manifest))
    path.unlink(missing_ok=True)
    return job_id


def recover_captures(config: AppConfig) -> dict[str, int]:
    """Enqueue finalized captures whose manifest outlived a failed or interrupted hand-off."""
    audio_dir = config.data_dir / "audio"
    summary = {"recovered": 0, "invalid": 0}
    if not audio_dir.is_dir():
        return summary
    for manifest_path in sorted(audio_dir.glob(f"*{MANIFEST_SUFFIX}")):
        try:
            enqueue_capture(config, manifest_path)
        except FileNotFoundError:
            continue  # A concurrent hand-off already enqueued and removed it.
        except (OSError, ValueError):
            summary["invalid"] += 1
            continue
        summary["recovered"] += 1
    return summary
