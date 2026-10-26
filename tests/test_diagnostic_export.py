from __future__ import annotations

import datetime
import json
import os
import re
import socket
import sqlite3
import stat

import pytest

from meeting_wiki import diagnostic_export
from meeting_wiki.cli import main
from meeting_wiki.diagnostic_export import (
    DiagnosticExportError,
    assert_privacy_safe,
    build_diagnostic_report,
    write_diagnostic_report,
)
from meeting_wiki.diagnostics import SafeProviderError, encode_diagnostic, safe_job_diagnostic
from meeting_wiki.events import Component, EventCode, EventJournal
from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import JobType

CANARIES = (
    "CANARY-private-board-title",
    "canary-attendee@example.test",
    "https://canary.example.test/secret-path",
    "sk-canary-key-0123456789abcdef",
    "/Users/canary-person/Meetings/secret.wav",
    "Canary Person",
)


def make_config(tmp_path):
    data_dir = tmp_path / "data"
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        "\n".join(
            [
                f'data_dir = "{data_dir}"',
                "[providers]",
                'transcription = "openai_compatible"',
                'llm = "openai_compatible"',
                'live_transcription = "openai_compatible"',
                'live_language = "openai_compatible"',
                "[live]",
                "allow_external_providers = true",
                "[openai_compatible]",
                'base_url = "https://canary.example.test/v1"',
                'model = "canary-language-model"',
                'api_key_env = "MEETING_WIKI_CANARY_KEY"',
                "[openai_transcription]",
                'base_url = "https://canary.example.test/v1"',
                'model = "canary-transcription-model"',
                'api_key_env = "MEETING_WIKI_CANARY_KEY"',
            ]
        )
    )
    return config_path, data_dir


def seed(data_dir, canary_error=True):
    journal = EventJournal(data_dir / "events.db")
    journal.record(EventCode.JOB_CLAIMED, Component.QUEUE, job_id=1, attempt=1)
    journal.record(
        EventCode.JOB_FAILED, Component.WORKER, job_id=1, attempt=1, error_type="SafeProviderError"
    )
    queue = JobQueue(data_dir / "jobs.db", max_attempts=1, journal=journal)
    payload = {
        "title": CANARIES[0],
        "attendees": [CANARIES[1], CANARIES[5]],
        "url": CANARIES[2],
        "audio_path": CANARIES[4],
        "private": True,
    }
    job_id = queue.enqueue(JobType.INGEST, payload, "canary-dedupe")
    job = queue.claim()
    assert job and job.id == job_id
    error = SafeProviderError("gemini", "transcribe", RuntimeError(CANARIES[3]))
    diagnostic = safe_job_diagnostic(
        error, stage="transcribing", attempt=1, max_attempts=1, provider="gemini"
    )
    text = encode_diagnostic(diagnostic) if canary_error else f"RuntimeError: {CANARIES[3]}"
    queue.fail(job_id, text, claim_token=job.claim_token)
    return job_id


