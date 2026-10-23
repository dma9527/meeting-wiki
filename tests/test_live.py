from __future__ import annotations

import pytest

from meeting_wiki.models import TranscriptSegment


def test_deduplicate_segments_keeps_ordered_new_final_text():
    from meeting_wiki.live import deduplicate_segments

    existing = [TranscriptSegment(start_seconds=0, end_seconds=1, text="Hello world")]
    incoming = [
        TranscriptSegment(start_seconds=0, end_seconds=1, text=" hello   world "),
        TranscriptSegment(start_seconds=1, end_seconds=2, text="Next point"),
    ]

    assert deduplicate_segments(existing, incoming) == [incoming[1]]


def test_session_rejects_missing_or_invalid_token():
    from meeting_wiki.live import validate_session_message

    with pytest.raises(PermissionError):
        validate_session_message({"type": "ready"}, "test-token")
    with pytest.raises(PermissionError):
        validate_session_message({"type": "ready", "token": "wrong"}, "test-token")
    valid_message = {"type": "ready", "token": "test-token"}
    assert validate_session_message(valid_message, "test-token") == "ready"


def test_loopback_bridge_uses_an_ephemeral_local_port():
    import asyncio

    from meeting_wiki.live import LoopbackBridge

    async def run() -> int:
        bridge = LoopbackBridge("test-token")
        port = await bridge.start()
        await bridge.close()
        return port

    assert asyncio.run(run()) > 0


def test_ollama_live_language_provider_uses_chinese_target(monkeypatch):
    from meeting_wiki.providers.live import OllamaLiveLanguageProvider

    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"message": {"content": "中文翻译"}}

    def fake_post(url, json, timeout):
        captured.update({"url": url, "json": json, "timeout": timeout})
        return Response()

    monkeypatch.setattr("meeting_wiki.providers.live.httpx.post", fake_post)
    provider = OllamaLiveLanguageProvider("http://127.0.0.1:11434", "qwen3:8b", 30)
    assert provider.translate("Hello", "zh-CN") == "中文翻译"
    assert "Simplified Chinese" in captured["json"]["messages"][0]["content"]
    provider.translate("Hello", "ja")
    assert "into ja" in captured["json"]["messages"][0]["content"]


# ---- Growing WAV tail ----

TEST_TOKEN = "test-live-token-" + "0" * 32


def _wav_header() -> bytes:
    import io
    import wave

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
    return buffer.getvalue()


def _pcm(seconds: float, value: int = 1) -> bytes:
    return value.to_bytes(2, "little", signed=True) * int(seconds * 16_000)


def test_wav_tail_reads_only_new_whole_frames_from_a_growing_file(tmp_path):
    from meeting_wiki.live import WavTail

    path = tmp_path / "mic.wav"
    tail = WavTail(path)
    assert tail.read_new() == b""
    assert tail.seen is False
    path.write_bytes(_wav_header()[:20])
    assert tail.read_new() == b""
    path.write_bytes(_wav_header() + b"\x01\x00\x02")
    assert tail.read_new() == b"\x01\x00"
    with path.open("ab") as handle:
        handle.write(b"\x00\x03\x00")
    assert tail.read_new() == b"\x02\x00\x03\x00"
    assert tail.read_new() == b""
    path.unlink()
    with pytest.raises(FileNotFoundError):
        tail.read_new()


def test_wav_tail_rejects_unsupported_audio(tmp_path):
    import io
    import wave

    from meeting_wiki.live import LiveAudioError, WavTail

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44_100)
    path = tmp_path / "stereo.wav"
    path.write_bytes(buffer.getvalue())
    with pytest.raises(LiveAudioError):
        WavTail(path).read_new()
    (tmp_path / "text.wav").write_bytes(b"not a wav file at all")
    with pytest.raises(LiveAudioError):
        WavTail(tmp_path / "text.wav").read_new()


# ---- Loopback bridge ----


async def _client_result(port: int, message: object) -> tuple[bool, int | None]:
    import json

    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed

    async with connect(f"ws://127.0.0.1:{port}") as client:
        try:
            await client.send(json.dumps(message))
            await asyncio_wait(client.recv(), 0.3)
        except ConnectionClosed:
            return False, client.close_code
        except TimeoutError:
            return True, None
    return True, None


