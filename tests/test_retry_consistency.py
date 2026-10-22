from __future__ import annotations

import json
import sqlite3
import time

import httpx
import pytest

import meeting_wiki.engine as engine_module
import meeting_wiki.worker as worker_module
from meeting_wiki.config import AppConfig
from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import JobState, MeetingType
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.providers.registry import ProviderBundle
from meeting_wiki.worker import Worker, enqueue_meeting


class _Transcriber:
    name = "fake"

    def __init__(self, result):
        self.result = result

    def transcribe(self, audio_path, language=None, context=None):
        return self.result

    def health(self):
        return True, "ok"


class _GenerationLLM:
    """Every call returns a distinguishable analysis generation."""

    name = "fake"

    def __init__(self, base, on_analyze=None):
        self.base = base
        self.calls = 0
        self.on_analyze = on_analyze

    def analyze(self, meeting, transcript):
        self.calls += 1
        if self.on_analyze is not None:
            self.on_analyze()
        return self.base.model_copy(update={"summary": [f"Generation {self.calls}"]})

    def health(self):
        return True, "ok"


class _Calendar:
    name = "none"

    def upcoming(self, within_minutes):
        return []

    def match(self, occurred_at, tolerance_minutes=15):
        return None


class _Notification:
    name = "fake"

    def __init__(self, error=None):
        self.error = error
        self.calls = 0

    def notify(self, title, body, level="info"):
        self.calls += 1
        if self.error is not None:
            raise self.error


class _Task:
    name = "fake"

    def __init__(self):
        self.calls = 0
        self.fail_next = False

    def propose(self, item, meeting_key, *, action_key=None):
        self.calls += 1
        if self.fail_next:
            self.fail_next = False
            raise httpx.ConnectError("offline")
        return "https://tasks.example/proposal"


def _worker(tmp_path, monkeypatch, transcript, analysis, *, notification=None, on_analyze=None):
    storage = LocalFileStorage(tmp_path)
    providers = ProviderBundle(
        transcription=_Transcriber(transcript),
        llm=_GenerationLLM(analysis, on_analyze),
        storage=storage,
        private_storage=storage,
        calendar=_Calendar(),
        notification=notification or _Notification(),
        task=_Task(),
    )
    monkeypatch.setattr(worker_module, "build_providers", lambda _config: providers)
    config = AppConfig(data_dir=tmp_path)
    return config, Worker(config), providers


def _audio(tmp_path, name="meeting.wav"):
    path = tmp_path / "audio" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fake")
    return path


def _stored_summary(storage, prefix="analysis/"):
    keys = [key for key in storage.list_keys(prefix) if key.endswith(".json")]
    assert len(keys) == 1
    return json.loads(storage.read_text(keys[0]))["summary"]


