from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from meeting_wiki.config import AppConfig
from meeting_wiki.engine import MeetingEngine
from meeting_wiki.models import (
    JobStage,
    MeetingInput,
    MeetingType,
    TranscriptResult,
    TranscriptSegment,
)
from meeting_wiki.providers.base import CalendarEvent
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.providers.registry import ProviderBundle


class FakeTranscriber:
    name = "fake"

    def __init__(self, result):
        self.result = result
        self.calls = []

    def transcribe(self, audio_path, language=None, context=None):
        self.calls.append((audio_path, language, context))
        return self.result

    def health(self):
        return True, "ok"


class PathCheckingTranscriber(FakeTranscriber):
    def transcribe(self, audio_path, language=None, context=None):
        if not audio_path.exists():
            raise FileNotFoundError(audio_path)
        return super().transcribe(audio_path, language, context)


class SplitTranscriber:
    name = "split-fake"

    def __init__(self, results):
        self.results = results
        self.calls = []

    def transcribe(self, audio_path, language=None, context=None):
        self.calls.append((audio_path, context))
        return self.results[audio_path.name]

    def health(self):
        return True, "ok"


class FakeLLM:
    name = "fake"

    def __init__(self, result):
        self.result = result
        self.calls = []

    def analyze(self, meeting, transcript):
        self.calls.append((meeting, transcript))
        return self.result

    def health(self):
        return True, "ok"


class FakeCalendar:
    name = "none"

    def __init__(self, event=None):
        self.event = event

    def upcoming(self, within_minutes):
        return []

    def match(self, occurred_at, tolerance_minutes=15):
        return self.event


class FakeNotification:
    name = "fake"

    def __init__(self):
        self.calls = []

    def notify(self, title, body, level="info"):
        self.calls.append((title, body, level))


class FakeTask:
    name = "fake"

    def __init__(self):
        self.calls = []

    def propose(self, item, meeting_key):
        self.calls.append((item, meeting_key))
        return "https://tasks.example/proposal"


def bundle(tmp_path, transcript, analysis):
    notification = FakeNotification()
    task = FakeTask()
    local = LocalFileStorage(tmp_path)
    providers = ProviderBundle(
        transcription=FakeTranscriber(transcript),
        llm=FakeLLM(analysis),
        storage=local,
        private_storage=local,
        calendar=FakeCalendar(),
        notification=notification,
        task=task,
    )
    return providers, notification, task


def test_public_ingest_runs_providers_renders_wiki_and_proposes_tasks(
    tmp_path, meeting, transcript, analysis
):
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"fake")
    meeting = meeting.model_copy(update={"audio_path": audio})
    config = AppConfig(data_dir=tmp_path)
    providers, notifications, tasks = bundle(tmp_path, transcript, analysis)
    result = MeetingEngine(config, providers).ingest(meeting)
    assert result.render.meeting_key.startswith("wiki/meetings/")
    assert providers.storage.exists(result.render.meeting_key)
    assert providers.storage.exists(result.transcript_key)
    assert result.analysis_key.startswith("analysis/")
    assert providers.storage.exists(result.analysis_key)
    assert len(tasks.calls) == 1
    assert result.task_urls == ["https://tasks.example/proposal"]
    assert notifications.calls[0][0] == "Meeting wiki updated"


def test_private_ingest_never_calls_task_or_writes_shared_wiki(
    tmp_path, meeting, transcript, analysis
):
    audio = tmp_path / "audio" / "private.wav"
    mic_audio = tmp_path / "audio" / "private_mic.wav"
    system_audio = tmp_path / "audio" / "private_system.wav"
    audio.parent.mkdir()
    for path in (audio, mic_audio, system_audio):
        path.write_bytes(b"fake")
    meeting = meeting.model_copy(
        update={
            "audio_path": audio,
            "mic_audio_path": mic_audio,
            "system_audio_path": system_audio,
            "private": True,
            "meeting_type": MeetingType.ONE_ON_ONE,
        }
    )
    config = AppConfig(data_dir=tmp_path)
    providers, notifications, tasks = bundle(tmp_path, transcript, analysis)
    result = MeetingEngine(config, providers).ingest(meeting)
    assert result.render.meeting_key.startswith("private/meetings/")
    assert result.transcript_key.startswith("private/transcripts/")
    assert result.analysis_key.startswith("private/analysis/")
    assert providers.storage.exists(result.analysis_key)
    assert providers.storage.list_keys("wiki/") == []
    assert not audio.exists()
    assert not mic_audio.exists()
    assert not system_audio.exists()
    private_audio = list((tmp_path / "private" / "audio").glob("*.wav"))
    assert len(private_audio) == 3
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in private_audio)
    assert tasks.calls == []
    assert notifications.calls[0][0] == "Private meeting processed"
    assert notifications.calls[0][1] == "Private notes were stored locally."
    assert "Architecture" not in notifications.calls[0][1]


