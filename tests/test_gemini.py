from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from meeting_wiki.config import AppConfig, PrivacyConfig
from meeting_wiki.models import MeetingType
from meeting_wiki.providers import gemini as gemini_module
from meeting_wiki.providers.base import LLMProvider, TranscriptionProvider
from meeting_wiki.providers.gemini import GeminiLanguageProvider, GeminiTranscriber
from meeting_wiki.providers.registry import build_providers
from meeting_wiki.providers.transcription import OpenAITranscriber

TEST_KEY = "test-gemini-key-not-real"
BATCH_MODEL = "test-gemini-batch-model"
LANGUAGE_MODEL = "test-gemini-language-model"


class FakeFiles:
    def __init__(self, uploaded=None, error=None):
        self.uploaded = uploaded or SimpleNamespace(
            uri="https://example.invalid/files/test-audio", mime_type="audio/wav"
        )
        self.error = error
        self.calls = []

    def upload(self, *, file):
        self.calls.append(file)
        if self.error:
            raise self.error
        return self.uploaded


class FakeInteractions:
    def __init__(self, output_text="Alex: hello there", error=None):
        self.output_text = output_text
        self.error = error
        self.calls = []

    def create(self, *, model, input, generation_config):
        self.calls.append({"model": model, "input": input, "generation_config": generation_config})
        if self.error:
            raise self.error
        return SimpleNamespace(output_text=self.output_text)


class FakeModels:
    def __init__(self, text, error=None):
        self.text = text
        self.error = error
        self.calls = []

    def generate_content(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        if self.error:
            raise self.error
        return SimpleNamespace(text=self.text)


def fake_client(files=None, interactions=None, models=None):
    return SimpleNamespace(
        files=files or FakeFiles(),
        interactions=interactions or FakeInteractions(),
        models=models or FakeModels("{}"),
    )


def forbid_client():
    raise AssertionError("client must not be constructed")


def analysis_payload():
    return {
        "title": "Review",
        "meeting_type": "generic",
        "summary": ["Selected option B."],
        "participants": [],
        "blockers": [],
        "decisions": [],
        "action_items": [],
        "topics": [],
        "open_questions": [],
        "risks": [],
        "private": False,
    }


def gemini_config(**providers):
    return AppConfig.model_validate(
        {
            "providers": providers,
            "gemini": {"batch_audio_model": BATCH_MODEL, "language_model": LANGUAGE_MODEL},
        }
    )


def test_transcriber_uploads_audio_and_requests_batch_model(tmp_path):
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"RIFF")
    client = fake_client()
    provider = GeminiTranscriber(BATCH_MODEL, TEST_KEY, 600, client_factory=lambda: client)

    result = provider.transcribe(audio, "en")

    assert isinstance(provider, TranscriptionProvider)
    assert client.files.calls == [str(audio)]
    assert client.interactions.calls == [
        {
            "model": BATCH_MODEL,
            "input": [
                {
                    "type": "audio",
                    "uri": "https://example.invalid/files/test-audio",
                    "mime_type": "audio/wav",
                }
            ],
            "generation_config": {"transcription_config": {"language_codes": ["en"]}},
        }
    ]
    assert result.text == "Alex: hello there"
    assert [segment.text for segment in result.segments] == ["Alex: hello there"]
    assert result.provider == "gemini"
    assert result.model == BATCH_MODEL
    assert result.language == "en"
    assert result.diarized is False


def test_transcriber_omits_language_hint_and_guesses_missing_mime(tmp_path):
    audio = tmp_path / "meeting.mp3"
    audio.write_bytes(b"ID3")
    files = FakeFiles(uploaded=SimpleNamespace(uri="https://example.invalid/f", mime_type=None))
    client = fake_client(files=files)
    provider = GeminiTranscriber(BATCH_MODEL, TEST_KEY, 600, client_factory=lambda: client)

    result = provider.transcribe(audio)

    call = client.interactions.calls[0]
    assert call["generation_config"] == {}
    assert call["input"][0]["mime_type"] == "audio/mpeg"
    assert result.language is None


@pytest.mark.parametrize("output_text", ["", "   \n", None])
def test_transcriber_fails_on_empty_output(tmp_path, output_text):
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"RIFF")
    client = fake_client(interactions=FakeInteractions(output_text=output_text))
    provider = GeminiTranscriber(BATCH_MODEL, TEST_KEY, 600, client_factory=lambda: client)

    with pytest.raises(RuntimeError, match="empty transcript"):
        provider.transcribe(audio)


@pytest.mark.parametrize(
    ("files", "interactions"),
    [
        (FakeFiles(error=ValueError(f"upload failed {TEST_KEY} /private/meeting.wav")), None),
        (None, FakeInteractions(error=ConnectionError(f"secret transcript {TEST_KEY}"))),
    ],
)
def test_transcriber_surfaces_generic_runtime_error_without_details(tmp_path, files, interactions):
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"RIFF")
    client = fake_client(files=files, interactions=interactions)
    provider = GeminiTranscriber(BATCH_MODEL, TEST_KEY, 600, client_factory=lambda: client)

    with pytest.raises(RuntimeError) as raised:
        provider.transcribe(audio)

    message = str(raised.value)
    assert message.startswith("Gemini transcription request failed")
    assert TEST_KEY not in message
    assert "meeting.wav" not in message
    assert "secret transcript" not in message
    assert raised.value.__cause__ is None


