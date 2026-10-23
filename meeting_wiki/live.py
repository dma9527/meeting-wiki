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
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .diagnostics import safe_identifier
from .models import TranscriptSegment
from .providers.base import (
    EmptyTranscriptError,
    LiveLanguageProvider,
    LiveProviderError,
    LiveSessionExpiredError,
    LiveSessionStatus,
    LiveSessionStatusCode,
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


# Echo and chunk overlap repeat recent text, so only the latest finals are compared.
DEDUP_WINDOW = 8


def deduplicate_segments(
    existing: list[TranscriptSegment], incoming: list[TranscriptSegment]
) -> list[TranscriptSegment]:
    """Return only new final segments while retaining incoming order."""
    seen = {_normalized_text(segment.text) for segment in existing[-DEDUP_WINDOW:]}
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


def write_chunk_wav(directory: Path, sequence: int, pcm: bytes, prefix: str = "chunk") -> Path:
    path = directory / f"{prefix}-{sequence:06d}.wav"
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


SPEAKER_YOU = "you"
SPEAKER_OTHERS = "others"
SPEAKER_LABELS = {SPEAKER_YOU: "You", SPEAKER_OTHERS: "Others"}
# Shown while the other channel keeps running.
PARTIAL_ISSUES = {
    SPEAKER_YOU: "microphone_unavailable",
    SPEAKER_OTHERS: "system_audio_unavailable",
}
# A connection that lasted this long counts as healthy, so its failure restarts the retry budget.
HEALTHY_CONNECTION_SECONDS = 30.0
# System audio that stays exact digital zero this long usually means the audio tap has no
# permission. It is also what a quiet meeting looks like, so the notice is only a hint.
SILENT_SYSTEM_SECONDS = 30.0


class RawPcmTail:
    """Read newly appended frames from a headerless 16 kHz mono 16-bit PCM capture."""

    def __init__(self, path: Path):
        self.path = path
        self._position = 0
        self.seen = False

    def read_new(self) -> bytes:
        try:
            handle = self.path.open("rb")
        except FileNotFoundError:
            if self.seen:
                raise
            return b""
        self.seen = True
        with handle:
            handle.seek(self._position)
            data = handle.read()
        usable = len(data) - (len(data) % SAMPLE_WIDTH)
        self._position += usable
        return data[:usable]


@dataclass
class _Channel:
    speaker: str
    tail: WavTail | RawPcmTail
    last_end: float = 0.0
    chunk_sequence: int = 0
    silent_bytes: int = 0
    heard: bool = False


class LiveProviderEndedError(RuntimeError):
    """The provider stopped sending events while the recording was still running."""


class LiveRuntime:
    """Tail the growing capture files and publish display-only transcript, translation, summary.

    The microphone channel is the local speaker and the optional system channel carries the
    other participants. Errors are published only as fixed issue codes, and the optional
    report callback receives only allowlisted metadata, so transcript text, provider error
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
        summary_language: str,
        chunk_seconds: int,
        overlap_seconds: int,
        summary_context_characters: int,
        transcription_language: str | None = None,
        system_path: Path | None = None,
        report: Callable[[Mapping[str, object]], None] | None = None,
        reconnect_attempts: int = 3,
        reconnect_delay_seconds: float = 1.0,
        poll_seconds: float = 0.25,
        audio_start_timeout_seconds: float = 30.0,
        run_blocking: Callable[..., Awaitable[object]] = asyncio.to_thread,
    ):
        self.channels = [_Channel(SPEAKER_YOU, WavTail(mic_path))]
        if system_path is not None:
            self.channels.append(_Channel(SPEAKER_OTHERS, RawPcmTail(system_path)))
        self.transcriber = transcriber
        self.language = language
        self.publisher = publisher
        self.stop = stop
        self.work_dir = work_dir
        self.private = private
        self.external = external
        self.target_language = target_language
        self.summary_language = summary_language
        self.chunk_bytes = chunk_seconds * BYTES_PER_SECOND
        self.overlap_bytes = overlap_seconds * BYTES_PER_SECOND
        self.summary_context_characters = summary_context_characters
        self.transcription_language = transcription_language
        self.report = report
        self.reconnect_attempts = reconnect_attempts
        self.reconnect_delay = reconnect_delay_seconds
        self.poll_seconds = poll_seconds
        self.audio_start_timeout = audio_start_timeout_seconds
        self.run_blocking = run_blocking
        self._finals: list[TranscriptSegment] = []
        self._sequence = 0
        self._partial_issue: str | None = None
        self._chunk_lock = asyncio.Lock()
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

    async def _listening(self, issue: str | None = None) -> None:
        await self.state("listening", issue or self._partial_issue)

    def _report(self, event: str, channel: _Channel | None = None, error=None) -> None:
        if self.report is None:
            return
        record: dict[str, object] = {"event": event}
        if channel is not None:
            record["channel"] = channel.speaker
        if error is not None:
            record["error_type"] = safe_identifier(type(error).__name__)
            if isinstance(error, LiveProviderError):
                record.update(error.metadata)
        with contextlib.suppress(Exception):
            self.report(record)

    async def run(self) -> None:
        await self.state("listening")
        language_task = asyncio.create_task(self._language_worker())
        pending = {
            asyncio.create_task(self._guarded(channel)): channel for channel in self.channels
        }
        failures: dict[str, str] = {}
        try:
            while pending:
                done, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    channel = pending.pop(task)
                    issue = task.result()
                    if issue is None:
                        continue
                    failures[channel.speaker] = issue
                    if pending and not self.stop.is_set():
                        self._partial_issue = PARTIAL_ISSUES[channel.speaker]
                        await self._listening()
        finally:
            for task in pending:
                task.cancel()
            for task in pending:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            language_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await language_task
        if len(failures) == len(self.channels):
            issue = failures.get(SPEAKER_YOU) or next(iter(failures.values()))
            await self.state("stopped" if issue == "audio_unavailable" else "unavailable", issue)
            return
        await self.state("stopped")

    async def _guarded(self, channel: _Channel) -> str | None:
        """Run one channel and return a fixed issue code when it ends early."""
        try:
            if isinstance(self.transcriber, LiveSessionTranscriptionProvider):
                await self._run_session(channel)
            else:
                await self._run_chunked(channel)
        except asyncio.CancelledError:
            raise
        except FileNotFoundError:
            return "audio_unavailable"
        except LiveAudioError:
            return "audio_unsupported"
        except LiveSessionExpiredError as error:
            self._report("live_session_expired", channel, error)
            return "provider_session_expired"
        except Exception as error:
            self._report("live_transcription_failed", channel, error)
            return "transcription_failed"
        return None

    async def _wait_poll(self) -> bool:
        """Sleep one poll interval; return True when the session should stop."""
        return await self._sleep_or_stop(self.poll_seconds)

    async def _sleep_or_stop(self, seconds: float) -> bool:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.stop.wait(), seconds)
        return self.stop.is_set()

    async def _audio_frames(self, channel: _Channel):
        waited = 0.0
        while not await self._wait_poll():
            data = channel.tail.read_new()
            if not channel.tail.seen:
                waited += self.poll_seconds
                if waited >= self.audio_start_timeout:
                    raise FileNotFoundError("live audio never appeared")
                continue
            if data:
                if channel.speaker == SPEAKER_OTHERS:
                    await self._track_system_silence(channel, data)
                yield data

    async def _track_system_silence(self, channel: _Channel, data: bytes) -> None:
        if data.count(0) != len(data):
            if not channel.heard:
                channel.heard = True
                if self._partial_issue == "system_audio_silent":
                    self._partial_issue = None
                    await self._listening()
            return
        if channel.heard:
            return
        channel.silent_bytes += len(data)
        # The silence hint also replaces a microphone failure notice, since then nothing is heard.
        if channel.silent_bytes >= SILENT_SYSTEM_SECONDS * BYTES_PER_SECOND and (
            self._partial_issue in {None, "microphone_unavailable"}
        ):
            self._partial_issue = "system_audio_silent"
            await self._listening()

    async def _run_chunked(self, channel: _Channel) -> None:
        buffer = bytearray()
        buffer_start = 0.0
        async for data in self._audio_frames(channel):
            buffer.extend(data)
            while len(buffer) >= self.chunk_bytes and not self.stop.is_set():
                chunk = bytes(buffer[: self.chunk_bytes])
                await self._transcribe_chunk(channel, chunk, buffer_start)
                advance = self.chunk_bytes - self.overlap_bytes
                del buffer[:advance]
                buffer_start += advance / BYTES_PER_SECOND

    async def _transcribe_chunk(self, channel: _Channel, pcm: bytes, offset_seconds: float) -> None:
        # Exact digital silence has no speech, and local Whisper tends to invent text for it.
        if pcm.count(0) == len(pcm):
            return
        # A local model is shared by both channels, so chunks are transcribed one at a time.
        async with self._chunk_lock:
            if self.stop.is_set():
                return
            await self._transcribe_locked(channel, pcm, offset_seconds)

    async def _transcribe_locked(
        self, channel: _Channel, pcm: bytes, offset_seconds: float
    ) -> None:
        channel.chunk_sequence += 1
        path = write_chunk_wav(self.work_dir, channel.chunk_sequence, pcm, prefix=channel.speaker)
        request = LiveTranscriptRequest(
            audio_path=path, sequence=channel.chunk_sequence, language=self.transcription_language
        )
        try:
            segments = await self.run_blocking(self.transcriber.transcribe_chunk, request)
        except EmptyTranscriptError:
            segments = []
        except Exception as error:
            self._report("live_chunk_failed", channel, error)
            await self._listening("transcription_error")
            return
        finally:
            path.unlink(missing_ok=True)
        await self._accept_segments(channel, list(segments), offset_seconds)

    async def _accept_segments(
        self, channel: _Channel, segments: list[TranscriptSegment], offset_seconds: float
    ) -> None:
        shifted: list[TranscriptSegment] = []
        for segment in segments:
            start = segment.start_seconds + offset_seconds
            end = segment.end_seconds + offset_seconds
            timed = end > start
            # Overlap audio was already emitted by the previous chunk.
            if timed and (start + end) / 2 < channel.last_end:
                continue
            shifted.append(
                segment.model_copy(
                    update={"start_seconds": start, "end_seconds": end, "speaker": channel.speaker}
                )
            )
        # Deduplication spans both channels, which drops speaker echo picked up by the mic.
        for segment in deduplicate_segments(self._finals, shifted):
            self._finals.append(segment)
            if segment.end_seconds > segment.start_seconds:
                channel.last_end = max(channel.last_end, segment.end_seconds)
            await self._emit_final(segment)

    async def _run_session(self, channel: _Channel) -> None:
        loop = asyncio.get_running_loop()
        frames = self._audio_frames(channel)
        attempt = 0
        try:
            while True:
                opened_at = loop.time()
                try:
                    await self._stream_session(channel, frames, reconnected=attempt > 0)
                    return
                except (FileNotFoundError, LiveAudioError):
                    raise
                except Exception as error:
                    if self.stop.is_set():
                        return
                    if loop.time() - opened_at >= HEALTHY_CONNECTION_SECONDS:
                        attempt = 0
                    attempt += 1
                    if attempt > self.reconnect_attempts:
                        raise
                    self._report("live_transcription_reconnecting", channel, error)
                    await self._listening("provider_reconnecting")
                    if await self._sleep_or_stop(self.reconnect_delay * attempt):
                        return
        finally:
            await frames.aclose()

    async def _stream_session(self, channel: _Channel, frames, *, reconnected: bool) -> None:
        async with self.transcriber.open_session(self.transcription_language) as session:
            if reconnected:
                await self._listening()
            consumer = asyncio.create_task(self._consume_session(channel, session))
            try:
                async for data in frames:
                    if consumer.done():
                        break
                    await session.send_audio(data)
            finally:
                if not consumer.done():
                    consumer.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await consumer
                elif not consumer.cancelled():
                    # Mark a consumer failure as retrieved when send_audio failed first.
                    consumer.exception()
            if consumer.cancelled():
                return
            consumer.result()
            if not self.stop.is_set():
                raise LiveProviderEndedError("live provider ended the session")

    async def _consume_session(self, channel: _Channel, session) -> None:
        async for event in session.events():
            if isinstance(event, LiveSessionStatus):
                await self._session_status(event.code)
            elif event.is_final and event.text.strip():
                await self._accept_segments(channel, [TranscriptSegment(text=event.text)], 0.0)

    async def _session_status(self, code: LiveSessionStatusCode) -> None:
        # Renewal keeps the runtime, so sequences, finals, and language context continue.
        if code is LiveSessionStatusCode.RENEWING:
            await self._listening("provider_session_renewing")
        else:
            await self._listening()

    async def _emit_final(self, segment: TranscriptSegment) -> None:
        self._sequence += 1
        clipped = _clip(segment.text)
        payload: dict[str, object] = {"sequence": self._sequence, "text": clipped}
        if segment.speaker in SPEAKER_LABELS:
            payload["speaker"] = segment.speaker
        await self.publisher.publish("transcript", payload)
        self._language_queue.put_nowait((self._sequence, clipped))

    def _summary_context(self) -> str:
        if len(self.channels) > 1:
            lines = (
                f"{SPEAKER_LABELS.get(segment.speaker or '', 'Unknown')}: {segment.text}"
                for segment in self._finals
            )
            transcript = "\n".join(lines)
        else:
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
                        self.language.summarize,
                        self._summary_context(),
                        self.summary_language,
                    )
                    cleaned = [_clip(str(point), 400) for point in points if str(point).strip()]
                    await self.publisher.publish(
                        "summary", {"sequence": sequence, "points": cleaned[:MAX_SUMMARY_POINTS]}
                    )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self._report("live_language_failed", error=error)
                await self._listening("language_error")


class LiveDiagnosticsLog:
    """Owner-only local log of live failures with allowlisted fields only.

    It never records transcript text, provider messages, keys, or file paths, so it can be
    attached to a bug report. The file is truncated when it grows past max_bytes.
    """

    FIELDS = frozenset(
        {
            "event",
            "channel",
            "error_type",
            "sdk_error_type",
            "http_status",
            "close_code",
            "provider_status",
        }
    )

    def __init__(self, data_dir: Path, max_bytes: int = 262_144):
        self.path = data_dir / "logs" / "live.log"
        self.max_bytes = max_bytes

    def write(self, record: Mapping[str, object]) -> None:
        import datetime
        import os

        entry: dict[str, object] = {
            "time": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")
        }
        for key, value in record.items():
            if key not in self.FIELDS:
                continue
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                continue
            if isinstance(value, str) and safe_identifier(value, "") != value:
                continue
            entry[key] = value
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.path.exists() and self.path.stat().st_size > self.max_bytes:
                self.path.unlink()
            descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, sort_keys=True) + "\n")
        except OSError:
            return


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
    system_path: Path | None = None,
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
        except Exception as error:
            LiveDiagnosticsLog(config.data_dir).write(
                {
                    "event": "live_provider_unavailable",
                    "error_type": safe_identifier(type(error).__name__),
                }
            )
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
            target_language=config.live_translation_language,
            summary_language=config.live_summary_language,
            chunk_seconds=config.live.chunk_seconds,
            overlap_seconds=config.live.overlap_seconds,
            summary_context_characters=config.live.summary_context_characters,
            transcription_language=config.transcription_language,
            system_path=system_path,
            report=LiveDiagnosticsLog(config.data_dir).write,
        )
        await runtime.run()
        return 0
    finally:
        if watcher is not None:
            watcher.cancel()
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
        await bridge.close()