async def asyncio_wait(awaitable, timeout):
    import asyncio

    return await asyncio.wait_for(awaitable, timeout)


def test_loopback_bridge_accepts_exactly_one_authenticated_client():
    import asyncio
    import json

    from websockets.asyncio.client import connect

    from meeting_wiki.live import LoopbackBridge

    async def run():
        bridge = LoopbackBridge(TEST_TOKEN)
        port = await bridge.start()
        try:
            assert await bridge.publish("state", {"phase": "listening"}) is False
            assert await _client_result(port, {"type": "authenticate", "token": "wrong"}) == (
                False,
                1008,
            )
            assert await _client_result(port, ["authenticate", TEST_TOKEN]) == (False, 1008)
            assert await _client_result(port, {"type": "ready", "token": TEST_TOKEN}) == (
                False,
                1008,
            )
            first = await connect(f"ws://127.0.0.1:{port}")
            await first.send(json.dumps({"type": "authenticate", "token": TEST_TOKEN}))
            await asyncio.wait_for(bridge.client_connected.wait(), 2)
            second = await _client_result(port, {"type": "authenticate", "token": TEST_TOKEN})
            assert second == (False, 1008)
            assert await bridge.publish("state", {"phase": "listening"}) is True
            received = json.loads(await asyncio.wait_for(first.recv(), 2))
            assert received == {"type": "state", "payload": {"phase": "listening"}}
            await first.close()
            await asyncio.wait_for(bridge.client_closed.wait(), 2)
            again = await _client_result(port, {"type": "authenticate", "token": TEST_TOKEN})
            assert again == (False, 1008)
            assert await bridge.publish("state", {"phase": "stopped"}) is False
        finally:
            await bridge.close()

    asyncio.run(run())


def test_loopback_bridge_requires_a_token_and_times_out_silent_clients():
    import asyncio

    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed

    from meeting_wiki.live import LoopbackBridge

    with pytest.raises(ValueError):
        LoopbackBridge("")

    async def run():
        bridge = LoopbackBridge(TEST_TOKEN, auth_timeout_seconds=0.1)
        port = await bridge.start()
        try:
            async with connect(f"ws://127.0.0.1:{port}") as client:
                with pytest.raises(ConnectionClosed):
                    await asyncio.wait_for(client.recv(), 2)
                assert client.close_code == 1008
            assert not bridge.client_connected.is_set()
        finally:
            await bridge.close()

    asyncio.run(run())


# ---- Live runtime ----


class RecordingPublisher:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    async def publish(self, event_type, payload):
        self.events.append((event_type, dict(payload)))
        return True

    def of(self, event_type):
        return [payload for kind, payload in self.events if kind == event_type]


class FakeLanguage:
    name = "fake-language"

    def __init__(self, fail: bool = False):
        self.fail = fail
        self.translated: list[tuple[str, str]] = []
        self.summarized: list[tuple[str, str]] = []

    def translate(self, text, target_language):
        if self.fail:
            raise RuntimeError("provider said: secret transcript text /Users/test/audio.wav")
        self.translated.append((text, target_language))
        return f"[{target_language}] {text}"

    def summarize(self, transcript, output_language):
        self.summarized.append((transcript, output_language))
        return [f"points from {len(transcript)} chars"]

    def health(self):
        return True, "ok"


class FakeChunkedTranscriber:
    name = "fake-chunked"

    def __init__(self, results):
        self.results = list(results)
        self.requests = []

    def transcribe_chunk(self, request):
        assert request.audio_path.exists()
        assert request.audio_path.stat().st_mode & 0o777 == 0o600
        self.requests.append(request)
        result = self.results.pop(0) if self.results else []
        if isinstance(result, Exception):
            raise result
        return result

    def health(self):
        return True, "ok"


async def _drive(runtime, mic_path, writes, settle: float = 0.6):
    import asyncio

    task = asyncio.create_task(runtime.run())
    for data in writes:
        with mic_path.open("ab") as handle:
            handle.write(data)
        await asyncio.sleep(0.05)
    await asyncio.sleep(settle)
    runtime.stop.set()
    await asyncio.wait_for(task, 5)