def test_transcriber_imports_sdk_lazily_and_reports_missing_extra(tmp_path, monkeypatch):
    def missing_sdk():
        raise ImportError("No module named 'google.genai'")

    monkeypatch.setattr(gemini_module, "_import_genai", missing_sdk)
    provider = GeminiTranscriber(BATCH_MODEL, TEST_KEY, 600)
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"RIFF")

    with pytest.raises(RuntimeError, match=r"meeting-wiki\[gemini\]"):
        provider.transcribe(audio)
    assert provider.health() == (False, "install meeting-wiki[gemini]")


def test_default_client_uses_exact_api_key_and_timeout(tmp_path, monkeypatch):
    constructed = []
    client = fake_client()

    def client_class(**kwargs):
        constructed.append(kwargs)
        return client

    monkeypatch.setattr(
        gemini_module, "_import_genai", lambda: SimpleNamespace(Client=client_class)
    )
    provider = GeminiTranscriber(BATCH_MODEL, TEST_KEY, 12.5)
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"RIFF")

    provider.transcribe(audio)

    assert constructed == [{"api_key": TEST_KEY, "http_options": {"timeout": 12500}}]


def test_transcriber_health_never_sends_audio(monkeypatch):
    monkeypatch.setattr(gemini_module, "_import_genai", lambda: SimpleNamespace(Client=object))
    provider = GeminiTranscriber(BATCH_MODEL, TEST_KEY, 600, client_factory=forbid_client)

    assert provider.health() == (True, f"Gemini SDK ready ({BATCH_MODEL})")
    assert GeminiTranscriber(BATCH_MODEL, "", 600, client_factory=forbid_client).health() == (
        False,
        "Gemini API key is not set",
    )


def test_language_provider_requests_json_analysis(meeting, transcript):
    models = FakeModels(json.dumps(analysis_payload()))
    client = fake_client(models=models)
    provider = GeminiLanguageProvider(
        LANGUAGE_MODEL, TEST_KEY, 600, PrivacyConfig(), client_factory=lambda: client
    )

    result = provider.analyze(meeting, transcript)

    assert isinstance(provider, LLMProvider)
    call = models.calls[0]
    assert call["model"] == LANGUAGE_MODEL
    assert "We chose option B" in call["contents"]
    assert call["config"]["response_mime_type"] == "application/json"
    assert call["config"]["temperature"] == 0
    assert call["config"]["system_instruction"]
    assert result.meeting_type is MeetingType.DESIGN_REVIEW
    assert result.summary == ["Selected option B."]


@pytest.mark.parametrize("text", ["not json", "", None])
def test_language_provider_rejects_non_json(meeting, transcript, text):
    client = fake_client(models=FakeModels(text))
    provider = GeminiLanguageProvider(
        LANGUAGE_MODEL, TEST_KEY, 600, PrivacyConfig(), client_factory=lambda: client
    )

    with pytest.raises(RuntimeError, match="non-JSON analysis"):
        provider.analyze(meeting, transcript)


def test_language_provider_surfaces_generic_runtime_error(meeting, transcript):
    error = ConnectionError(f"leaked {TEST_KEY} Alex: We chose option B")
    client = fake_client(models=FakeModels("{}", error=error))
    provider = GeminiLanguageProvider(
        LANGUAGE_MODEL, TEST_KEY, 600, PrivacyConfig(), client_factory=lambda: client
    )

    with pytest.raises(RuntimeError) as raised:
        provider.analyze(meeting, transcript)

    assert str(raised.value) == "Gemini analysis request failed (ConnectionError)"
    assert raised.value.__cause__ is None


def test_language_provider_health_never_calls_model(monkeypatch):
    monkeypatch.setattr(gemini_module, "_import_genai", lambda: SimpleNamespace(Client=object))
    provider = GeminiLanguageProvider(
        LANGUAGE_MODEL, TEST_KEY, 600, PrivacyConfig(), client_factory=forbid_client
    )

    assert provider.health() == (True, f"Gemini SDK ready ({LANGUAGE_MODEL})")


def test_registry_builds_native_gemini_transcriber_with_configured_secret(monkeypatch):
    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", TEST_KEY)

    bundle = build_providers(gemini_config(transcription="gemini"))

    assert isinstance(bundle.transcription, GeminiTranscriber)
    assert not isinstance(bundle.transcription, OpenAITranscriber)
    assert bundle.transcription.api_key == TEST_KEY
    assert bundle.transcription.model == BATCH_MODEL


def test_registry_builds_gemini_language_provider_with_configured_secret(monkeypatch):
    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", TEST_KEY)

    bundle = build_providers(gemini_config(llm="gemini"))

    assert isinstance(bundle.llm, GeminiLanguageProvider)
    assert bundle.llm.api_key == TEST_KEY
    assert bundle.llm.model == LANGUAGE_MODEL


def test_registry_reads_only_the_configured_gemini_key_env(monkeypatch):
    monkeypatch.delenv("MEETING_WIKI_GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "wrong-provider-key")
    monkeypatch.setenv("TEST_CUSTOM_GEMINI_KEY", TEST_KEY)
    config = gemini_config(transcription="gemini")

    with pytest.raises(RuntimeError, match="'MEETING_WIKI_GEMINI_API_KEY' is not set"):
        build_providers(config)

    custom = config.model_copy(
        update={
            "gemini": config.gemini.model_copy(update={"api_key_env": "TEST_CUSTOM_GEMINI_KEY"})
        }
    )
    assert build_providers(custom).transcription.api_key == TEST_KEY
