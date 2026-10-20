from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from meeting_wiki.config import AppConfig, PrivacyConfig
from meeting_wiki.models import MeetingType
from meeting_wiki.providers import gemini as gemini_module
from meeting_wiki.providers.base import (
    LiveLanguageProvider,
    LiveSessionTranscriptionProvider,
    LiveTranscriptEvent,
    LiveTranscriptionProvider,
    LiveTranscriptKind,
    LLMProvider,
    TranscriptionProvider,
)
from meeting_wiki.providers.gemini import (
    GeminiLanguageProvider,
    GeminiLiveLanguageProvider,
    GeminiLiveTranscriber,
    GeminiTranscriber,
)
from meeting_wiki.providers.registry import build_providers
from meeting_wiki.providers.transcription import MLXWhisperTranscriber, OpenAITranscriber

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


LIVE_MODEL = "test-gemini-live-model"
PCM_CHUNK = b"\x01\x00\x02\x00"


@dataclass(frozen=True)
class FakeBlob:
    data: bytes
    mime_type: str


def live_message(final=None, interim=None, server_content=True):
    if not server_content:
        return SimpleNamespace(server_content=None)
    return SimpleNamespace(
        server_content=SimpleNamespace(
            input_transcription=SimpleNamespace(text=final) if final is not None else None,
            interim_input_transcription=(
                SimpleNamespace(text=interim) if interim is not None else None
            ),
        )
    )


class FakeLiveSession:
    def __init__(self, turns=(), send_error=None, receive_error=None, close_error=None):
        self.turns = [list(turn) for turn in turns]
        self.send_error = send_error
        self.receive_error = receive_error
        self.close_error = close_error
        self.sent = []
        self.close_calls = 0

    async def send_realtime_input(self, **kwargs):
        if self.send_error:
            raise self.send_error
        self.sent.append(kwargs)

    async def receive(self):
        if self.receive_error:
            raise self.receive_error
        turn = self.turns.pop(0) if self.turns else []
        for message in turn:
            yield message

    async def close(self):
        self.close_calls += 1
        if self.close_error:
            raise self.close_error


class FakeLive:
    def __init__(self, session, connect_error=None):
        self.session = session
        self.connect_error = connect_error
        self.calls = []
        self.exited = 0

    @asynccontextmanager
    async def connect(self, *, model, config):
        self.calls.append({"model": model, "config": config})
        if self.connect_error:
            raise self.connect_error
        try:
            yield self.session
        finally:
            self.exited += 1


def fake_live_client(session=None, connect_error=None):
    live = FakeLive(session or FakeLiveSession(), connect_error)
    return SimpleNamespace(aio=SimpleNamespace(live=live))


@pytest.fixture
def fake_sdk_types(monkeypatch):
    monkeypatch.setattr(
        gemini_module, "_import_genai_types", lambda: SimpleNamespace(Blob=FakeBlob)
    )


def live_provider(client=None, api_key=TEST_KEY):
    factory = (lambda: client) if client is not None else forbid_client
    return GeminiLiveTranscriber(LIVE_MODEL, api_key, 30, client_factory=factory)


async def stream_all(provider, chunks, language=None):
    async with provider.open_session(language) as session:
        for chunk in chunks:
            await session.send_audio(chunk)
        await session.end_audio()
        return [event async for event in session.events()]


def test_live_transcriber_satisfies_session_protocol():
    provider = live_provider()

    assert isinstance(provider, LiveSessionTranscriptionProvider)
    assert not isinstance(provider, LiveTranscriptionProvider)


