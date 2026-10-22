"""Provider-neutral ingest pipeline."""

from __future__ import annotations

import os
import shutil
import wave
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .config import AppConfig
from .events import EventJournal
from .memory import MemoryStore
from .models import (
    JobStage,
    MeetingAnalysis,
    MeetingInput,
    MeetingType,
    TranscriptResult,
    TranscriptSegment,
)
from .outbox import TaskOutbox
from .privacy import classify
from .providers.base import EmptyTranscriptError, TranscriptionContext
from .providers.registry import ProviderBundle
from .providers.transcription import TextImportTranscriber
from .wiki import RenderResult, WikiRenderer, stable_id


@dataclass
class IngestResult:
    transcript_key: str
    transcript_data_key: str
    analysis_key: str
    render: RenderResult
    analysis: MeetingAnalysis
    transcript: TranscriptResult
    task_urls: list[str]


class MeetingEngine:
    def __init__(
        self,
        config: AppConfig,
        providers: ProviderBundle,
        journal: EventJournal | None = None,
    ):
        self.config = config
        self.providers = providers
        self.journal = journal

    def ingest(
        self,
        meeting: MeetingInput,
        progress: Callable[[JobStage], None] | None = None,
        job_id: int | None = None,
    ) -> IngestResult:
        report = progress or (lambda _stage: None)
        meeting, calendar_private = self._enrich_from_calendar(meeting)
        meeting_type = classify(meeting, self.config.privacy)
        private = meeting.private or calendar_private or meeting_type is MeetingType.ONE_ON_ONE
        meeting = meeting.model_copy(update={"meeting_type": meeting_type, "private": private})
        source_id = stable_id(
            meeting.occurred_at.isoformat(),
            meeting.title,
            str(meeting.audio_path or meeting.transcript_path or "manual"),
        )
        date = meeting.occurred_at.strftime("%Y-%m-%d")
        transcript_key = (
            f"private/transcripts/{date}-{source_id}.txt"
            if private
            else f"transcripts/{date}-{source_id}.txt"
        )
        transcript_data_key = (
            f"private/transcript-data/{date}-{source_id}.json"
            if private
            else f"transcript-data/{date}-{source_id}.json"
        )
        storage = self.providers.private_storage if private else self.providers.storage

        report(JobStage.TRANSCRIBING)
        existing_transcript = storage.read_text(transcript_data_key)
        if existing_transcript:
            transcript = TranscriptResult.model_validate_json(existing_transcript)
            transcript = self._apply_speaker_corrections(transcript, meeting.speaker_corrections)
        else:
            transcript = self._transcribe(meeting)

        storage.write_text(transcript_key, transcript.text.rstrip() + "\n", private=private)
        storage.write_text(
            transcript_data_key,
            transcript.model_dump_json(indent=2) + "\n",
            private=private,
        )

        report(JobStage.ANALYZING)
        analysis = self.providers.llm.analyze(meeting, transcript).model_copy(
            update={"meeting_type": meeting_type, "private": private}
        )
        analysis_key = (
            f"private/analysis/{date}-{source_id}.json"
            if private
            else f"analysis/{date}-{source_id}.json"
        )
        storage.write_text(
            analysis_key,
            analysis.model_dump_json(indent=2) + "\n",
            private=private,
        )
        report(JobStage.RENDERING)
        renderer = WikiRenderer(storage)
        render = renderer.apply(meeting, analysis, transcript_key)
        MemoryStore(self.config.data_dir / "memory.db").index_meeting(
            meeting, analysis, transcript, render.meeting_key
        )

        report(JobStage.INTEGRATING)
        task_urls: list[str] = []
        # Private meetings never reach the outbox or a task provider.
        if not private and self.providers.task.name != "none":
            outbox = TaskOutbox(self.config.data_dir / "outbox.db", self.journal)
            keys = outbox.plan(
                source_id,
                self.providers.task.name,
                render.meeting_key,
                list(analysis.action_items),
                job_id,
            )
            task_urls = outbox.deliver(keys, self.providers.task, job_id).delivered_urls

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
        if private:
            self._relocate_private_audio(meeting, date, source_id)
        return IngestResult(
            transcript_key=transcript_key,
            transcript_data_key=transcript_data_key,
            analysis_key=analysis_key,
            render=render,
            analysis=analysis,
            transcript=transcript,
            task_urls=task_urls,
        )

    def _enrich_from_calendar(self, meeting: MeetingInput) -> tuple[MeetingInput, bool]:
        event = self.providers.calendar.match(meeting.occurred_at)
        if event is None:
            return meeting, False
        updates: dict[str, object] = {"calendar_event_id": event.event_id}
        if not meeting.title_explicit:
            updates["title"] = event.title
        if not meeting.attendees:
            updates["attendees"] = event.attendees
        if not meeting.occurred_at_explicit:
            updates["occurred_at"] = event.start
        return meeting.model_copy(update=updates), event.private_hint

    def _relocate_private_audio(
        self,
        meeting: MeetingInput,
        date: str,
        source_id: str,
    ) -> None:
        managed_audio = (self.config.data_dir / "audio").resolve()
        destination_dir = self.config.data_dir / "private" / "audio"
        moved: set[Path] = set()
        for label, audio_path in (
            ("merged", meeting.audio_path),
            ("mic", meeting.mic_audio_path),
            ("system", meeting.system_audio_path),
        ):
            if audio_path is None or not audio_path.exists():
                continue
            resolved = audio_path.resolve()
            if resolved in moved:
                continue
            try:
                resolved.relative_to(managed_audio)
            except ValueError:
                # Imported user files are never moved or deleted.
                continue
            destination_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(destination_dir, 0o700)
            destination = destination_dir / (
                f"{date}-{source_id}-{label}{audio_path.suffix.lower()}"
            )
            shutil.move(str(audio_path), destination)
            os.chmod(destination, 0o600)
            moved.add(resolved)

    def _transcribe(self, meeting: MeetingInput) -> TranscriptResult:
        shared_context = self._transcription_context(
            meeting,
            tuple(meeting.attendees),
        )
        if meeting.transcript_path:
            result = TextImportTranscriber().transcribe(
                meeting.transcript_path,
                self.config.language,
                shared_context,
            )
            return self._apply_speaker_corrections(result, meeting.speaker_corrections)

        streams: list[tuple[Path, str, TranscriptionContext]] = []
        if meeting.mic_audio_path:
            mic_context = self._transcription_context(
                meeting,
                (self.config.primary_profile_name,),
            )
            streams.append((meeting.mic_audio_path, self.config.primary_profile_name, mic_context))
        if meeting.system_audio_path:
            other_attendees = [
                attendee
                for attendee in meeting.attendees
                if not self.config.is_primary_profile_alias(attendee)
            ]
            remote_speaker = (
                other_attendees[0] if len(other_attendees) == 1 else "Remote participant"
            )
            system_context = self._transcription_context(
                meeting,
                tuple(other_attendees),
            )
            streams.append((meeting.system_audio_path, remote_speaker, system_context))

        if streams:
            results: list[tuple[TranscriptResult, str]] = []
            for path, speaker, context in streams:
                if self._is_provably_silent_wav(path):
                    continue
                try:
                    result = self.providers.transcription.transcribe(
                        path,
                        self.config.language,
                        context,
                    )
                except EmptyTranscriptError:
                    continue
                results.append((result, speaker))
            if not results:
                raise ValueError("No non-empty audio streams available for transcription")
            result = self._merge_stream_transcripts(results)
            return self._apply_speaker_corrections(result, meeting.speaker_corrections)

        if not meeting.audio_path:
            raise ValueError("Meeting requires audio_path or transcript_path")
        result = self.providers.transcription.transcribe(
            meeting.audio_path,
            self.config.language,
            shared_context,
        )
        return self._apply_speaker_corrections(result, meeting.speaker_corrections)

    @staticmethod
    def _is_provably_silent_wav(path: Path) -> bool:
        """Return true only for readable 16-bit PCM WAV files containing all-zero samples."""
        try:
            with wave.open(str(path), "rb") as source:
                if source.getcomptype() != "NONE" or source.getsampwidth() != 2:
                    return False
                while frames := source.readframes(65_536):
                    if any(frames):
                        return False
                return True
        except (EOFError, OSError, wave.Error):
            return False

    def _transcription_context(
        self,
        meeting: MeetingInput,
        expected_speakers: tuple[str, ...],
    ) -> TranscriptionContext:
        candidates = [meeting.title, *self.config.primary_profile_aliases, *meeting.attendees]
        hotwords: list[str] = []
        seen: set[str] = set()
        for candidate in candidates:
            value = candidate.strip()
            key = value.casefold()
            if not value or key in seen:
                continue
            seen.add(key)
            hotwords.append(value[:200])
        return TranscriptionContext(
            expected_speakers=tuple(
                speaker.strip()[:100] for speaker in expected_speakers if speaker.strip()
            ),
            hotwords=tuple(hotwords),
            meeting_title=meeting.title[:300],
        )

    @staticmethod
    def _merge_stream_transcripts(
        results: list[tuple[TranscriptResult, str]],
    ) -> TranscriptResult:
        ordered: list[tuple[float, int, int, TranscriptSegment]] = []
        for stream_index, (result, speaker) in enumerate(results):
            segments = result.segments or [TranscriptSegment(text=result.text)]
            for segment_index, segment in enumerate(segments):
                ordered.append(
                    (
                        segment.start_seconds,
                        stream_index,
                        segment_index,
                        segment.model_copy(update={"speaker": speaker}),
                    )
                )
        ordered.sort(key=lambda item: (item[0], item[1], item[2]))
        segments = [item[3] for item in ordered]
        text = "\n".join(f"{segment.speaker}: {segment.text}" for segment in segments)
        providers = sorted({result.provider for result, _speaker in results})
        models = sorted({result.model for result, _speaker in results})
        language = next(
            (result.language for result, _speaker in results if result.language),
            None,
        )
        return TranscriptResult(
            text=text,
            segments=segments,
            language=language,
            provider="+".join(providers),
            model="+".join(models),
            diarized=True,
        )

    @staticmethod
    def _apply_speaker_corrections(
        transcript: TranscriptResult,
        corrections: dict[str, str],
    ) -> TranscriptResult:
        if not corrections or not transcript.segments:
            return transcript
        segments = [
            segment.model_copy(
                update={
                    "speaker": corrections.get(segment.speaker, segment.speaker)
                    if segment.speaker
                    else None
                }
            )
            for segment in transcript.segments
        ]
        if not any(segment.speaker for segment in segments):
            return transcript.model_copy(update={"segments": segments})
        text = "\n".join(
            f"{segment.speaker}: {segment.text}" if segment.speaker else segment.text
            for segment in segments
        )
        return transcript.model_copy(update={"text": text, "segments": segments, "diarized": True})
