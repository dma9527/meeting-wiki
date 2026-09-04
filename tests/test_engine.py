from __future__ import annotations

from meeting_wiki.config import AppConfig
from meeting_wiki.engine import MeetingEngine
from meeting_wiki.models import MeetingType
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.providers.registry import ProviderBundle


class FakeTranscriber:
    name = "fake"

    def __init__(self, result):
        self.result = result
        self.calls = []

    def transcribe(self, audio_path, language=None):
        self.calls.append((audio_path, language))
        return self.result

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

    def upcoming(self, within_minutes):
        return []


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
    assert len(tasks.calls) == 1
    assert result.task_urls == ["https://tasks.example/proposal"]
    assert notifications.calls[0][0] == "Meeting wiki updated"


def test_private_ingest_never_calls_task_or_writes_shared_wiki(
    tmp_path, meeting, transcript, analysis
):
    audio = tmp_path / "audio" / "private.wav"
    audio.parent.mkdir()
    audio.write_bytes(b"fake")
    meeting = meeting.model_copy(
        update={"audio_path": audio, "private": True, "meeting_type": MeetingType.ONE_ON_ONE}
    )
    config = AppConfig(data_dir=tmp_path)
    providers, notifications, tasks = bundle(tmp_path, transcript, analysis)
    result = MeetingEngine(config, providers).ingest(meeting)
    assert result.render.meeting_key.startswith("private/meetings/")
    assert result.transcript_key.startswith("private/transcripts/")
    assert providers.storage.list_keys("wiki/") == []
    assert not audio.exists()
    private_audio = list((tmp_path / "private" / "audio").glob("*.wav"))
    assert len(private_audio) == 1
    assert private_audio[0].stat().st_mode & 0o777 == 0o600
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
    assert Worker(config).run_once() is True
    output = json.loads(capsys.readouterr().out)
    assert output == {"job_id": 1, "state": "done", "private": True}
    assert "Sensitive" not in str(output)
    assert "private/" not in str(output)