def _runtime(tmp_path, transcriber, language, publisher, **overrides):
    import asyncio

    from meeting_wiki.live import LiveRuntime

    work_dir = tmp_path / "work"
    work_dir.mkdir(mode=0o700)
    options = {
        "mic_path": tmp_path / "mic.wav",
        "transcriber": transcriber,
        "language": language,
        "publisher": publisher,
        "stop": asyncio.Event(),
        "work_dir": work_dir,
        "private": True,
        "external": False,
        "target_language": "zh-CN",
        "summary_language": "zh-CN",
        "chunk_seconds": 2,
        "overlap_seconds": 1,
        "summary_context_characters": 500,
        "reconnect_delay_seconds": 0.01,
        "poll_seconds": 0.02,
    }
    options.update(overrides)
    return LiveRuntime(**options)


def test_chunked_runtime_publishes_ordered_deduplicated_finals_translation_and_summary(tmp_path):
    import asyncio

    first = [
        TranscriptSegment(start_seconds=0.0, end_seconds=0.9, text="Hello team"),
        TranscriptSegment(start_seconds=1.0, end_seconds=1.9, text="Budget review"),
    ]
    # The second chunk starts at 1.0s, so its first segment repeats the overlap.
    second = [
        TranscriptSegment(start_seconds=0.0, end_seconds=0.9, text="budget  review"),
        TranscriptSegment(start_seconds=1.0, end_seconds=1.9, text="Ship on Friday"),
    ]
    transcriber = FakeChunkedTranscriber([first, second])
    language = FakeLanguage()
    publisher = RecordingPublisher()
    runtime = _runtime(tmp_path, transcriber, language, publisher)
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive(runtime, mic, [_pcm(2), _pcm(1)]))

    assert [request.sequence for request in transcriber.requests] == [1, 2]
    assert publisher.of("transcript") == [
        {"sequence": 1, "text": "Hello team", "speaker": "you"},
        {"sequence": 2, "text": "Budget review", "speaker": "you"},
        {"sequence": 3, "text": "Ship on Friday", "speaker": "you"},
    ]
    assert publisher.of("translation") == [
        {"sequence": 1, "text": "[zh-CN] Hello team"},
        {"sequence": 2, "text": "[zh-CN] Budget review"},
        {"sequence": 3, "text": "[zh-CN] Ship on Friday"},
    ]
    assert publisher.of("summary")[-1]["points"]
    assert language.summarized
    assert {output_language for _, output_language in language.summarized} == {"zh-CN"}
    states = publisher.of("state")
    assert states[0] == {"phase": "listening", "private": True, "scope": "local"}
    assert states[-1]["phase"] == "stopped"
    assert list((tmp_path / "work").iterdir()) == []


def test_runtime_redacts_provider_errors_to_fixed_issue_codes(tmp_path):
    import asyncio
    import json

    failure = RuntimeError("could not read /Users/test/secret.wav: said hello")
    transcriber = FakeChunkedTranscriber(
        [failure, [TranscriptSegment(start_seconds=0, end_seconds=1, text="Visible text")]]
    )
    publisher = RecordingPublisher()
    runtime = _runtime(tmp_path, transcriber, FakeLanguage(fail=True), publisher, overlap_seconds=0)
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive(runtime, mic, [_pcm(2), _pcm(2)]))

    issues = [state.get("issue") for state in publisher.of("state")]
    assert "transcription_error" in issues
    assert "language_error" in issues
    serialized = json.dumps(publisher.events)
    assert "/Users/test" not in serialized
    assert "said hello" not in serialized
    assert "secret transcript text" not in serialized
    assert publisher.of("translation") == []


def test_runtime_stops_when_recording_is_discarded(tmp_path):
    import asyncio

    publisher = RecordingPublisher()
    runtime = _runtime(tmp_path, FakeChunkedTranscriber([]), FakeLanguage(), publisher)
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    async def run():
        task = asyncio.create_task(runtime.run())
        await asyncio.sleep(0.1)
        mic.unlink()
        await asyncio.wait_for(task, 5)

    asyncio.run(run())
    assert publisher.of("state")[-1] == {
        "phase": "stopped",
        "private": True,
        "scope": "local",
        "issue": "audio_unavailable",
    }


