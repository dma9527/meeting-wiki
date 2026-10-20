"""Privacy-scoped helpers and runtime for a display-only local live session.

Live events are never persisted: no jobs, wiki pages, search index, or live transcript
files. The durable batch ingest that runs after capture stops stays the source of truth.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import re
import shutil
import signal
import struct
import tempfile
import wave
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Protocol

from .models import TranscriptSegment
from .providers.base import (
    EmptyTranscriptError,
    LiveLanguageProvider,
    LiveSessionTranscriptionProvider,
    LiveTranscriptionProvider,
    LiveTranscriptRequest,
)

SAMPLE_RATE = 16_000
SAMPLE_WIDTH = 2
BYTES_PER_SECOND = SAMPLE_RATE * SAMPLE_WIDTH
TOKEN_ENV = "MEETING_WIKI_LIVE_TOKEN"
MAX_EVENT_TEXT = 2_000
MAX_SUMMARY_POINTS = 5


def _normalized_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def deduplicate_segments(
    existing: list[TranscriptSegment], incoming: list[TranscriptSegment]
) -> list[TranscriptSegment]:
    """Return only new final segments while retaining incoming order."""
    seen = {_normalized_text(segment.text) for segment in existing}
    unique: list[TranscriptSegment] = []
    for segment in incoming:
        normalized = _normalized_text(segment.text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(segment)
    return unique


def validate_session_message(message: Mapping[str, object], token: str) -> str:
    supplied = message.get("token")
    event_type = message.get("type")
    if not isinstance(supplied, str) or not hmac.compare_digest(supplied, token):
        raise PermissionError("Live session token is invalid")
    if not isinstance(event_type, str) or not event_type:
        raise ValueError("Live session message type is required")
    return event_type


class LiveAudioError(ValueError):
    """The live audio file is not a supported 16 kHz mono 16-bit PCM WAV."""


def wav_data_offset(header: bytes) -> int | None:
    """Return the PCM data offset of a 16 kHz mono 16-bit WAV, or None if incomplete.

    The data chunk size is ignored because a WAV that is still being written carries a
    placeholder size until capture stops.
    """
    if len(header) < 12:
        return None
    if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
        raise LiveAudioError("Live audio is not a WAV file")
    offset = 12
    format_ok = False
    while offset + 8 <= len(header):
        chunk_id = header[offset : offset + 4]
        (size,) = struct.unpack("<I", header[offset + 4 : offset + 8])
        body = offset + 8
        if chunk_id == b"data":
            if not format_ok:
                raise LiveAudioError("Live audio has no supported format chunk")
            return body
        if chunk_id == b"fmt ":
            if body + 16 > len(header):
                return None
            audio_format, channels, rate = struct.unpack("<HHI", header[body : body + 8])
            (bits,) = struct.unpack("<H", header[body + 14 : body + 16])
            if audio_format not in {1, 0xFFFE} or (channels, rate, bits) != (1, SAMPLE_RATE, 16):
                raise LiveAudioError("Live audio must be 16 kHz mono 16-bit PCM")
            format_ok = True
        offset = body + size + (size & 1)
    return None


class WavTail:
    """Read newly appended PCM frames from a WAV file that is still being recorded."""

    def __init__(self, path: Path, header_limit: int = 65_536):
        self.path = path
        self._header_limit = header_limit
        self._data_offset: int | None = None
        self._position = 0
        self.seen = False

    def read_new(self) -> bytes:
        """Return complete new frames. Raise FileNotFoundError if a seen file disappears."""
        try:
            handle = self.path.open("rb")
        except FileNotFoundError:
            if self.seen:
                raise
            return b""
        self.seen = True
        with handle:
            if self._data_offset is None:
                header = handle.read(self._header_limit)
                offset = wav_data_offset(header)
                if offset is None:
                    if len(header) >= self._header_limit:
                        raise LiveAudioError("Live audio header is too large")
                    return b""
                self._data_offset = offset
                self._position = offset
            handle.seek(self._position)
            data = handle.read()
        usable = len(data) - (len(data) % SAMPLE_WIDTH)
        self._position += usable
        return data[:usable]


def write_chunk_wav(directory: Path, sequence: int, pcm: bytes) -> Path:
    path = directory / f"chunk-{sequence:06d}.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(SAMPLE_WIDTH)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm)
    path.chmod(0o600)
    return path


class LoopbackBridge:
    """Authenticated, single-client live-event bridge bound to loopback only.

    The first client that presents the session token claims the session. Every later
    connection is refused, including after the claiming client disconnects.
    """

    def __init__(self, token: str, auth_timeout_seconds: float = 5.0):
        if not token:
            raise ValueError("Live session token is required")
        self._token = token
        self._auth_timeout = auth_timeout_seconds
        self._connection = None
        self._server = None
        self._claimed = False
        self.client_connected = asyncio.Event()
        self.client_closed = asyncio.Event()
        self.port: int | None = None

    async def start(self) -> int:
        from websockets.asyncio.server import serve

        self._server = await serve(self._handle, "127.0.0.1", 0, max_size=4_096)
        socket = self._server.sockets[0]
        self.port = int(socket.getsockname()[1])
        return self.port

    async def _handle(self, connection) -> None:
        from websockets.exceptions import ConnectionClosed

        remote = connection.remote_address
        if not remote or remote[0] not in {"127.0.0.1", "::1"}:
            await connection.close(code=1008, reason="loopback required")
            return
        if self._claimed:
            await connection.close(code=1008, reason="session already claimed")
            return
        try:
            raw_message = await asyncio.wait_for(connection.recv(), self._auth_timeout)
            message = json.loads(raw_message)
            if not isinstance(message, dict):
                raise ValueError("Live session message must be an object")
            if validate_session_message(message, self._token) != "authenticate":
                raise PermissionError("Live session authentication required")
        except (PermissionError, ValueError, TypeError, TimeoutError, ConnectionClosed):
            await connection.close(code=1008, reason="authentication required")
            return
        if self._claimed:
            await connection.close(code=1008, reason="session already claimed")
            return
        self._claimed = True
        self._connection = connection
        self.client_connected.set()
        try:
            await connection.wait_closed()
        finally:
            if self._connection is connection:
                self._connection = None
            self.client_closed.set()

    async def publish(self, event_type: str, payload: Mapping[str, object]) -> bool:
        from websockets.exceptions import ConnectionClosed

        connection = self._connection
        if connection is None:
            return False
        try:
            await connection.send(json.dumps({"type": event_type, "payload": dict(payload)}))
        except ConnectionClosed:
            return False
        return True

    async def close(self) -> None:
        if self._connection is not None:
            await self._connection.close()
            self._connection = None
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None


class Publisher(Protocol):
    async def publish(self, event_type: str, payload: Mapping[str, object]) -> bool: ...


def _clip(text: str, limit: int = MAX_EVENT_TEXT) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


class LiveRuntime:
    """Tail one growing mic WAV and publish display-only transcript, translation, summary.

    Errors are published only as fixed issue codes so transcript text, provider error
    messages, and filesystem paths never leave this process.
    """

    def __init__(
        self,
        *,
        mic_path: Path,
        transcriber: LiveTranscriptionProvider | LiveSessionTranscriptionProvider,
        language: LiveLanguageProvider,
        publisher: Publisher,
        stop: asyncio.Event,
        work_dir: Path,
        private: bool,
        external: bool,
        target_language: str,
        chunk_seconds: int,
        overlap_seconds: int,
        summary_context_characters: int,
        transcription_language: str | None = None,
        poll_seconds: float = 0.25,
        audio_start_timeout_seconds: float = 30.0,
        run_blocking: Callable[..., Awaitable[object]] = asyncio.to_thread,
    ):
        self.tail = WavTail(mic_path)
        self.transcriber = transcriber
        self.language = language
        self.publisher = publisher
        self.stop = stop
        self.work_dir = work_dir
        self.private = private
        self.external = external
        self.target_language = target_language
        self.chunk_bytes = chunk_seconds * BYTES_PER_SECOND
        self.overlap_bytes = overlap_seconds * BYTES_PER_SECOND
        self.summary_context_characters = summary_context_characters
        self.transcription_language = transcription_language
        self.poll_seconds = poll_seconds
        self.audio_start_timeout = audio_start_timeout_seconds
        self.run_blocking = run_blocking
        self._finals: list[TranscriptSegment] = []
        self._last_end = 0.0
        self._sequence = 0
        self._chunk_sequence = 0
        self._language_queue: asyncio.Queue[tuple[int, str]] = asyncio.Queue()

    async def state(self, phase: str, issue: str | None = None) -> None:
        payload: dict[str, object] = {
            "phase": phase,
            "private": self.private,
            "scope": "external" if self.external else "local",
        }
        if issue:
            payload["issue"] = issue
        await self.publisher.publish("state", payload)

    async def run(self) -> None:
        await self.state("listening")
        language_task = asyncio.create_task(self._language_worker())
        try:
            if isinstance(self.transcriber, LiveSessionTranscriptionProvider):
                await self._run_session()
            else:
                await self._run_chunked()
        except FileNotFoundError:
            await self.state("stopped", "audio_unavailable")
            return
        except LiveAudioError:
            await self.state("unavailable", "audio_unsupported")
            return
        except Exception:
            await self.state("unavailable", "transcription_error")
            return
        finally:
            language_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await language_task
        await self.state("stopped")

    async def _wait_poll(self) -> bool:
        """Sleep one poll interval; return True when the session should stop."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.stop.wait(), self.poll_seconds)
        return self.stop.is_set()

    async def _audio_frames(self):
        waited = 0.0
        while not await self._wait_poll():
            data = self.tail.read_new()
            if not self.tail.seen:
                waited += self.poll_seconds
                if waited >= self.audio_start_timeout:
                    raise FileNotFoundError("live audio never appeared")
                continue
            if data:
                yield data

    async def _run_chunked(self) -> None:
        buffer = bytearray()
        buffer_start = 0.0
        async for data in self._audio_frames():
            buffer.extend(data)
            while len(buffer) >= self.chunk_bytes and not self.stop.is_set():
                chunk = bytes(buffer[: self.chunk_bytes])
                await self._transcribe_chunk(chunk, buffer_start)
                advance = self.chunk_bytes - self.overlap_bytes
                del buffer[:advance]
                buffer_start += advance / BYTES_PER_SECOND

    async def _transcribe_chunk(self, pcm: bytes, offset_seconds: float) -> None:
        self._chunk_sequence += 1
        path = write_chunk_wav(self.work_dir, self._chunk_sequence, pcm)
        request = LiveTranscriptRequest(
            audio_path=path, sequence=self._chunk_sequence, language=self.transcription_language
        )
        try:
            segments = await self.run_blocking(self.transcriber.transcribe_chunk, request)
        except EmptyTranscriptError:
            segments = []
        except Exception:
            await self.state("listening", "transcription_error")
            return
        finally:
            path.unlink(missing_ok=True)
        await self._accept_segments(list(segments), offset_seconds)

    async def _accept_segments(
        self, segments: list[TranscriptSegment], offset_seconds: float
    ) -> None:
        shifted: list[TranscriptSegment] = []
        for segment in segments:
            start = segment.start_seconds + offset_seconds
            end = segment.end_seconds + offset_seconds
            timed = end > start
            # Overlap audio was already emitted by the previous chunk.
            if timed and (start + end) / 2 < self._last_end:
                continue
            shifted.append(segment.model_copy(update={"start_seconds": start, "end_seconds": end}))
        for segment in deduplicate_segments(self._finals, shifted):
            self._finals.append(segment)
            if segment.end_seconds > segment.start_seconds:
                self._last_end = max(self._last_end, segment.end_seconds)
            await self._emit_final(segment.text)

    async def _run_session(self) -> None:
        async with self.transcriber.open_session(self.transcription_language) as session:
            consumer = asyncio.create_task(self._consume_session(session))
            try:
                async for data in self._audio_frames():
                    if consumer.done():
                        break
                    await session.send_audio(data)
            finally:
                if not consumer.done():
                    consumer.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await consumer

    async def _consume_session(self, session) -> None:
        try:
            async for event in session.events():
                if event.is_final and event.text.strip():
                    await self._accept_segments([TranscriptSegment(text=event.text)], 0.0)
        except asyncio.CancelledError:
            raise
        except Exception:
            await self.state("listening", "transcription_error")

    async def _emit_final(self, text: str) -> None:
        self._sequence += 1
        clipped = _clip(text)
        await self.publisher.publish("transcript", {"sequence": self._sequence, "text": clipped})
        self._language_queue.put_nowait((self._sequence, clipped))

    def _summary_context(self) -> str:
        transcript = " ".join(segment.text for segment in self._finals)
        return transcript[-self.summary_context_characters :]

    async def _language_worker(self) -> None:
        while True:
            sequence, text = await self._language_queue.get()
            try:
                translation = await self.run_blocking(
                    self.language.translate, text, self.target_language
                )
                if translation:
                    await self.publisher.publish(
                        "translation", {"sequence": sequence, "text": _clip(str(translation))}
                    )
                # Coalesce summaries so a backlog does not trigger one call per segment.
                if self._language_queue.empty():
                    points = await self.run_blocking(
                        self.language.summarize, self._summary_context()
                    )
                    cleaned = [_clip(str(point), 400) for point in points if str(point).strip()]
                    await self.publisher.publish(
                        "summary", {"sequence": sequence, "points": cleaned[:MAX_SUMMARY_POINTS]}
                    )
            except asyncio.CancelledError:
                raise
            except Exception:
                await self.state("listening", "language_error")