def _fail_once(monkeypatch, target, name):
    original = getattr(target, name)
    state = {"failed": False}

    def wrapper(*args, **kwargs):
        if not state["failed"]:
            state["failed"] = True
            raise RuntimeError("transient failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(target, name, wrapper)


@pytest.mark.parametrize("failure", ["render", "memory", "task"])
def test_retry_after_post_analysis_failure_reuses_the_job_analysis(
    tmp_path, monkeypatch, meeting, transcript, analysis, failure, capsys
):
    config, worker, providers = _worker(tmp_path, monkeypatch, transcript, analysis)
    if failure == "render":
        _fail_once(monkeypatch, engine_module.WikiRenderer, "apply")
    elif failure == "memory":
        _fail_once(monkeypatch, engine_module.MemoryStore, "index_meeting")
    else:
        providers.task.fail_next = True
    job_id = enqueue_meeting(config, meeting.model_copy(update={"audio_path": _audio(tmp_path)}))

    assert worker.run_once() is True
    assert worker.queue.get(job_id).state is JobState.FAILED
    worker.queue.retry(job_id)
    assert worker.run_once() is True

    assert worker.queue.get(job_id).state is JobState.DONE
    assert providers.llm.calls == 1
    assert _stored_summary(providers.storage) == ["Generation 1"]
    assert worker.queue.load_analysis_snapshot(job_id) is None
    codes = [event["code"] for event in worker.journal.recent()]
    assert "engine.analysis_reused" in codes
    assert "Generation" not in json.dumps(worker.journal.recent())


def test_notification_failure_after_commit_is_not_fatal_and_is_journaled(
    tmp_path, monkeypatch, meeting, transcript, analysis, capsys
):
    notification = _Notification(RuntimeError("Notification for Architecture failed"))
    config, worker, providers = _worker(
        tmp_path, monkeypatch, transcript, analysis, notification=notification
    )
    job_id = enqueue_meeting(config, meeting.model_copy(update={"audio_path": _audio(tmp_path)}))

    assert worker.run_once() is True

    assert worker.queue.get(job_id).state is JobState.DONE
    assert notification.calls == 1
    events = [event for event in worker.journal.recent() if event["code"] == "engine.notify_failed"]
    assert events == [
        {**events[0], "job_id": job_id, "error_type": "RuntimeError", "outcome": "skipped"}
    ]
    assert "Architecture" not in json.dumps(worker.journal.recent())


def test_private_audio_relocation_failure_is_not_fatal_and_keeps_audio(
    tmp_path, monkeypatch, meeting, transcript, analysis, capsys
):
    config, worker, providers = _worker(tmp_path, monkeypatch, transcript, analysis)
    audio = _audio(tmp_path, "private.wav")
    private_meeting = meeting.model_copy(
        update={"audio_path": audio, "private": True, "meeting_type": MeetingType.ONE_ON_ONE}
    )

    def refuse(*_args, **_kwargs):
        raise PermissionError("/Users/test-user/private.wav")

    monkeypatch.setattr(engine_module.shutil, "move", refuse)
    job_id = enqueue_meeting(config, private_meeting)

    assert worker.run_once() is True

    assert worker.queue.get(job_id).state is JobState.DONE
    assert audio.exists()
    assert providers.storage.list_keys("private/meetings/")
    events = [
        event
        for event in worker.journal.recent()
        if event["code"] == "engine.audio_relocate_failed"
    ]
    assert [(event["outcome"], event["error_type"]) for event in events] == [
        ("merged", "PermissionError")
    ]
    assert "test-user" not in json.dumps(worker.journal.recent())
    assert "private" not in capsys.readouterr().out.replace('"private": true', "")


def test_stale_worker_cannot_publish_or_fail_a_newer_claim(
    tmp_path, monkeypatch, meeting, transcript, analysis, capsys
):
    stolen = {}

    def steal_claim():
        # Another worker reclaims the expired lease while this one is still analyzing.
        other = JobQueue(tmp_path / "jobs.db", visibility_timeout_seconds=10)
        with sqlite3.connect(other.path) as connection:
            connection.execute(
                "UPDATE jobs SET claimed_at=?, lease_expires_at=?",
                (time.time() - 20, time.time() - 1),
            )
        other.reclaim_stale()
        stolen["job"] = other.claim()

    config, worker, providers = _worker(
        tmp_path, monkeypatch, transcript, analysis, on_analyze=steal_claim
    )
    job_id = enqueue_meeting(config, meeting.model_copy(update={"audio_path": _audio(tmp_path)}))

    assert worker.run_once() is True

    job = worker.queue.get(job_id)
    assert job.state is JobState.RUNNING
    assert job.claim_token == stolen["job"].claim_token
    assert job.last_error is None
    assert worker.queue.load_analysis_snapshot(job_id) is None
    assert providers.storage.list_keys("wiki/meetings/") == []
    output = json.loads(capsys.readouterr().out)
    assert output == {"job_id": job_id, "state": "claim_lost"}
    assert "job.claim_lost" in [event["code"] for event in worker.journal.recent()]


def test_run_forever_survives_an_unexpected_iteration_error(
    tmp_path, monkeypatch, transcript, analysis, capsys
):
    _config, worker, _providers = _worker(tmp_path, monkeypatch, transcript, analysis)

    class Stop(BaseException):
        pass

    calls = {"count": 0}

    def flaky_run_once():
        calls["count"] += 1
        if calls["count"] == 1:
            raise sqlite3.OperationalError("database is locked: /Users/test-user/jobs.db")
        raise Stop

    monkeypatch.setattr(worker, "run_once", flaky_run_once)
    monkeypatch.setattr(worker_module.time, "sleep", lambda _seconds: None)

    with pytest.raises(Stop):
        worker.run_forever()

    assert calls["count"] == 2
    output = capsys.readouterr().out
    assert json.loads(output.splitlines()[0]) == {
        "state": "worker_error",
        "error_type": "OperationalError",
    }
    assert "test-user" not in output