def test_worker_redacts_private_title_and_path_from_stdout(
    tmp_path, meeting, transcript, analysis, monkeypatch, capsys
):
    import json

    import meeting_wiki.worker as worker_module
    from meeting_wiki.worker import Worker, enqueue_meeting

    audio = tmp_path / "private.wav"
    audio.write_bytes(b"fake")
    private_meeting = meeting.model_copy(
        update={
            "audio_path": audio,
            "title": "Sensitive Career Discussion",
            "private": True,
            "meeting_type": MeetingType.ONE_ON_ONE,
        }
    )
    config = AppConfig(data_dir=tmp_path)
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    monkeypatch.setattr(worker_module, "build_providers", lambda _: providers)
    enqueue_meeting(config, private_meeting)
    worker = Worker(config)
    assert worker.run_once() is True
    completed = worker.queue.get(1)
    assert completed.stage is JobStage.DONE
    assert completed.lease_expires_at is None
    output = json.loads(capsys.readouterr().out)
    assert output == {"job_id": 1, "state": "done", "private": True}
    assert "Sensitive" not in str(output)
    assert "private/" not in str(output)


def test_ingest_reports_deterministic_processing_stages(tmp_path, meeting, transcript, analysis):
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"fake")
    meeting = meeting.model_copy(update={"audio_path": audio})
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    stages = []

    MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(meeting, stages.append)

    assert stages == [
        JobStage.TRANSCRIBING,
        JobStage.ANALYZING,
        JobStage.RENDERING,
        JobStage.INTEGRATING,
    ]


def test_calendar_enriches_automatic_metadata_and_forces_private(tmp_path, transcript, analysis):
    occurred_at = datetime(2026, 9, 4, 15, 5, tzinfo=UTC)
    event = CalendarEvent(
        event_id="event-1",
        title="Private career check-in",
        start=occurred_at - timedelta(minutes=5),
        end=occurred_at + timedelta(minutes=55),
        attendees=["Alex", "Manager"],
        private_hint=True,
    )
    audio = tmp_path / "audio" / "meeting.wav"
    audio.parent.mkdir()
    audio.write_bytes(b"fake")
    meeting = MeetingInput(
        audio_path=audio,
        title="Generated meeting title",
        title_explicit=False,
        attendees=[],
        occurred_at=occurred_at,
        occurred_at_explicit=False,
    )
    providers, _, tasks = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(event)

    result = MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(meeting)

    enriched = providers.llm.calls[0][0]
    assert enriched.title == event.title
    assert enriched.attendees == event.attendees
    assert enriched.occurred_at == event.start
    assert enriched.calendar_event_id == event.event_id
    assert enriched.private is True
    assert result.render.meeting_key.startswith("private/meetings/")
    assert tasks.calls == []


def test_explicit_meeting_metadata_overrides_calendar(tmp_path, transcript, analysis):
    occurred_at = datetime(2026, 9, 4, 15, 5, tzinfo=UTC)
    event = CalendarEvent(
        event_id="event-2",
        title="Calendar title",
        start=occurred_at - timedelta(minutes=5),
        end=occurred_at + timedelta(minutes=55),
        attendees=["Calendar Person"],
    )
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"fake")
    meeting = MeetingInput(
        audio_path=audio,
        title="Explicit title",
        title_explicit=True,
        attendees=["Explicit Person"],
        occurred_at=occurred_at,
        occurred_at_explicit=True,
    )
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(event)

    MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(meeting)

    enriched = providers.llm.calls[0][0]
    assert enriched.title == "Explicit title"
    assert enriched.attendees == ["Explicit Person"]
    assert enriched.occurred_at == occurred_at
    assert enriched.calendar_event_id == event.event_id