def test_live_session_sends_pcm_then_stream_end_and_closes(fake_sdk_types):
    sdk_session = FakeLiveSession(
        turns=[[live_message(interim="hel"), live_message(final="hello")]]
    )
    client = fake_live_client(sdk_session)

    events = asyncio.run(stream_all(live_provider(client), [PCM_CHUNK, PCM_CHUNK * 2], "en"))

    assert client.aio.live.calls == [
        {"model": LIVE_MODEL, "config": {"input_audio_transcription": {"language_codes": ["en"]}}}
    ]
    assert sdk_session.sent == [
        {"audio": FakeBlob(data=PCM_CHUNK, mime_type="audio/pcm;rate=16000")},
        {"audio": FakeBlob(data=PCM_CHUNK * 2, mime_type="audio/pcm;rate=16000")},
        {"audio_stream_end": True},
    ]
    assert events == [
        LiveTranscriptEvent(kind=LiveTranscriptKind.INTERIM, text="hel"),
        LiveTranscriptEvent(kind=LiveTranscriptKind.FINAL, text="hello"),
    ]
    assert sdk_session.close_calls == 1
    assert client.aio.live.exited == 1


def test_live_session_omits_language_hint_when_unset(fake_sdk_types):
    client = fake_live_client()

    asyncio.run(stream_all(live_provider(client), []))

    assert client.aio.live.calls[0]["config"] == {"input_audio_transcription": {}}


def test_live_events_classify_by_field_not_text_and_skip_noise(fake_sdk_types):
    turns = [
        [
            live_message(server_content=False),
            SimpleNamespace(server_content=SimpleNamespace(model_turn="ignored")),
            live_message(final="   "),
            live_message(interim="final-looking interim."),
            live_message(final="both", interim="bo"),
        ],
        [live_message(final="second turn")],
    ]
    sdk_session = FakeLiveSession(turns=turns)

    events = asyncio.run(stream_all(live_provider(fake_live_client(sdk_session)), []))

    assert events == [
        LiveTranscriptEvent(LiveTranscriptKind.INTERIM, "final-looking interim."),
        LiveTranscriptEvent(LiveTranscriptKind.INTERIM, "bo"),
        LiveTranscriptEvent(LiveTranscriptKind.FINAL, "both"),
        LiveTranscriptEvent(LiveTranscriptKind.FINAL, "second turn"),
    ]


@pytest.mark.parametrize(
    ("chunk", "error_type", "match"),
    [
        ("not bytes", TypeError, "bytes"),
        (bytearray(PCM_CHUNK), TypeError, "bytes"),
        (memoryview(PCM_CHUNK), TypeError, "bytes"),
        (b"", ValueError, "empty"),
        (b"\x01\x00\x02", ValueError, "16-bit"),
    ],
)
def test_live_session_rejects_invalid_pcm_without_sending(fake_sdk_types, chunk, error_type, match):
    sdk_session = FakeLiveSession()

    async def run():
        async with live_provider(fake_live_client(sdk_session)).open_session() as session:
            await session.send_audio(chunk)

    with pytest.raises(error_type, match=match):
        asyncio.run(run())
    assert sdk_session.sent == []
    assert sdk_session.close_calls == 1


def test_live_session_rejects_audio_after_stream_end_or_close(fake_sdk_types):
    sdk_session = FakeLiveSession()

    async def run():
        async with live_provider(fake_live_client(sdk_session)).open_session() as session:
            await session.end_audio()
            with pytest.raises(RuntimeError, match="ended"):
                await session.send_audio(PCM_CHUNK)
            with pytest.raises(RuntimeError, match="ended"):
                await session.end_audio()
            await session.close()
            await session.close()
            with pytest.raises(RuntimeError, match="closed"):
                await session.send_audio(PCM_CHUNK)
            assert [event async for event in session.events()] == []

    asyncio.run(run())
    assert sdk_session.sent == [{"audio_stream_end": True}]
    assert sdk_session.close_calls == 1


def test_live_session_closes_and_propagates_caller_error(fake_sdk_types):
    sdk_session = FakeLiveSession(close_error=OSError(f"close {TEST_KEY}"))
    client = fake_live_client(sdk_session)

    async def run():
        async with live_provider(client).open_session():
            raise KeyError("caller failure")

    with pytest.raises(KeyError, match="caller failure"):
        asyncio.run(run())
    assert sdk_session.close_calls == 1
    assert client.aio.live.exited == 1