def test_session_runtime_streams_pcm_and_publishes_only_final_events(tmp_path):
    import asyncio
    from contextlib import asynccontextmanager

    from meeting_wiki.providers.base import LiveTranscriptEvent, LiveTranscriptKind

    class FakeSession:
        def __init__(self):
            self.audio = bytearray()
            self.queue: asyncio.Queue = asyncio.Queue()

        async def send_audio(self, pcm):
            self.audio.extend(pcm)
            if len(self.audio) >= 32_000 and self.queue.empty():
                await self.queue.put(LiveTranscriptEvent(LiveTranscriptKind.INTERIM, "Draft"))
                await self.queue.put(LiveTranscriptEvent(LiveTranscriptKind.FINAL, "Final words"))

        async def end_audio(self):
            return None

        async def events(self):
            while True:
                yield await self.queue.get()

        async def close(self):
            return None

    session = FakeSession()

    class FakeSessionProvider:
        name = "fake-session"

        @asynccontextmanager
        async def open_session(self, language=None):
            yield session

        def health(self):
            return True, "ok"

    publisher = RecordingPublisher()
    runtime = _runtime(tmp_path, FakeSessionProvider(), FakeLanguage(), publisher, external=True)
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive(runtime, mic, [_pcm(1)]))

    assert bytes(session.audio) == _pcm(1)
    assert publisher.of("transcript") == [{"sequence": 1, "text": "Final words", "speaker": "you"}]
    assert publisher.of("translation") == [{"sequence": 1, "text": "[zh-CN] Final words"}]
    assert publisher.of("state")[0]["scope"] == "external"


def _scripted_session_provider(script):
    """Session provider whose first send_audio releases scripted events or raises."""
    import asyncio
    from contextlib import asynccontextmanager

    class ScriptedSession:
        def __init__(self):
            self.audio = bytearray()
            self.queue: asyncio.Queue = asyncio.Queue()
            self.released = False

        async def send_audio(self, pcm):
            if self.released:
                raise script["after"]
            self.audio.extend(pcm)
            self.released = True
            for item in script["events"]:
                await self.queue.put(item)

        async def end_audio(self):
            return None

        async def events(self):
            while True:
                yield await self.queue.get()

        async def close(self):
            return None

    session = ScriptedSession()

    class Provider:
        name = "scripted-session"

        @asynccontextmanager
        async def open_session(self, language=None):
            yield session

        def health(self):
            return True, "ok"

    return Provider(), session


def test_session_runtime_keeps_sequence_and_context_across_provider_renewal(tmp_path):
    import asyncio

    from meeting_wiki.providers.base import (
        LiveSessionStatus,
        LiveSessionStatusCode,
        LiveTranscriptEvent,
        LiveTranscriptKind,
    )

    class SummaryRecordingLanguage(FakeLanguage):
        def __init__(self):
            super().__init__()
            self.contexts = []

        def summarize(self, transcript, output_language):
            self.contexts.append(transcript)
            return super().summarize(transcript, output_language)

    events = [
        LiveTranscriptEvent(LiveTranscriptKind.FINAL, "Before renewal"),
        LiveSessionStatus(LiveSessionStatusCode.RENEWING),
        LiveTranscriptEvent(LiveTranscriptKind.FINAL, "Drained after go away"),
        LiveSessionStatus(LiveSessionStatusCode.RESUMED),
        LiveTranscriptEvent(LiveTranscriptKind.FINAL, "After renewal"),
    ]
    provider, session = _scripted_session_provider({"events": events, "after": AssertionError})
    language = SummaryRecordingLanguage()
    publisher = RecordingPublisher()
    runtime = _runtime(tmp_path, provider, language, publisher, external=True)
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive(runtime, mic, [_pcm(1)]))

    assert publisher.of("transcript") == [
        {"sequence": 1, "text": "Before renewal", "speaker": "you"},
        {"sequence": 2, "text": "Drained after go away", "speaker": "you"},
        {"sequence": 3, "text": "After renewal", "speaker": "you"},
    ]
    assert [item["sequence"] for item in publisher.of("translation")] == [1, 2, 3]
    assert "Before renewal" in language.contexts[-1]
    assert "After renewal" in language.contexts[-1]
    states = publisher.of("state")
    renewing = {
        "phase": "listening",
        "private": True,
        "scope": "external",
        "issue": "provider_session_renewing",
    }
    index = states.index(renewing)
    assert states[index + 1] == {"phase": "listening", "private": True, "scope": "external"}
    assert "transcription_error" not in [state.get("issue") for state in states]
    assert states[-1]["phase"] == "stopped"
    assert bytes(session.audio) == _pcm(1)


