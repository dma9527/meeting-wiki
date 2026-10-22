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
        self.match_calls = []

    def upcoming(self, within_minutes):
        return []

    def match(self, occurred_at, tolerance_minutes=15):
        self.match_calls.append(occurred_at)
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

    def propose(self, item, meeting_key, *, action_key=None):
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


def test_worker_freezes_privacy_before_side_effects_so_retries_cannot_flip_it(
    tmp_path, transcript, analysis, monkeypatch, capsys
):
    import json

    import meeting_wiki.worker as worker_module
    from meeting_wiki.worker import Worker, enqueue_meeting

    started = datetime(2026, 9, 4, 15, 5, tzinfo=UTC)
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"fake")
    meeting = MeetingInput(
        audio_path=audio,
        title="Meeting placeholder",
        title_explicit=False,
        occurred_at=started,
        occurred_at_explicit=False,
        recording_started_at=started,
    )
    private_event = CalendarEvent(
        event_id="event-private",
        title="Career check-in",
        start=started - timedelta(minutes=5),
        end=started + timedelta(minutes=55),
        attendees=["Alex", "Manager"],
        private_hint=True,
    )
    config = AppConfig(data_dir=tmp_path)
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(private_event)

    class FailingTranscriber(FakeTranscriber):
        def transcribe(self, audio_path, language=None, context=None):
            raise RuntimeError("provider outage")

    good_transcriber = providers.transcription
    providers.transcription = FailingTranscriber(transcript)
    monkeypatch.setattr(worker_module, "build_providers", lambda _: providers)
    job_id = enqueue_meeting(config, meeting)
    worker = Worker(config)
    assert worker.run_once() is True
    failed = worker.queue.get(job_id)
    assert failed.payload["classification_frozen"] is True
    assert failed.payload["private"] is True
    assert failed.payload["calendar_event_id"] == "event-private"

    # The calendar entry disappears before the retry; the frozen decision holds.
    providers.calendar = FakeCalendar(None)
    providers.transcription = good_transcriber
    worker.queue.retry(job_id)
    capsys.readouterr()
    assert worker.run_once() is True
    assert providers.calendar.match_calls == []
    output = json.loads(capsys.readouterr().out)
    assert output == {"job_id": job_id, "state": "done", "private": True}
    assert providers.storage.list_keys("wiki/") == []


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
        recording_started_at=occurred_at,
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


def test_calendar_match_uses_recording_start_not_stop_time(tmp_path, transcript, analysis):
    started = datetime(2026, 9, 4, 15, 2, tzinfo=UTC)
    stopped = datetime(2026, 9, 4, 16, 40, tzinfo=UTC)
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"fake")
    meeting = MeetingInput(
        audio_path=audio,
        title="Meeting placeholder",
        title_explicit=False,
        occurred_at=stopped,
        occurred_at_explicit=False,
        recording_started_at=started,
    )
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(None)

    MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(meeting)

    assert providers.calendar.match_calls == [started]


def test_imported_audio_without_source_time_is_never_calendar_matched(
    tmp_path, transcript, analysis
):
    now = datetime(2026, 9, 4, 15, 5, tzinfo=UTC)
    current_event = CalendarEvent(
        event_id="current-event",
        title="Private career check-in",
        start=now - timedelta(minutes=5),
        end=now + timedelta(minutes=55),
        attendees=["Alex", "Manager"],
        private_hint=True,
    )
    audio = tmp_path / "imported.wav"
    audio.write_bytes(b"fake")
    meeting = MeetingInput(
        audio_path=audio,
        title="Imported meeting",
        title_explicit=False,
        occurred_at=now,
        occurred_at_explicit=False,
    )
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(current_event)

    result = MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(meeting)

    assert providers.calendar.match_calls == []
    enriched = providers.llm.calls[0][0]
    assert enriched.calendar_event_id is None
    assert enriched.title == "Imported meeting"
    assert result.render.meeting_key.startswith("wiki/meetings/")


def test_resolve_freezes_calendar_identity_and_privacy(tmp_path, transcript, analysis):
    started = datetime(2026, 9, 4, 15, 5, tzinfo=UTC)
    event = CalendarEvent(
        event_id="event-frozen",
        title="Career check-in",
        start=started - timedelta(minutes=5),
        end=started + timedelta(minutes=55),
        attendees=["Alex", "Manager"],
        private_hint=True,
    )
    meeting = MeetingInput(
        audio_path=tmp_path / "meeting.wav",
        title="Meeting placeholder",
        title_explicit=False,
        occurred_at=started,
        occurred_at_explicit=False,
        recording_started_at=started,
    )
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(event)
    engine = MeetingEngine(AppConfig(data_dir=tmp_path), providers)

    resolved = engine.resolve(meeting)

    assert resolved.classification_frozen is True
    assert resolved.private is True
    assert resolved.calendar_event_id == "event-frozen"
    assert resolved.meeting_type is not None
    assert resolved.ingest_id == meeting.ingest_id
    # A frozen meeting is returned unchanged, even if the calendar changes.
    providers.calendar = FakeCalendar(None)
    assert engine.resolve(resolved) == resolved
    assert providers.calendar.match_calls == []


