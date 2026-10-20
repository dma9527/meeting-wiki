from __future__ import annotations

import json
from types import SimpleNamespace

from meeting_wiki.cli import main
from meeting_wiki.memory import MemoryStore
from meeting_wiki.providers import gemini as gemini_module
from meeting_wiki.providers.llm import OpenAICompatibleProvider
from meeting_wiki.providers.transcription import OpenAITranscriber
from meeting_wiki.self_check import CAPABILITIES, run_self_check

TEST_KEY = "test-self-check-key-not-real"

GEMINI_CONFIG = "\n".join(
    [
        "[providers]",
        'transcription = "gemini"',
        'llm = "gemini"',
        'live_transcription = "gemini"',
        'live_language = "gemini"',
        "[live]",
        "allow_external_providers = true",
        "[gemini]",
        'api_key_env = "MEETING_WIKI_GEMINI_API_KEY"',
        'batch_audio_model = "test-gemini-batch-model"',
        'live_model = "test-gemini-live-model"',
        'language_model = "test-gemini-language-model"',
    ]
)

OPENAI_CONFIG = "\n".join(
    [
        "[providers]",
        'transcription = "openai_compatible"',
        'llm = "openai_compatible"',
        'live_transcription = "openai_compatible"',
        'live_language = "openai_compatible"',
        "[live]",
        "allow_external_providers = true",
        "[openai_compatible]",
        'base_url = "https://provider.example.test/v1"',
        'model = "test-language"',
        'api_key_env = "MEETING_WIKI_ONLINE_API_KEY"',
        "[openai_transcription]",
        'base_url = "https://provider.example.test/v1"',
        'model = "test-transcribe"',
        'api_key_env = "MEETING_WIKI_ONLINE_API_KEY"',
    ]
)


def write_config(tmp_path, text):
    path = tmp_path / "config.toml"
    path.write_text(text, encoding="utf-8")
    return path


def use_data_dir(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setenv("MEETING_WIKI_DATA_DIR", str(data_dir))
    return data_dir


def test_gemini_report_is_ready_and_carries_only_codes(tmp_path, monkeypatch):
    data_dir = use_data_dir(tmp_path, monkeypatch)
    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", TEST_KEY)
    monkeypatch.setattr(gemini_module, "_import_genai", lambda: SimpleNamespace())

    report = run_self_check(write_config(tmp_path, GEMINI_CONFIG))

    assert report["config"] == "ok"
    assert report["capabilities"] == {
        "transcription": "ready",
        "analysis": "ready",
        "live": "ready",
        "storage": "ready",
        "memory": "missing",
    }
    assert report["live_scope"] == "external"
    assert report["providers"]["transcription"] == "gemini"
    text = json.dumps(report)
    assert TEST_KEY not in text
    assert str(data_dir) not in text
    assert "test-gemini" not in text
    assert not (data_dir / "memory.db").exists(), "the probe must not create memory.db"


def test_missing_key_reports_credentials_missing(tmp_path, monkeypatch):
    use_data_dir(tmp_path, monkeypatch)
    monkeypatch.delenv("MEETING_WIKI_GEMINI_API_KEY", raising=False)
    report = run_self_check(write_config(tmp_path, GEMINI_CONFIG))
    for name in ("transcription", "analysis", "live"):
        assert report["capabilities"][name] == "credentials_missing"


def test_invalid_config_reports_invalid_without_detail(tmp_path, monkeypatch):
    use_data_dir(tmp_path, monkeypatch)
    report = run_self_check(write_config(tmp_path, "[providers]\nunknown_key = 1\n"))
    assert report == {
        "version": 1,
        "config": "invalid",
        "capabilities": dict.fromkeys(CAPABILITIES, "not_checked"),
    }


def test_openai_live_has_no_adapter_and_failed_health_hides_its_text(tmp_path, monkeypatch):
    use_data_dir(tmp_path, monkeypatch)
    monkeypatch.setenv("MEETING_WIKI_ONLINE_API_KEY", TEST_KEY)
    monkeypatch.setattr(OpenAITranscriber, "health", lambda self: (True, "ok"))

    def broken(self):
        raise RuntimeError(f"endpoint said {TEST_KEY} /private/path")

    monkeypatch.setattr(OpenAICompatibleProvider, "health", broken)
    report = run_self_check(write_config(tmp_path, OPENAI_CONFIG))
    assert report["capabilities"]["transcription"] == "ready"
    assert report["capabilities"]["analysis"] == "failed"
    assert report["capabilities"]["live"] == "no_adapter"
    assert TEST_KEY not in json.dumps(report)
    assert "/private/path" not in json.dumps(report)


def test_memory_probe_reports_empty_ready_and_failed(tmp_path, monkeypatch):
    data_dir = use_data_dir(tmp_path, monkeypatch)
    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", TEST_KEY)
    config_path = write_config(tmp_path, GEMINI_CONFIG)

    store = MemoryStore(data_dir / "memory.db")
    assert run_self_check(config_path)["capabilities"]["memory"] == "empty"
    with store._connect() as connection:
        connection.execute(
            "INSERT INTO memory_nodes (node_id, node_type, label, content, source_id,"
            " occurred_at, privacy, metadata) VALUES ('topic:test', 'topic', 'Test', 'Test',"
            " 'source:test', '2026-01-01', 'shared', '{}')"
        )
    assert run_self_check(config_path)["capabilities"]["memory"] == "ready"

    (data_dir / "memory.db").unlink()
    (data_dir / "memory.db").write_bytes(b"not a database")
    assert run_self_check(config_path)["capabilities"]["memory"] == "failed"


def test_memory_probe_fails_on_corrupt_file_with_stale_wal(tmp_path, monkeypatch):
    data_dir = use_data_dir(tmp_path, monkeypatch)
    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", TEST_KEY)
    config_path = write_config(tmp_path, GEMINI_CONFIG)
    store = MemoryStore(data_dir / "memory.db")
    held = store._connect()
    held.execute(
        "INSERT INTO memory_nodes (node_id, node_type, label, content, source_id,"
        " occurred_at, privacy, metadata) VALUES ('topic:test', 'topic', 'Test', 'Test',"
        " 'source:test', '2026-01-01', 'shared', '{}')"
    )
    try:
        assert (data_dir / "memory.db-wal").exists()
        (data_dir / "memory.db").write_bytes(b"not a database")
        assert run_self_check(config_path)["capabilities"]["memory"] == "failed"
    finally:
        held.close()

def test_cli_prints_json_and_exit_code_reflects_readiness(tmp_path, monkeypatch, capsys):
    use_data_dir(tmp_path, monkeypatch)
    monkeypatch.delenv("MEETING_WIKI_GEMINI_API_KEY", raising=False)
    config_path = write_config(tmp_path, GEMINI_CONFIG)
    assert main(["--config", str(config_path), "self-check"]) == 1
    report = json.loads(capsys.readouterr().out)
    assert report["capabilities"]["transcription"] == "credentials_missing"

    invalid = write_config(tmp_path, "not = [valid")
    assert main(["--config", str(invalid), "self-check"]) == 1
    assert json.loads(capsys.readouterr().out)["config"] == "invalid"