def test_session_runtime_reports_provider_expiry_distinct_from_failure(tmp_path):
    import asyncio
    import json

    from meeting_wiki.providers.base import (
        LiveSessionExpiredError,
        LiveTranscriptEvent,
        LiveTranscriptKind,
    )

    events = [LiveTranscriptEvent(LiveTranscriptKind.FINAL, "Kept words")]
    provider, _session = _scripted_session_provider(
        {"events": events, "after": LiveSessionExpiredError()}
    )
    publisher = RecordingPublisher()
    # Retries are covered separately; with none left, expiry must end the channel distinctly.
    runtime = _runtime(
        tmp_path, provider, FakeLanguage(), publisher, external=True, reconnect_attempts=0
    )
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())
    audio_before = None

    async def drive():
        nonlocal audio_before
        task = asyncio.create_task(runtime.run())
        for _ in range(2):
            with mic.open("ab") as handle:
                handle.write(_pcm(1))
            await asyncio.sleep(0.1)
        await asyncio.wait_for(task, 5)
        audio_before = mic.read_bytes()

    asyncio.run(drive())

    assert publisher.of("transcript") == [{"sequence": 1, "text": "Kept words", "speaker": "you"}]
    states = publisher.of("state")
    assert states[-1] == {
        "phase": "unavailable",
        "private": True,
        "scope": "external",
        "issue": "provider_session_expired",
    }
    assert "transcription_error" not in [state.get("issue") for state in states]
    assert "expired and could not" not in json.dumps(publisher.events)
    # Live is a read-only tail: the recording file is left intact for batch ingest.
    assert audio_before == _wav_header() + _pcm(1) + _pcm(1)


def test_run_live_session_announces_port_and_reports_unbuilt_providers(tmp_path):
    import asyncio
    import json

    from websockets.asyncio.client import connect

    from meeting_wiki.config import AppConfig
    from meeting_wiki.live import run_live_session

    config = AppConfig.model_validate(
        {
            "data_dir": str(tmp_path),
            "providers": {"live_transcription": "openai_compatible"},
        }
    )

    async def run():
        announced: asyncio.Queue = asyncio.Queue()
        session = asyncio.create_task(
            run_live_session(config, tmp_path / "mic.wav", False, TEST_TOKEN, announced.put_nowait)
        )
        ready = json.loads(await asyncio.wait_for(announced.get(), 5))
        assert ready["type"] == "ready" and set(ready) == {"type", "port"}
        async with connect(f"ws://127.0.0.1:{ready['port']}") as client:
            await client.send(json.dumps({"type": "authenticate", "token": TEST_TOKEN}))
            message = json.loads(await asyncio.wait_for(client.recv(), 5))
        return message, await asyncio.wait_for(session, 5)

    message, code = asyncio.run(run())
    assert code == 1
    assert message == {
        "type": "state",
        "payload": {
            "phase": "unavailable",
            "private": False,
            "scope": "local",
            "issue": "provider_unavailable",
        },
    }


def test_run_live_session_exits_when_no_client_claims_it(tmp_path):
    import asyncio

    from meeting_wiki.config import AppConfig
    from meeting_wiki.live import run_live_session

    config = AppConfig.model_validate({"data_dir": str(tmp_path)})
    code = asyncio.run(
        run_live_session(
            config,
            tmp_path / "mic.wav",
            False,
            TEST_TOKEN,
            lambda _line: None,
            client_timeout_seconds=0.1,
        )
    )
    assert code == 3


