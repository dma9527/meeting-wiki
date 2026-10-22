from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from meeting_wiki.captures import enqueue_capture, recover_captures
from meeting_wiki.cli import main, meeting_from_args
from meeting_wiki.config import AppConfig
from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import MeetingInput

STARTED = "2026-09-04T15:02:00+00:00"


def _capture(tmp_path, name="2026-09-04-150200", **overrides):
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir(exist_ok=True)
    merged = audio_dir / f"{name}.wav"
    mic = audio_dir / f"{name}_mic.wav"
    for path in (merged, mic):
        path.write_bytes(b"fake")
    manifest = {
        "version": 1,
        "audio_path": str(merged),
        "mic_audio_path": str(mic),
        "system_audio_path": None,
        "title": "Meeting placeholder",
        "title_explicit": False,
        "private": True,
        "recording_started_at": STARTED,
        "occurred_at": None,
    }
    manifest.update(overrides)
    path = audio_dir / f"{name}.capture.json"
    path.write_text(json.dumps(manifest))
    return path, merged, mic


def _jobs(tmp_path):
    return JobQueue(tmp_path / "jobs.db").list()


def test_enqueue_capture_persists_recording_start_and_privacy_then_clears_manifest(tmp_path):
    config = AppConfig(data_dir=tmp_path)
    manifest, merged, mic = _capture(tmp_path)

    job_id = enqueue_capture(config, manifest)

    meeting = MeetingInput.model_validate(JobQueue(tmp_path / "jobs.db").get(job_id).payload)
    assert meeting.recording_started_at == datetime(2026, 9, 4, 15, 2, tzinfo=UTC)
    assert meeting.occurred_at == meeting.recording_started_at
    assert meeting.occurred_at_explicit is False
    assert meeting.private is True
    assert meeting.audio_path == merged.resolve()
    assert meeting.mic_audio_path == mic.resolve()
    assert meeting.title_explicit is False
    assert not manifest.exists()


def test_capture_enqueue_is_idempotent_when_manifest_survives_a_crash(tmp_path):
    config = AppConfig(data_dir=tmp_path)
    manifest, _, _ = _capture(tmp_path)
    saved = manifest.read_text()
    first = enqueue_capture(config, manifest)
    manifest.write_text(saved)

    assert enqueue_capture(config, manifest) == first
    assert len(_jobs(tmp_path)) == 1


def test_recover_captures_enqueues_finalized_audio_and_keeps_invalid_manifests(tmp_path):
    config = AppConfig(data_dir=tmp_path)
    valid, _, _ = _capture(tmp_path, "valid")
    outside = tmp_path / "elsewhere.wav"
    outside.write_bytes(b"fake")
    escaped, _, _ = _capture(tmp_path, "escaped", audio_path=str(outside))
    no_privacy, _, _ = _capture(tmp_path, "no-privacy")
    data = json.loads(no_privacy.read_text())
    del data["private"]
    no_privacy.write_text(json.dumps(data))
    missing_audio, merged, _ = _capture(tmp_path, "missing")
    merged.unlink()

    summary = recover_captures(config)

    assert summary == {"recovered": 1, "invalid": 3}
    assert not valid.exists()
    assert escaped.exists() and no_privacy.exists() and missing_audio.exists()
    jobs = _jobs(tmp_path)
    assert len(jobs) == 1
    assert jobs[0].payload["private"] is True


def test_recover_captures_without_audio_directory_is_a_no_op(tmp_path):
    assert recover_captures(AppConfig(data_dir=tmp_path)) == {"recovered": 0, "invalid": 0}


def test_cli_capture_enqueue_and_recovery_need_no_provider_credentials(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("MEETING_WIKI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("MEETING_WIKI_TEST_FAKE_KEY", raising=False)
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        '[providers]\ntranscription = "openai_compatible"\n'
        '[openai_transcription]\napi_key_env = "MEETING_WIKI_TEST_FAKE_KEY"\n'
    )
    manifest, _, _ = _capture(tmp_path, "first")
    assert main(["--config", str(config_path), "ingest", "--capture-manifest", str(manifest)]) == 0
    assert json.loads(capsys.readouterr().out)["queued"] is True

    _capture(tmp_path, "second")
    assert main(["--config", str(config_path), "recover-captures"]) == 0
    assert json.loads(capsys.readouterr().out) == {"recovered": 1, "invalid": 0}
    assert len(_jobs(tmp_path)) == 2


def test_cli_recording_started_at_anchors_calendar_without_marking_time_explicit():
    class Args:
        audio = "/tmp/meeting-wiki-test.wav"
        mic_audio = None
        system_audio = None
        transcript = None
        title = "Meeting placeholder"
        title_auto = True
        attendees = None
        private = False
        occurred_at = None
        recording_started_at = STARTED
        speaker = None
        notes = None

    meeting = meeting_from_args(Args())
    assert meeting.recording_started_at == datetime(2026, 9, 4, 15, 2, tzinfo=UTC)
    assert meeting.occurred_at == meeting.recording_started_at
    assert meeting.occurred_at_explicit is False


def test_manifest_rejects_naive_recording_start(tmp_path):
    config = AppConfig(data_dir=tmp_path)
    manifest, _, _ = _capture(tmp_path, recording_started_at="2026-09-04T15:02:00")
    with pytest.raises(ValueError):
        enqueue_capture(config, manifest)
    assert manifest.exists()