def flatten(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from flatten(item)
    elif isinstance(value, list):
        for item in value:
            yield from flatten(item)
    else:
        yield value


def test_report_has_a_fixed_shape_with_versions_and_codes(tmp_path):
    config_path, data_dir = make_config(tmp_path)
    seed(data_dir)
    report = build_diagnostic_report(config_path)

    assert report["format"] == "meeting-wiki-diagnostics"
    assert report["version"] == 1
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", report["generated_at"])
    assert report["app"]["component_version"]
    assert report["app"]["platform"]
    assert report["self_check"]["version"] == 1
    assert report["self_check"]["mode"] == "offline"
    assert set(report["self_check"]["capabilities"]) == {"storage", "memory"}
    assert report["self_check"]["providers"]["transcription"] == "openai_compatible"
    assert report["sources"] == {"jobs": "ok", "events": "ok", "live_log": "missing"}
    assert report["jobs"]["summary"]["total"] == 1
    assert report["jobs"]["summary"]["action_required"] == 1
    [failed] = report["jobs"]["failed"]
    assert failed["state"] == "dead"
    assert failed["stage"] == "queued"
    assert failed["diagnostic"]["stage"] == "transcribing"
    assert failed["diagnostic"]["category"] == "provider_request_failed"
    assert failed["diagnostic"]["provider"] == "gemini"
    assert failed["error_type"] == "SafeProviderError"
    assert {event["code"] for event in report["events"]} >= {"job.claimed", "job.failed"}
    for event in report["events"]:
        assert event["component_version"]


def test_report_never_contains_meeting_content_urls_names_keys_or_paths(tmp_path, monkeypatch):
    config_path, data_dir = make_config(tmp_path)
    monkeypatch.setenv("MEETING_WIKI_CANARY_KEY", CANARIES[3])
    seed(data_dir)
    report = build_diagnostic_report(config_path)
    text = json.dumps(report)
    for canary in CANARIES:
        assert canary not in text, canary
    for forbidden in (str(tmp_path), str(data_dir), "canary", "example.test", "/Users/"):
        assert forbidden not in text, forbidden
    assert os.path.expanduser("~") not in text


def test_a_legacy_unstructured_job_error_is_reduced_to_a_type_code_only(tmp_path):
    config_path, data_dir = make_config(tmp_path)
    seed(data_dir, canary_error=False)
    report = build_diagnostic_report(config_path)
    assert CANARIES[3] not in json.dumps(report)
    [failed] = report["jobs"]["failed"]
    assert failed["error_type"] == "legacy_unstructured"
    assert "diagnostic" not in failed


def test_live_log_entries_are_reduced_to_allowlisted_fields(tmp_path):
    config_path, data_dir = make_config(tmp_path)
    log = data_dir / "logs" / "live.log"
    log.parent.mkdir(parents=True)
    log.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "time": "2026-10-01T10:00:00+00:00",
                        "event": "live_probe_connection_failed",
                        "close_code": 1011,
                        "provider_status": "RESOURCE_EXHAUSTED",
                    }
                ),
                json.dumps(
                    {
                        "time": "2026-10-01T10:01:00+00:00",
                        "event": "live_chunk_failed",
                        "text": CANARIES[0],
                        "path": CANARIES[4],
                        "close_code": 1008,
                    }
                ),
                "not json " + CANARIES[2],
                json.dumps({"time": CANARIES[0], "event": CANARIES[1], "channel": "you"}),
                json.dumps(["list", CANARIES[5]]),
            ]
        )
        + "\n"
    )
    report = build_diagnostic_report(config_path)
    entries = report["live_log"]
    assert entries[0] == {
        "time": "2026-10-01T10:00:00+00:00",
        "event": "live_probe_connection_failed",
        "close_code": 1011,
        "provider_status": "RESOURCE_EXHAUSTED",
    }
    assert entries[1] == {
        "time": "2026-10-01T10:01:00+00:00",
        "event": "live_chunk_failed",
        "close_code": 1008,
    }
    assert all(
        set(entry)
        <= {
            "time",
            "event",
            "channel",
            "error_type",
            "sdk_error_type",
            "http_status",
            "close_code",
            "provider_status",
        }
        for entry in entries
    )
    text = json.dumps(report)
    for canary in CANARIES:
        assert canary not in text


def test_the_report_is_bounded(tmp_path):
    config_path, data_dir = make_config(tmp_path)
    journal = EventJournal(data_dir / "events.db")
    for index in range(400):
        journal.record(
            EventCode.JOB_STAGE, Component.WORKER, job_id=index + 1, stage_to="analyzing"
        )
    log = data_dir / "logs" / "live.log"
    log.parent.mkdir(parents=True)
    log.write_text(
        "".join(
            json.dumps(
                {
                    "time": "2026-10-01T10:00:00+00:00",
                    "event": "live_chunk_failed",
                    "close_code": 1000,
                }
            )
            + "\n"
            for _ in range(500)
        )
    )
    report = build_diagnostic_report(config_path, event_limit=50)
    assert len(report["events"]) == 50
    assert len(report["live_log"]) <= 100