def test_live_scope_reports_external_providers():
    from meeting_wiki.config import AppConfig
    from meeting_wiki.live import live_scope_is_external

    assert live_scope_is_external(AppConfig()) is False
    gemini = AppConfig.model_validate(
        {
            "providers": {"live_language": "gemini"},
            "live": {"allow_external_providers": True},
            "gemini": {"language_model": "test-gemini-language-1"},
        }
    )
    assert live_scope_is_external(gemini) is True


def test_live_cli_requires_a_token_from_the_environment(tmp_path, monkeypatch, capsys):
    from meeting_wiki.cli import main

    monkeypatch.delenv("MEETING_WIKI_LIVE_TOKEN", raising=False)
    monkeypatch.setenv("MEETING_WIKI_DATA_DIR", str(tmp_path))
    code = main(["--config", str(tmp_path / "config.toml"), "live", "--mic-audio", "mic.wav"])
    assert code == 2
    assert "live_token_required" in capsys.readouterr().out


# ---- Two-channel live and provider failures ----


class ChannelAwareTranscriber:
    """Chunked fake that answers by channel, so ordering across channels does not matter."""

    name = "fake-channels"

    def __init__(self, texts):
        self.texts = {speaker: list(lines) for speaker, lines in texts.items()}

    def transcribe_chunk(self, request):
        speaker = request.audio_path.name.split("-", 1)[0]
        lines = self.texts.get(speaker) or []
        if not lines:
            return []
        return [TranscriptSegment(start_seconds=0.0, end_seconds=0.9, text=lines.pop(0))]

    def health(self):
        return True, "ok"


async def _drive_two(runtime, mic_path, system_path, writes, settle: float = 0.6):
    import asyncio

    task = asyncio.create_task(runtime.run())
    for mic_data, system_data in writes:
        with mic_path.open("ab") as handle:
            handle.write(mic_data)
        if system_data is not None:
            with system_path.open("ab") as handle:
                handle.write(system_data)
        await asyncio.sleep(0.05)
    await asyncio.sleep(settle)
    runtime.stop.set()
    await asyncio.wait_for(task, 5)


def test_runtime_labels_microphone_and_system_audio_and_summarizes_both(tmp_path):
    import asyncio

    class ContextLanguage(FakeLanguage):
        def __init__(self):
            super().__init__()
            self.contexts = []

        def summarize(self, transcript, output_language):
            self.contexts.append(transcript)
            return super().summarize(transcript, output_language)

    language = ContextLanguage()
    publisher = RecordingPublisher()
    system = tmp_path / "system.raw"
    runtime = _runtime(
        tmp_path,
        ChannelAwareTranscriber({"you": ["My update"], "others": ["Their question"]}),
        language,
        publisher,
        overlap_seconds=0,
        system_path=system,
    )
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive_two(runtime, mic, system, [(_pcm(2), _pcm(2))]))

    transcripts = {item["text"]: item["speaker"] for item in publisher.of("transcript")}
    assert transcripts == {"My update": "you", "Their question": "others"}
    assert "You: My update" in language.contexts[-1]
    assert "Others: Their question" in language.contexts[-1]
    assert publisher.of("state")[-1] == {"phase": "stopped", "private": True, "scope": "local"}
    assert list((tmp_path / "work").iterdir()) == []


def test_runtime_drops_echo_that_reaches_both_channels(tmp_path):
    import asyncio

    publisher = RecordingPublisher()
    system = tmp_path / "system.raw"
    runtime = _runtime(
        tmp_path,
        ChannelAwareTranscriber({"you": ["Same sentence"], "others": ["same  sentence"]}),
        FakeLanguage(),
        publisher,
        overlap_seconds=0,
        system_path=system,
    )
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive_two(runtime, mic, system, [(_pcm(2), _pcm(2))]))

    assert len(publisher.of("transcript")) == 1