def test_frozen_shared_meeting_stays_shared_when_calendar_later_says_private(
    tmp_path, transcript, analysis
):
    started = datetime(2026, 9, 4, 15, 5, tzinfo=UTC)
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"fake")
    frozen = MeetingInput(
        audio_path=audio,
        title="Architecture sync",
        title_explicit=False,
        occurred_at=started,
        occurred_at_explicit=False,
        recording_started_at=started,
        meeting_type=MeetingType.GENERIC,
        private=False,
        classification_frozen=True,
    )
    late_private = CalendarEvent(
        event_id="late-edit",
        title="Career check-in",
        start=started - timedelta(minutes=5),
        end=started + timedelta(minutes=55),
        private_hint=True,
    )
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.calendar = FakeCalendar(late_private)

    result = MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(frozen)

    assert providers.calendar.match_calls == []
    assert result.render.meeting_key.startswith("wiki/meetings/")
    assert providers.llm.calls[0][0].calendar_event_id is None


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


def write_pcm_wav(path, samples: list[int]) -> None:
    import array
    import wave

    payload = array.array("h", samples).tobytes()
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(payload)


def test_dual_stream_skips_provably_silent_system_audio(tmp_path, meeting, analysis):
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    mic = audio_dir / "meeting_mic.wav"
    system = audio_dir / "meeting_system.wav"
    mic.write_bytes(b"mic audio")
    write_pcm_wav(system, [0] * 160)
    mic_result = TranscriptResult(
        text="I will own it.",
        segments=[TranscriptSegment(text="I will own it.")],
        provider="fake",
        model="fake",
    )
    providers, _, _ = bundle(tmp_path, mic_result, analysis)
    providers.transcription = SplitTranscriber({mic.name: mic_result})
    meeting = meeting.model_copy(
        update={"mic_audio_path": mic, "system_audio_path": system, "attendees": ["Alex"]}
    )

    config = AppConfig(data_dir=tmp_path, user_name="Local User")
    result = MeetingEngine(config, providers).ingest(meeting)

    assert [call[0] for call in providers.transcription.calls] == [mic]
    assert result.transcript.text == "Local User: I will own it."


def test_dual_stream_keeps_mic_when_system_returns_empty_transcript(tmp_path, meeting, analysis):
    from meeting_wiki.providers.base import EmptyTranscriptError

    mic = tmp_path / "mic.wav"
    system = tmp_path / "system.wav"
    mic.write_bytes(b"mic audio")
    system.write_bytes(b"non-silent unsupported format")
    mic_result = TranscriptResult(
        text="Mic speech.",
        segments=[TranscriptSegment(text="Mic speech.")],
        provider="fake",
        model="fake",
    )

    class EmptySystemTranscriber(FakeTranscriber):
        def transcribe(self, audio_path, language=None, context=None):
            self.calls.append((audio_path, language, context))
            if audio_path == system:
                raise EmptyTranscriptError("empty")
            return mic_result

    providers, _, _ = bundle(tmp_path, mic_result, analysis)
    providers.transcription = EmptySystemTranscriber(mic_result)
    meeting = meeting.model_copy(update={"mic_audio_path": mic, "system_audio_path": system})

    result = MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(meeting)

    assert result.transcript.text == "User: Mic speech."
    assert [call[0] for call in providers.transcription.calls] == [mic, system]


def test_dual_stream_propagates_real_system_provider_error(tmp_path, meeting, analysis):
    mic = tmp_path / "mic.wav"
    system = tmp_path / "system.wav"
    mic.write_bytes(b"mic audio")
    system.write_bytes(b"non-silent unsupported format")
    mic_result = TranscriptResult(text="Mic speech.", provider="fake", model="fake")

    class FailingSystemTranscriber(FakeTranscriber):
        def transcribe(self, audio_path, language=None, context=None):
            if audio_path == system:
                raise ConnectionError("provider unavailable")
            return mic_result

    providers, _, _ = bundle(tmp_path, mic_result, analysis)
    providers.transcription = FailingSystemTranscriber(mic_result)
    meeting = meeting.model_copy(update={"mic_audio_path": mic, "system_audio_path": system})

    with pytest.raises(ConnectionError, match="provider unavailable"):
        MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(meeting)


def test_dual_stream_rejects_when_every_stream_is_silent_or_empty(tmp_path, meeting, analysis):
    mic = tmp_path / "mic.wav"
    system = tmp_path / "system.wav"
    write_pcm_wav(mic, [0] * 160)
    write_pcm_wav(system, [0] * 160)
    unused = TranscriptResult(text="unused", provider="fake", model="fake")
    providers, _, _ = bundle(tmp_path, unused, analysis)
    meeting = meeting.model_copy(update={"mic_audio_path": mic, "system_audio_path": system})

    with pytest.raises(ValueError, match="No non-empty audio streams"):
        MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(meeting)
