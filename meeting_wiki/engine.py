"""Provider-neutral ingest pipeline."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from .config import AppConfig
from .models import MeetingAnalysis, MeetingInput, MeetingType, TranscriptResult
from .privacy import classify
from .providers.registry import ProviderBundle
from .providers.transcription import TextImportTranscriber
from .wiki import RenderResult, WikiRenderer, stable_id


@dataclass
class IngestResult:
    transcript_key: str
    render: RenderResult
    analysis: MeetingAnalysis
    transcript: TranscriptResult
    task_urls: list[str]


class MeetingEngine:
    def __init__(self, config: AppConfig, providers: ProviderBundle):
        self.config = config
        self.providers = providers

    def ingest(self, meeting: MeetingInput) -> IngestResult:
        meeting_type = classify(meeting, self.config.privacy)
        private = meeting.private or meeting_type is MeetingType.ONE_ON_ONE
        meeting = meeting.model_copy(update={"meeting_type": meeting_type, "private": private})
        transcript = self._transcribe(meeting)

        source_id = stable_id(
            meeting.occurred_at.isoformat(),
            meeting.title,
            str(meeting.audio_path or meeting.transcript_path or "manual"),
        )
        date = meeting.occurred_at.strftime("%Y-%m-%d")
        if private:
            self._relocate_private_audio(meeting.audio_path, date, source_id)
        transcript_key = (
            f"private/transcripts/{date}-{source_id}.txt"
            if private
            else f"transcripts/{date}-{source_id}.txt"
        )
        storage = self.providers.private_storage if private else self.providers.storage
        storage.write_text(transcript_key, transcript.text.rstrip() + "\n", private=private)

        analysis = self.providers.llm.analyze(meeting, transcript).model_copy(
            update={"meeting_type": meeting_type, "private": private}
        )
        renderer = WikiRenderer(storage)
        render = renderer.apply(meeting, analysis, transcript_key)

        task_urls: list[str] = []
        if not private:
            for item in analysis.action_items:
                url = self.providers.task.propose(item, render.meeting_key)
                if url:
                    task_urls.append(url)

        if private:
            self.providers.notification.notify(
                "Private meeting processed",
                "Private notes were stored locally.",
            )
        else:
            self.providers.notification.notify(
                "Meeting wiki updated",
                f"{analysis.title}\n{render.meeting_key}",
            )
        return IngestResult(
            transcript_key=transcript_key,
            render=render,
            analysis=analysis,
            transcript=transcript,
            task_urls=task_urls,
        )

    def _relocate_private_audio(self, audio_path: Path | None, date: str, source_id: str) -> None:
        if audio_path is None or not audio_path.exists():
            return
        managed_audio = (self.config.data_dir / "audio").resolve()
        try:
            audio_path.resolve().relative_to(managed_audio)
        except ValueError:
            # Imported user files are never moved or deleted.
            return
        destination_dir = self.config.data_dir / "private" / "audio"
        destination_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(destination_dir, 0o700)
        destination = destination_dir / f"{date}-{source_id}{audio_path.suffix.lower()}"
        shutil.move(str(audio_path), destination)
        os.chmod(destination, 0o600)

    def _transcribe(self, meeting: MeetingInput) -> TranscriptResult:
        if meeting.transcript_path:
            return TextImportTranscriber().transcribe(meeting.transcript_path, self.config.language)
        if not meeting.audio_path:
            raise ValueError("Meeting requires audio_path or transcript_path")
        return self.providers.transcription.transcribe(meeting.audio_path, self.config.language)