def test_missing_system_audio_keeps_microphone_live(tmp_path):
    import asyncio

    publisher = RecordingPublisher()
    runtime = _runtime(
        tmp_path,
        ChannelAwareTranscriber({"you": ["Still captioned"]}),
        FakeLanguage(),
        publisher,
        overlap_seconds=0,
        system_path=tmp_path / "never-created.raw",
        audio_start_timeout_seconds=0.1,
    )
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive_two(runtime, mic, None, [(_pcm(1), None), (_pcm(1), None)], settle=0.5))

    assert [item["text"] for item in publisher.of("transcript")] == ["Still captioned"]
    issues = [state.get("issue") for state in publisher.of("state")]
    assert "system_audio_unavailable" in issues
    assert publisher.of("state")[-1]["phase"] == "stopped"
    assert "issue" not in publisher.of("state")[-1]


def _session_provider(open_errors, events=()):
    """Session provider whose first opens fail with open_errors, then streams events."""
    import asyncio
    from contextlib import asynccontextmanager

    class Session:
        def __init__(self):
            self.queue: asyncio.Queue = asyncio.Queue()
            for item in events:
                self.queue.put_nowait(item)

        async def send_audio(self, pcm):
            return None

        async def end_audio(self):
            return None

        async def events(self):
            while True:
                yield await self.queue.get()

        async def close(self):
            return None

    class Provider:
        name = "fake-session"

        def __init__(self):
            self.opens = 0

        @asynccontextmanager
        async def open_session(self, language=None):
            self.opens += 1
            if open_errors:
                raise open_errors.pop(0)
            yield Session()

        def health(self):
            return True, "ok"

    return Provider()


def _provider_error(code=1008, status="PERMISSION_DENIED"):
    from meeting_wiki.providers.base import LiveProviderError

    class FakeAPIError(Exception):
        def __init__(self):
            super().__init__(f"{code} said: secret transcript text /Users/test/audio.wav")
            self.code = code
            self.status = status

    return LiveProviderError("Gemini", "connection", FakeAPIError())


def test_connection_failure_retries_then_reports_terminal_failure_with_safe_metadata(tmp_path):
    import asyncio
    import json

    reports = []
    provider = _session_provider([_provider_error() for _ in range(4)])
    publisher = RecordingPublisher()
    runtime = _runtime(
        tmp_path,
        provider,
        FakeLanguage(),
        publisher,
        external=True,
        report=reports.append,
        reconnect_attempts=2,
        reconnect_delay_seconds=0.01,
    )
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    async def drive():
        task = asyncio.create_task(runtime.run())
        with mic.open("ab") as handle:
            handle.write(_pcm(1))
        await asyncio.wait_for(task, 5)

    asyncio.run(drive())

    assert provider.opens == 3
    states = publisher.of("state")
    assert "provider_reconnecting" in [state.get("issue") for state in states]
    assert states[-1] == {
        "phase": "unavailable",
        "private": True,
        "scope": "external",
        "issue": "transcription_failed",
    }
    assert reports[-1] == {
        "event": "live_transcription_failed",
        "channel": "you",
        "error_type": "LiveProviderError",
        "sdk_error_type": "FakeAPIError",
        "close_code": 1008,
        "provider_status": "PERMISSION_DENIED",
    }
    serialized = json.dumps([publisher.events, reports])
    assert "secret transcript" not in serialized
    assert "/Users/test" not in serialized


def test_transient_connection_failure_reconnects_and_keeps_captioning(tmp_path):
    import asyncio

    from meeting_wiki.providers.base import LiveTranscriptEvent, LiveTranscriptKind

    provider = _session_provider(
        [_provider_error(code=1011, status="UNAVAILABLE")],
        events=[LiveTranscriptEvent(LiveTranscriptKind.FINAL, "After reconnect")],
    )
    publisher = RecordingPublisher()
    runtime = _runtime(
        tmp_path,
        provider,
        FakeLanguage(),
        publisher,
        external=True,
        reconnect_delay_seconds=0.01,
    )
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive(runtime, mic, [_pcm(1), _pcm(1)]))

    assert provider.opens == 2
    assert publisher.of("transcript") == [
        {"sequence": 1, "text": "After reconnect", "speaker": "you"}
    ]
    assert publisher.of("state")[-1]["phase"] == "stopped"