def test_a_missing_data_directory_still_produces_a_valid_report(tmp_path):
    config_path, data_dir = make_config(tmp_path)
    assert not data_dir.exists()
    report = build_diagnostic_report(config_path)
    assert report["events"] == []
    assert report["live_log"] == []
    assert report["jobs"] is None
    assert report["sources"]["jobs"] == "missing"
    assert not data_dir.exists(), "exporting must not create the data directory"


def test_an_unreadable_config_yields_a_report_marked_invalid(tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.write_text("this is = = not toml")
    report = build_diagnostic_report(config_path)
    assert report["self_check"]["config"] == "invalid"
    assert report["jobs"] is None
    assert report["events"] == []


@pytest.mark.parametrize(
    "value",
    [
        {"free": "a sentence with spaces"},
        {"path": "/Users/someone/file.wav"},
        {"url": "https://example.test/x"},
        {"mail": "someone@example.test"},
        {"long": "a" * 200},
        {"nested": [{"title": "Board meeting"}]},
        {"key": "sk-live key"},
        {"obj": object()},
        {"token": "sk-abcdefgh12345678"},
        {"google": "AIzaSyExampleKey1234"},
        {"blob": "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"},
        {"AIza-in-the-middle": "x"},
    ],
)
def test_the_final_scan_rejects_anything_that_is_not_a_fixed_code(value):
    with pytest.raises(DiagnosticExportError) as error:
        assert_privacy_safe(value)
    assert str(error.value) == "diagnostic_report_not_privacy_safe"


def test_the_final_scan_accepts_codes_versions_timestamps_and_numbers():
    assert_privacy_safe(
        {
            "code": "job.claimed",
            "version": "0.1.18",
            "time": "2026-10-01T10:00:00Z",
            "platform": "darwin-arm64",
            "number": 3,
            "flag": True,
            "none": None,
            "items": [1, 2, {"stage": "transcribing"}],
        }
    )


def test_a_value_that_fails_the_scan_blocks_the_whole_export(tmp_path, monkeypatch):
    config_path, data_dir = make_config(tmp_path)
    monkeypatch.setattr(diagnostic_export, "_platform_code", lambda: "has spaces and /paths")
    with pytest.raises(DiagnosticExportError):
        build_diagnostic_report(config_path)


def test_writing_refuses_to_overwrite_and_uses_owner_only_permissions(tmp_path):
    config_path, _ = make_config(tmp_path)
    output = tmp_path / "out" / "report.json"
    written = write_diagnostic_report(config_path, output)
    assert written == output
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert json.loads(output.read_text())["format"] == "meeting-wiki-diagnostics"
    with pytest.raises(DiagnosticExportError) as error:
        write_diagnostic_report(config_path, output)
    assert str(error.value) == "output_exists"


def test_a_blocked_export_writes_no_file(tmp_path, monkeypatch):
    config_path, _ = make_config(tmp_path)
    monkeypatch.setattr(diagnostic_export, "_platform_code", lambda: "bad value")
    output = tmp_path / "report.json"
    with pytest.raises(DiagnosticExportError):
        write_diagnostic_report(config_path, output)
    assert not output.exists()


def test_cli_prints_the_report_or_writes_a_file(tmp_path, capsys):
    config_path, data_dir = make_config(tmp_path)
    seed(data_dir)
    assert main(["--config", str(config_path), "diagnostics-export"]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["format"] == "meeting-wiki-diagnostics"

    output = tmp_path / "report.json"
    assert main(["--config", str(config_path), "diagnostics-export", "--output", str(output)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result == {"exported": True, "bytes": output.stat().st_size}
    assert str(output) not in json.dumps(result)

    assert main(["--config", str(config_path), "diagnostics-export", "--output", str(output)]) == 1
    assert json.loads(capsys.readouterr().out) == {"error": "output_exists"}


def test_cli_works_without_loading_the_config(tmp_path, capsys):
    config_path = tmp_path / "config.toml"
    config_path.write_text("this is = = not toml")
    assert main(["--config", str(config_path), "diagnostics-export"]) == 0
    assert json.loads(capsys.readouterr().out)["self_check"]["config"] == "invalid"


def test_generated_time_is_utc_and_every_value_is_a_scalar(tmp_path):
    config_path, _ = make_config(tmp_path)
    report = build_diagnostic_report(config_path)
    stamp = datetime.datetime.strptime(report["generated_at"], "%Y-%m-%dT%H:%M:%SZ")
    now = datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
    assert abs((now - stamp).total_seconds()) < 60
    assert all(isinstance(item, (str, int, float, bool, type(None))) for item in flatten(report))


IDENTIFIER_CANARIES = ("BoardMeetingQ3", "someuser", "AcmeAcquisition", "ProjectFalcon")


def raw_events_db(data_dir, rows):
    journal = EventJournal(data_dir / "events.db")
    journal.record(EventCode.JOB_CLAIMED, Component.QUEUE, job_id=1)
    with sqlite3.connect(data_dir / "events.db") as connection:
        for row in rows:
            connection.execute(
                """INSERT INTO events (ts, code, component, component_version, job_id, attempt,
                   stage_from, stage_to, outcome, http_status, error_type, ref)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                row,
            )
    return journal


def test_identifier_shaped_user_text_never_reaches_the_report(tmp_path):
    """Short single-word text passes any character-class scan, so each source must allowlist."""
    config_path, data_dir = make_config(tmp_path)
    text = config_path.read_text().replace(
        'live_language = "openai_compatible"',
        'live_language = "openai_compatible"\nstorage = "AcmeAcquisition"',
    )
    config_path.write_text(text)
    seed(data_dir, canary_error=False)
    raw_events_db(
        data_dir,
        [
            (
                1.0,
                "job.stage",
                "worker",
                "BoardMeetingQ3",
                2,
                1,
                "someuser",
                "AcmeAcquisition",
                "ProjectFalcon",
                500,
                "TimeoutError",
                "someuser1234",
            ),
            (
                2.0,
                "job.failed",
                "queue",
                "0.1.18",
                3,
                1,
                "queued",
                "analyzing",
                "dead",
                503,
                "TimeoutError",
                "0123456789ab",
            ),
        ],
    )
    with sqlite3.connect(data_dir / "jobs.db") as connection:
        connection.execute("UPDATE jobs SET stage='AcmeAcquisition', job_type='ProjectFalcon'")
    log = data_dir / "logs" / "live.log"
    log.parent.mkdir(parents=True)
    log.write_text(
        json.dumps(
            {
                "time": "2026-10-01T10:00:00+00:00",
                "event": "BoardMeetingQ3",
                "channel": "someuser",
                "error_type": "TimeoutError",
            }
        )
        + "\n"
        + json.dumps(
            {
                "time": "2026-10-01T10:01:00+00:00",
                "event": "live_chunk_failed",
                "channel": "someuser",
                "error_type": "TimeoutError",
            }
        )
        + "\n"
    )
    report = build_diagnostic_report(config_path)
    text = json.dumps(report)
    for canary in IDENTIFIER_CANARIES:
        assert canary not in text, canary
    assert report["self_check"]["providers"]["storage"] == "unknown"
    [failed] = report["jobs"]["failed"]
    assert failed["stage"] == "unknown" and failed["job_type"] == "unknown"
    assert failed["error_type"] == "legacy_unstructured"
    stage_event = next(event for event in report["events"] if event["code"] == "job.stage")
    assert stage_event["component_version"] == "unknown"
    assert {"stage_from", "stage_to", "outcome", "ref"}.isdisjoint(stage_event)
    assert stage_event["error_type"] == "TimeoutError"
    failed_event = next(event for event in report["events"] if event.get("job_id") == 3)
    assert failed_event["stage_to"] == "analyzing" and failed_event["outcome"] == "dead"
    assert failed_event["ref"] == "0123456789ab"
    assert report["live_log"] == [
        {
            "time": "2026-10-01T10:01:00+00:00",
            "event": "live_chunk_failed",
            "error_type": "TimeoutError",
        }
    ]


def block_network_and_directory_creation(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the export must stay offline")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)


def test_the_export_is_offline_and_creates_nothing_even_with_credentials_present(
    tmp_path, monkeypatch
):
    config_path, data_dir = make_config(tmp_path)
    monkeypatch.setenv("MEETING_WIKI_CANARY_KEY", CANARIES[3])
    block_network_and_directory_creation(monkeypatch)
    report = build_diagnostic_report(config_path)
    assert not data_dir.exists()
    assert report["sources"] == {"jobs": "missing", "events": "missing", "live_log": "missing"}
    assert report["self_check"]["capabilities"]["storage"] == "missing"


def test_an_existing_data_directory_gains_no_files(tmp_path, monkeypatch):
    config_path, data_dir = make_config(tmp_path)
    monkeypatch.setenv("MEETING_WIKI_CANARY_KEY", CANARIES[3])
    block_network_and_directory_creation(monkeypatch)
    data_dir.mkdir()
    build_diagnostic_report(config_path)
    assert list(data_dir.iterdir()) == []


def test_a_corrupt_database_is_reported_as_unreadable_not_as_empty(tmp_path):
    config_path, data_dir = make_config(tmp_path)
    data_dir.mkdir()
    (data_dir / "jobs.db").write_bytes(b"this is not a database " + CANARIES[0].encode())
    (data_dir / "events.db").write_bytes(b"neither is this")
    report = build_diagnostic_report(config_path)
    assert report["sources"]["jobs"] == "unreadable"
    assert report["sources"]["events"] == "unreadable"
    assert report["jobs"] is None
    assert CANARIES[0] not in json.dumps(report)


def test_an_invalid_config_marks_every_source_unavailable(tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.write_text("this is = = not toml")
    report = build_diagnostic_report(config_path)
    assert report["sources"] == {
        "jobs": "unavailable",
        "events": "unavailable",
        "live_log": "unavailable",
    }


@pytest.mark.parametrize(
    "value",
    [
        "AKIA" + "ABCDEFGHIJKLMNOP",
        "0123456789abcdef0123456789abcdef",
        "xoxb-1234567890-1234567890-abcdef",
        "sk_live_abc123",
        "ghp_abcdefgh12345678",
        "Bearer",
        "x-sk-abcdefghijk",
    ],
)
def test_the_final_scan_also_rejects_common_secret_shapes(value):
    with pytest.raises(DiagnosticExportError):
        assert_privacy_safe({"value": value})


def test_the_final_scan_does_not_reject_ordinary_codes_that_contain_sk_or_hex_letters():
    assert_privacy_safe(
        {"stage": "task_failed", "ref": "0123456789ab", "type": "AskError", "code": "job.dead"}
    )


def test_a_failed_write_leaves_no_partial_file(tmp_path, monkeypatch):
    config_path, _ = make_config(tmp_path)
    output = tmp_path / "report.json"

    def failing_fdopen(descriptor, *args, **kwargs):
        os.close(descriptor)
        raise OSError("disk full")

    monkeypatch.setattr(diagnostic_export.os, "fdopen", failing_fdopen)
    with pytest.raises(DiagnosticExportError) as error:
        write_diagnostic_report(config_path, output)
    assert str(error.value) == "output_io_error"
    assert not output.exists(), "a partial file would make every retry report output_exists"


def test_an_output_path_under_a_regular_file_is_an_io_error_not_an_existing_file(tmp_path):
    config_path, _ = make_config(tmp_path)
    blocker = tmp_path / "blocker"
    blocker.write_text("file")
    with pytest.raises(DiagnosticExportError) as error:
        write_diagnostic_report(config_path, blocker / "report.json")
    assert str(error.value) == "output_io_error"


def test_an_unexpected_failure_prints_a_fixed_error_and_no_traceback(tmp_path, capsys, monkeypatch):
    config_path, _ = make_config(tmp_path)

    def explode(*args, **kwargs):
        raise RuntimeError("/Users/someone/secret/path failed")

    monkeypatch.setattr(diagnostic_export, "build_diagnostic_report", explode)
    assert main(["--config", str(config_path), "diagnostics-export"]) == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"error": "internal_error"}
    assert "/Users/" not in captured.out + captured.err