LEAK = f"{TEST_KEY} /private/capture.pcm Alex: secret transcript"


@pytest.mark.parametrize(
    ("client_kwargs", "expected"),
    [
        ({"connect_error": ConnectionError(LEAK)}, "Gemini live connection failed"),
        (
            {"session": FakeLiveSession(send_error=ValueError(LEAK))},
            "Gemini live audio send failed",
        ),
        (
            {"session": FakeLiveSession(receive_error=ConnectionError(LEAK))},
            "Gemini live receive failed",
        ),
        (
            {"session": FakeLiveSession(close_error=OSError(LEAK))},
            "Gemini live close failed",
        ),
    ],
)
def test_live_errors_are_redacted(fake_sdk_types, client_kwargs, expected):
    provider = live_provider(fake_live_client(**client_kwargs))

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(stream_all(provider, [PCM_CHUNK]))

    message = str(raised.value)
    assert message.startswith(expected)
    for secret in (TEST_KEY, "capture.pcm", "secret transcript", "Alex"):
        assert secret not in message
    assert raised.value.__cause__ is None
    assert raised.value.__suppress_context__ is True


def test_live_transcriber_imports_sdk_lazily_and_reports_missing_extra(monkeypatch):
    def missing_sdk():
        raise ImportError("No module named 'google.genai'")

    monkeypatch.setattr(gemini_module, "_import_genai", missing_sdk)
    provider = GeminiLiveTranscriber(LIVE_MODEL, TEST_KEY, 30)

    with pytest.raises(RuntimeError, match=r"meeting-wiki\[gemini\]"):
        asyncio.run(stream_all(provider, []))
    assert provider.health() == (False, "install meeting-wiki[gemini]")


def test_live_default_client_uses_exact_api_key_and_timeout(fake_sdk_types, monkeypatch):
    constructed = []
    client = fake_live_client()

    def client_class(**kwargs):
        constructed.append(kwargs)
        return client

    monkeypatch.setattr(
        gemini_module, "_import_genai", lambda: SimpleNamespace(Client=client_class)
    )

    asyncio.run(stream_all(GeminiLiveTranscriber(LIVE_MODEL, TEST_KEY, 2.5), []))

    assert constructed == [{"api_key": TEST_KEY, "http_options": {"timeout": 2500}}]


def test_live_health_is_local_and_sends_nothing(monkeypatch):
    monkeypatch.setattr(gemini_module, "_import_genai", lambda: SimpleNamespace(Client=object))

    assert live_provider().health() == (True, f"Gemini SDK ready ({LIVE_MODEL})")
    assert live_provider(api_key="").health() == (False, "Gemini API key is not set")


def live_gemini_config(**providers):
    return AppConfig.model_validate(
        {
            "providers": providers,
            "live": {"allow_external_providers": True},
            "gemini": {"live_model": LIVE_MODEL},
        }
    )


def test_registry_builds_gemini_live_transcriber_with_configured_secret(monkeypatch):
    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", TEST_KEY)

    bundle = build_providers(live_gemini_config(live_transcription="gemini"))

    assert isinstance(bundle.live_transcription, GeminiLiveTranscriber)
    assert bundle.live_transcription.api_key == TEST_KEY
    assert bundle.live_transcription.model == LIVE_MODEL
    assert isinstance(bundle.transcription, MLXWhisperTranscriber)


