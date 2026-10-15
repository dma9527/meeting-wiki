from __future__ import annotations

from pathlib import Path

import pytest

from meeting_wiki.config import AppConfig, load_config
from meeting_wiki.models import MeetingInput, MeetingType
from meeting_wiki.privacy import classify


@pytest.mark.parametrize(
    "title,attendees,private,expected",
    [
        ("Alex / Sam 1:1", ["Alex", "Sam"], False, MeetingType.ONE_ON_ONE),
        ("Career check-in", ["Alex", "Sam"], False, MeetingType.ONE_ON_ONE),
        ("Career check-in", [], False, MeetingType.ONE_ON_ONE),
        ("Manager sync", [], False, MeetingType.ONE_ON_ONE),
        ("Manager sync", ["Alex", "Sam", "Lee"], False, MeetingType.GENERIC),
        ("Daily standup", ["A", "B", "C"], False, MeetingType.STANDUP),
        ("Architecture review", ["A", "B"], False, MeetingType.DESIGN_REVIEW),
        ("Customer discovery", ["A", "B"], False, MeetingType.CUSTOMER),
        ("Anything", [], True, MeetingType.ONE_ON_ONE),
    ],
)
def test_classify(title, attendees, private, expected):
    config = AppConfig()
    meeting = MeetingInput(title=title, attendees=attendees, private=private)
    assert classify(meeting, config.privacy) is expected


def test_config_env_precedence_and_permissions(tmp_path, monkeypatch):
    path = tmp_path / "config.toml"
    path.write_text('user_name="File User"\ndata_dir="/tmp/file-dir"\n')
    monkeypatch.setenv("MEETING_WIKI_USER", "Env User")
    monkeypatch.setenv("MEETING_WIKI_DATA_DIR", str(tmp_path / "env-dir"))
    config = load_config(path)
    assert config.user_name == "Env User"
    assert config.data_dir == (tmp_path / "env-dir").resolve()


def test_secret_is_loaded_only_from_named_environment(monkeypatch):
    config = AppConfig()
    monkeypatch.delenv("TEST_MEETING_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="TEST_MEETING_SECRET"):
        config.secret("TEST_MEETING_SECRET")
    monkeypatch.setenv("TEST_MEETING_SECRET", "value")
    assert config.secret("TEST_MEETING_SECRET") == "value"
    assert config.secret("") == ""


def test_shipped_example_config_validates():
    root = Path(__file__).parents[1]
    example = root / "config.example.toml"
    packaged = root / "meeting_wiki" / "default_config.toml"
    assert example.read_text() == packaged.read_text()
    config = load_config(example)
    assert config.providers.transcription == "mlx_whisper"
    assert config.providers.llm == "ollama"
    assert config.ollama.model


def test_live_defaults_use_local_models_and_chinese_translation():
    config = AppConfig()

    assert config.providers.live_transcription == "chunked_mlx_whisper"
    assert config.providers.live_language == "ollama"
    assert config.live.translation_target_language == "zh"
    assert config.live.allow_external_providers is False


def test_live_external_provider_requires_explicit_opt_in():
    with pytest.raises(ValueError, match="allow_external_providers"):
        AppConfig.model_validate(
            {
                "providers": {
                    "live_transcription": "openai_compatible",
                    "live_language": "openai_compatible",
                },
                "openai_compatible": {
                    "base_url": "https://models.example.test/v1",
                    "model": "test-model",
                    "api_key_env": "TEST_API_KEY",
                },
            }
        )

    config = AppConfig.model_validate(
        {
            "providers": {
                "live_transcription": "openai_compatible",
                "live_language": "openai_compatible",
            },
            "live": {"allow_external_providers": True},
            "openai_compatible": {
                "base_url": "https://models.example.test/v1",
                "model": "test-model",
                "api_key_env": "TEST_API_KEY",
            },
        }
    )
    assert config.live.allow_external_providers is True