def live_scope_is_external(config) -> bool:
    from .config import is_loopback_url

    selections = {config.providers.live_transcription, config.providers.live_language}
    if "gemini" in selections:
        return True
    return "openai_compatible" in selections and not is_loopback_url(
        config.openai_compatible.base_url
    )


async def run_live_session(
    config,
    mic_path: Path,
    private: bool,
    token: str,
    announce: Callable[[str], None],
    *,
    client_timeout_seconds: float = 15.0,
) -> int:
    """Run one live session. Returns a process exit code; never raises provider errors."""
    from .providers.registry import (
        build_live_language,
        build_live_transcription,
        validate_live_provider_selection,
    )

    bridge = LoopbackBridge(token)
    port = await bridge.start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(signum, stop.set)
    work_dir: Path | None = None
    watcher: asyncio.Task | None = None
    try:
        announce(json.dumps({"type": "ready", "port": port}))
        try:
            await asyncio.wait_for(bridge.client_connected.wait(), client_timeout_seconds)
        except TimeoutError:
            return 3

        async def stop_when_client_leaves() -> None:
            await bridge.client_closed.wait()
            stop.set()

        watcher = asyncio.create_task(stop_when_client_leaves())
        external = live_scope_is_external(config)
        try:
            validate_live_provider_selection(config)
            transcriber = build_live_transcription(config)
            language = build_live_language(config)
            if transcriber is None or language is None:
                raise RuntimeError("live provider has no adapter")
        except Exception:
            await bridge.publish(
                "state",
                {
                    "phase": "unavailable",
                    "private": private,
                    "scope": "external" if external else "local",
                    "issue": "provider_unavailable",
                },
            )
            return 1
        tmp_root = config.data_dir / "tmp"
        tmp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp_root.chmod(0o700)
        work_dir = Path(tempfile.mkdtemp(prefix="live-", dir=tmp_root))
        runtime = LiveRuntime(
            mic_path=mic_path,
            transcriber=transcriber,
            language=language,
            publisher=bridge,
            stop=stop,
            work_dir=work_dir,
            private=private,
            external=external,
            target_language=config.live.translation_target_language,
            chunk_seconds=config.live.chunk_seconds,
            overlap_seconds=config.live.overlap_seconds,
            summary_context_characters=config.live.summary_context_characters,
            transcription_language=config.language,
        )
        await runtime.run()
        return 0
    finally:
        if watcher is not None:
            watcher.cancel()
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
        await bridge.close()