def test_registry_reads_only_the_configured_gemini_key_env_for_live(monkeypatch):
    monkeypatch.delenv("MEETING_WIKI_GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "wrong-provider-key")
    monkeypatch.setenv("TEST_CUSTOM_GEMINI_KEY", TEST_KEY)
    config = live_gemini_config(live_transcription="gemini")

    with pytest.raises(RuntimeError, match="'MEETING_WIKI_GEMINI_API_KEY' is not set"):
        build_providers(config)

    custom = config.model_copy(
        update={
            "gemini": config.gemini.model_copy(update={"api_key_env": "TEST_CUSTOM_GEMINI_KEY"})
        }
    )
    assert build_providers(custom).live_transcription.api_key == TEST_KEY


def test_live_payloads_validate_against_installed_sdk_types():
    sdk_types = pytest.importorskip("google.genai.types")
    sdk_session = FakeLiveSession()
    client = fake_live_client(sdk_session)

    asyncio.run(stream_all(live_provider(client), [PCM_CHUNK], "en"))

    config = sdk_types.LiveConnectConfig(**client.aio.live.calls[0]["config"])
    assert config.input_audio_transcription.language_codes == ["en"]
    blob = sdk_session.sent[0]["audio"]
    assert isinstance(blob, sdk_types.Blob)
    assert (blob.data, blob.mime_type) == (PCM_CHUNK, "audio/pcm;rate=16000")
    message = sdk_types.LiveServerMessage(
        server_content=sdk_types.LiveServerContent(
            interim_input_transcription=sdk_types.Transcription(text="hel"),
            input_transcription=sdk_types.Transcription(text="hello"),
        )
    )
    assert gemini_module._transcript_events(message) == [
        LiveTranscriptEvent(LiveTranscriptKind.INTERIM, "hel"),
        LiveTranscriptEvent(LiveTranscriptKind.FINAL, "hello"),
    ]


def live_language_provider(client=None, api_key=TEST_KEY):
    factory = (lambda: client) if client is not None else forbid_client
    return GeminiLiveLanguageProvider(LANGUAGE_MODEL, api_key, 600, client_factory=factory)


def test_live_language_provider_satisfies_protocol():
    assert isinstance(live_language_provider(), LiveLanguageProvider)


def test_live_language_translate_requests_plain_text():
    models = FakeModels("  你好，团队  ")
    provider = live_language_provider(fake_client(models=models))

    assert provider.translate("Hello team", "zh") == "你好，团队"

    call = models.calls[0]
    assert call["model"] == LANGUAGE_MODEL
    assert call["contents"] == "Hello team"
    assert call["config"]["response_mime_type"] == "text/plain"
    assert call["config"]["temperature"] == 0
    assert "Chinese" in call["config"]["system_instruction"]
    assert "plain text" in call["config"]["system_instruction"]


def test_live_language_summarize_requests_concise_bullets():
    models = FakeModels("- Chose option B\n\n* Ship Friday\n  - Alex owns docs  \n")
    provider = live_language_provider(fake_client(models=models))

    assert provider.summarize("Alex: we chose option B") == [
        "Chose option B",
        "Ship Friday",
        "Alex owns docs",
    ]

    call = models.calls[0]
    assert call["contents"] == "Alex: we chose option B"
    assert call["config"]["response_mime_type"] == "text/plain"
    assert "concise bullet points" in call["config"]["system_instruction"]


@pytest.mark.parametrize("text", [None, ""])
def test_live_language_handles_empty_model_output(text):
    provider = live_language_provider(fake_client(models=FakeModels(text)))

    assert provider.translate("Hello", "fr") == ""
    assert provider.summarize("Hello") == []


@pytest.mark.parametrize("blank", ["", "   \n\t"])
def test_live_language_empty_input_never_constructs_client(blank):
    provider = live_language_provider()

    assert provider.translate(blank, "zh") == ""
    assert provider.summarize(blank) == []


@pytest.mark.parametrize(
    ("call", "expected"),
    [
        (lambda provider: provider.translate("Alex: secret plan", "zh"), "translation"),
        (lambda provider: provider.summarize("Alex: secret plan"), "summary"),
    ],
)
def test_live_language_errors_are_redacted(call, expected):
    error = ConnectionError(f"leaked {TEST_KEY} Alex: secret plan")
    provider = live_language_provider(fake_client(models=FakeModels("", error=error)))

    with pytest.raises(RuntimeError) as raised:
        call(provider)

    assert str(raised.value) == f"Gemini live {expected} failed (ConnectionError)"
    assert TEST_KEY not in str(raised.value)
    assert raised.value.__cause__ is None


def test_live_language_health_is_local_and_sends_nothing(monkeypatch):
    monkeypatch.setattr(gemini_module, "_import_genai", lambda: SimpleNamespace(Client=object))

    assert live_language_provider().health() == (True, f"Gemini SDK ready ({LANGUAGE_MODEL})")
    assert live_language_provider(api_key="").health() == (False, "Gemini API key is not set")


def test_live_language_health_reports_missing_extra(monkeypatch):
    def missing():
        raise ImportError("google.genai")

    monkeypatch.setattr(gemini_module, "_import_genai", missing)

    assert live_language_provider().health() == (False, "install meeting-wiki[gemini]")


def live_language_config(**gemini):
    return AppConfig.model_validate(
        {
            "providers": {"live_language": "gemini"},
            "live": {"allow_external_providers": True},
            "gemini": {"language_model": LANGUAGE_MODEL, **gemini},
        }
    )


def test_registry_builds_gemini_live_language_with_configured_secret(monkeypatch):
    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", TEST_KEY)

    bundle = build_providers(live_language_config())

    assert isinstance(bundle.live_language, GeminiLiveLanguageProvider)
    assert bundle.live_language.api_key == TEST_KEY
    assert bundle.live_language.model == LANGUAGE_MODEL


def test_registry_reads_only_the_configured_gemini_key_env_for_live_language(monkeypatch):
    monkeypatch.delenv("MEETING_WIKI_GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "wrong-provider-key")
    monkeypatch.setenv("TEST_CUSTOM_GEMINI_KEY", TEST_KEY)

    with pytest.raises(RuntimeError, match="'MEETING_WIKI_GEMINI_API_KEY' is not set"):
        build_providers(live_language_config())

    custom = build_providers(live_language_config(api_key_env="TEST_CUSTOM_GEMINI_KEY"))
    assert custom.live_language.api_key == TEST_KEY


def test_doctor_checks_gemini_batch_and_llm_without_printing_the_key(tmp_path, monkeypatch, capsys):
    from meeting_wiki.cli import doctor

    config_path = tmp_path / "config.toml"
    config_path.write_text(
        "\n".join(
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
                f'batch_audio_model = "{BATCH_MODEL}"',
                'live_model = "test-gemini-live-model"',
                f'language_model = "{LANGUAGE_MODEL}"',
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MEETING_WIKI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", TEST_KEY)
    monkeypatch.delenv("MEETING_WIKI_ONLINE_API_KEY", raising=False)
    monkeypatch.setattr(gemini_module, "_import_genai", lambda: SimpleNamespace())

    assert doctor(config_path) == 0

    output = capsys.readouterr().out
    assert f"OK transcription: Gemini SDK ready ({BATCH_MODEL})" in output
    assert f"OK llm: Gemini SDK ready ({LANGUAGE_MODEL})" in output
    assert TEST_KEY not in output


def test_language_provider_supplies_strict_meeting_analysis_schema(meeting, transcript):
    models = FakeModels(json.dumps(analysis_payload()))
    client = fake_client(models=models)
    provider = GeminiLanguageProvider(
        LANGUAGE_MODEL, TEST_KEY, 600, PrivacyConfig(), client_factory=lambda: client
    )

    provider.analyze(meeting, transcript)

    schema = models.calls[0]["config"]["response_schema"]
    assert schema["required"] == list(schema["properties"])
    assert schema["additionalProperties"] is False
    assert schema["properties"]["summary"]["type"] == "array"