def test_dual_stream_transcription_labels_and_corrects_speakers(tmp_path, meeting, analysis):
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    merged = audio_dir / "meeting.wav"
    mic = audio_dir / "meeting_mic.wav"
    system = audio_dir / "meeting_system.wav"
    for path in (merged, mic, system):
        path.write_bytes(b"fake")
    mic_result = TranscriptResult(
        text="I will own the migration.",
        segments=[TranscriptSegment(start_seconds=1, end_seconds=2, text="I will own it.")],
        provider="fake",
        model="fake",
    )
    system_result = TranscriptResult(
        text="Please finish by Friday.",
        segments=[
            TranscriptSegment(start_seconds=2, end_seconds=3, text="Please finish by Friday.")
        ],
        provider="fake",
        model="fake",
    )
    meeting = meeting.model_copy(
        update={
            "audio_path": merged,
            "mic_audio_path": mic,
            "system_audio_path": system,
            "attendees": ["Alex", "Sam"],
            "speaker_corrections": {"Remote participant": "Sam"},
        }
    )
    providers, _, _ = bundle(tmp_path, mic_result, analysis)
    providers.transcription = SplitTranscriber({mic.name: mic_result, system.name: system_result})

    result = MeetingEngine(AppConfig(data_dir=tmp_path, user_name="Local User"), providers).ingest(
        meeting
    )

    mic_call, system_call = providers.transcription.calls
    assert mic_call[0] == mic
    assert mic_call[1].expected_speakers == ("Local User",)
    assert system_call[0] == system
    assert system_call[1].expected_speakers == ("Alex", "Sam")
    assert system_call[1].meeting_title == "Architecture Design Review"
    assert "Architecture Design Review" in system_call[1].hotwords
    assert "Alex" in system_call[1].hotwords
    assert "Sam" in system_call[1].hotwords
    assert [segment.speaker for segment in result.transcript.segments] == ["Local User", "Sam"]
    assert result.transcript.text == ("Local User: I will own it.\nSam: Please finish by Friday.")
    assert result.transcript.diarized is True
    assert providers.storage.exists(result.transcript_data_key)


def test_private_reprocess_reuses_structured_transcript_after_audio_moves(
    tmp_path, meeting, transcript, analysis
):
    audio = tmp_path / "audio" / "private.wav"
    audio.parent.mkdir()
    audio.write_bytes(b"fake")
    private_meeting = meeting.model_copy(
        update={
            "audio_path": audio,
            "private": True,
            "meeting_type": MeetingType.ONE_ON_ONE,
        }
    )
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.transcription = PathCheckingTranscriber(transcript)
    engine = MeetingEngine(AppConfig(data_dir=tmp_path), providers)

    first = engine.ingest(private_meeting)
    assert not audio.exists()
    assert len(providers.transcription.calls) == 1

    second = engine.ingest(private_meeting)

    assert second.transcript == first.transcript
    assert second.render.meeting_key == first.render.meeting_key
    assert len(providers.transcription.calls) == 1


def test_private_audio_is_not_moved_before_analysis_succeeds(
    tmp_path, meeting, transcript, analysis
):
    audio = tmp_path / "audio" / "private.wav"
    audio.parent.mkdir()
    audio.write_bytes(b"fake")
    private_meeting = meeting.model_copy(
        update={
            "audio_path": audio,
            "private": True,
            "meeting_type": MeetingType.ONE_ON_ONE,
        }
    )
    providers, _, _ = bundle(tmp_path, transcript, analysis)

    def fail_analysis(_meeting, _transcript):
        raise RuntimeError("temporary model failure")

    providers.llm.analyze = fail_analysis

    with pytest.raises(RuntimeError, match="temporary model failure"):
        MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(private_meeting)

    assert audio.exists()
    assert len(providers.transcription.calls) == 1
    assert len(list((tmp_path / "private" / "transcript-data").glob("*.json"))) == 1