def test_live_diagnostics_log_keeps_only_allowlisted_fields_owner_only(tmp_path):
    import json

    from meeting_wiki.live import LiveDiagnosticsLog

    log = LiveDiagnosticsLog(tmp_path, max_bytes=400)
    log.write(
        {
            "event": "live_transcription_failed",
            "channel": "others",
            "close_code": 1008,
            "provider_status": "PERMISSION_DENIED",
            "message": "secret transcript text",
            "error_type": "bad value with spaces",
            "path": "/Users/test/audio.wav",
            "http_status": True,
        }
    )

    path = tmp_path / "logs" / "live.log"
    entry = json.loads(path.read_text())
    assert set(entry) == {"time", "event", "channel", "close_code", "provider_status"}
    assert path.stat().st_mode & 0o777 == 0o600
    for _ in range(10):
        log.write({"event": "live_chunk_failed"})
    assert path.stat().st_size <= 400 + 200


def test_chunked_channels_never_transcribe_concurrently_and_skip_digital_silence(tmp_path):
    import asyncio
    import threading
    import time

    class SlowTranscriber(ChannelAwareTranscriber):
        def __init__(self):
            super().__init__({"you": ["Mine"], "others": ["Theirs"]})
            self.active = 0
            self.peak = 0
            self.calls = 0
            self.lock = threading.Lock()

        def transcribe_chunk(self, request):
            with self.lock:
                self.active += 1
                self.calls += 1
                self.peak = max(self.peak, self.active)
            time.sleep(0.05)
            with self.lock:
                self.active -= 1
            return super().transcribe_chunk(request)

    transcriber = SlowTranscriber()
    system = tmp_path / "system.raw"
    runtime = _runtime(
        tmp_path,
        transcriber,
        FakeLanguage(),
        RecordingPublisher(),
        overlap_seconds=0,
        system_path=system,
    )
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive_two(runtime, mic, system, [(_pcm(2), _pcm(2)), (b"", b"\x00" * 64_000)]))

    assert transcriber.peak == 1
    assert transcriber.calls == 2


def test_silent_system_audio_shows_a_permission_hint_until_audio_arrives(tmp_path, monkeypatch):
    import asyncio

    from meeting_wiki import live as live_module

    monkeypatch.setattr(live_module, "SILENT_SYSTEM_SECONDS", 1.0)
    publisher = RecordingPublisher()
    system = tmp_path / "system.raw"
    runtime = _runtime(
        tmp_path,
        ChannelAwareTranscriber({"others": ["Finally audible"]}),
        FakeLanguage(),
        publisher,
        overlap_seconds=0,
        system_path=system,
    )
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(
        _drive_two(runtime, mic, system, [(b"", b"\x00" * 40_000), (b"", _pcm(2))], settle=0.8)
    )

    issues = [state.get("issue") for state in publisher.of("state")]
    hint = issues.index("system_audio_silent")
    assert None in issues[hint + 1 :]
    assert [item["text"] for item in publisher.of("transcript")] == ["Finally audible"]


def test_expired_session_is_retried_before_it_ends_the_channel(tmp_path):
    import asyncio

    from meeting_wiki.providers.base import (
        LiveSessionExpiredError,
        LiveTranscriptEvent,
        LiveTranscriptKind,
    )

    provider = _session_provider(
        [LiveSessionExpiredError()],
        events=[LiveTranscriptEvent(LiveTranscriptKind.FINAL, "Recovered")],
    )
    publisher = RecordingPublisher()
    runtime = _runtime(tmp_path, provider, FakeLanguage(), publisher, external=True)
    mic = tmp_path / "mic.wav"
    mic.write_bytes(_wav_header())

    asyncio.run(_drive(runtime, mic, [_pcm(1), _pcm(1)]))

    assert provider.opens == 2
    assert [item["text"] for item in publisher.of("transcript")] == ["Recovered"]
    assert publisher.of("state")[-1]["phase"] == "stopped"


def test_dedup_only_compares_recent_finals():
    from meeting_wiki.live import DEDUP_WINDOW, deduplicate_segments

    history = [TranscriptSegment(text="Yes")] + [
        TranscriptSegment(text=f"Line {index}") for index in range(DEDUP_WINDOW)
    ]
    assert deduplicate_segments(history, [TranscriptSegment(text="yes")]) == [
        TranscriptSegment(text="yes")
    ]
    assert deduplicate_segments(history, [TranscriptSegment(text="line 3")]) == []
