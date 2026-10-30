"""Native Gemini providers built on the google-genai SDK (meeting-wiki[gemini])."""

from __future__ import annotations

import asyncio
import contextlib
import json
import mimetypes
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

from ..audio_chunks import wav_duration_seconds
from ..config import PrivacyConfig
from ..diagnostics import SafeProviderError
from ..models import MeetingAnalysis, MeetingInput, TranscriptResult, TranscriptSegment
from .base import (
    LIVE_SUMMARY_RULES,
    EmptyTranscriptError,
    LiveProviderError,
    LiveSessionExpiredError,
    LiveSessionStatus,
    LiveSessionStatusCode,
    LiveTranscriptEvent,
    LiveTranscriptKind,
    TranscriptionCapabilities,
    TranscriptionContext,
    language_display_name,
)
from .llm import _validate, analysis_messages, openai_strict_schema

_INSTALL_HINT = "install meeting-wiki[gemini]"
_INSTALL_ERROR = "Gemini SDK is not installed. Run: pip install 'meeting-wiki[gemini]'"
_LIVE_PCM_MIME_TYPE = "audio/pcm;rate=16000"
# One request per 20 minutes of audio. A 90-minute request was always rejected with HTTP 400,
# while 28-minute requests succeeded; the engine splits longer recordings at this limit.
BATCH_MAX_DURATION_MINUTES = 20
BATCH_AUDIO_APIS = ("interactions", "generate_content")

_TRANSCRIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_seconds": {"type": "number"},
                    "text": {"type": "string"},
                },
                "required": ["start_seconds", "text"],
            },
        }
    },
    "required": ["segments"],
}


def _transcription_instruction(language: str | None) -> str:
    instruction = (
        "Transcribe the speech in this audio verbatim. Keep every language as spoken and never "
        "translate, summarize, or skip content. Split at sentence or speaker-turn boundaries. "
        "For each segment give start_seconds, the offset in seconds from the start of this "
        "audio. Return an empty segments list if there is no speech."
    )
    if language:
        instruction += f" The main spoken language is {language_display_name(language)}."
    return instruction


def _parse_transcript_segments(
    content: str | None, duration_seconds: float | None
) -> list[TranscriptSegment]:
    """Build ordered, bounded segments from the structured transcription response."""
    try:
        data = json.loads(content or "")
    except json.JSONDecodeError:
        raise RuntimeError("Gemini returned non-JSON transcript") from None
    raw_segments = data.get("segments") if isinstance(data, dict) else None
    if not isinstance(raw_segments, list):
        raise RuntimeError("Gemini returned an invalid transcript")
    limit = duration_seconds if duration_seconds and duration_seconds > 0 else None
    entries: list[tuple[float, str]] = []
    previous = 0.0
    for item in raw_segments:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        start = item.get("start_seconds")
        if not isinstance(text, str) or not text.strip():
            continue
        if isinstance(start, bool) or not isinstance(start, int | float) or start != start:
            start = previous
        start = max(previous, float(start))
        if limit is not None:
            start = min(start, limit)
        entries.append((start, text.strip()))
        previous = start
    segments: list[TranscriptSegment] = []
    for index, (start, text) in enumerate(entries):
        if index + 1 < len(entries):
            end = entries[index + 1][0]
        else:
            end = limit if limit is not None else start
        segments.append(
            TranscriptSegment(start_seconds=start, end_seconds=max(start, end), text=text)
        )
    return segments


ClientFactory = Callable[[], Any]


def _import_genai() -> ModuleType:
    from google import genai

    return genai


def _import_genai_types() -> ModuleType:
    from google.genai import types

    return types


def _sdk_health(api_key: str, model: str) -> tuple[bool, str]:
    """Local readiness check; never constructs a client or sends content."""
    try:
        _import_genai()
    except ImportError:
        return False, _INSTALL_HINT
    if not api_key:
        return False, "Gemini API key is not set"
    return True, f"Gemini SDK ready ({model})"


def _is_http_bad_request(error: BaseException) -> bool:
    """Match only a structured HTTP 400 signal, never provider message text."""
    code = getattr(error, "code", None)
    return isinstance(code, int) and not isinstance(code, bool) and code == 400


def _fallback_analysis_prompt(system: str, user: str) -> tuple[str, str]:
    """Build a JSON-mode fallback that keeps source fields out of the output."""
    output_schema = json.dumps(MeetingAnalysis.model_json_schema(), ensure_ascii=False)
    fallback_system = (
        f"{system}\n\nReturn exactly one JSON object matching this output schema: "
        f"{output_schema}\n"
        "The user payload is wrapped in an input object. Analyze its transcript, do not return "
        "input fields, and do not add fields outside the output schema."
    )
    fallback_user = json.dumps({"input": json.loads(user)}, ensure_ascii=False)
    return fallback_system, fallback_user


class _GeminiClientMixin:
    api_key: str
    timeout: float
    _client_factory: ClientFactory | None

    def _client(self) -> Any:
        if self._client_factory is not None:
            return self._client_factory()
        try:
            genai = _import_genai()
        except ImportError as error:
            raise RuntimeError(_INSTALL_ERROR) from error
        return genai.Client(
            api_key=self.api_key,
            http_options={"timeout": int(self.timeout * 1000)},
        )


class GeminiTranscriber(_GeminiClientMixin):
    name = "gemini"
    capabilities = TranscriptionCapabilities(
        timestamps=True,
        max_duration_minutes=BATCH_MAX_DURATION_MINUTES,
        hardware="remote-or-server",
    )

    def __init__(
        self,
        model: str,
        api_key: str,
        timeout_seconds: float,
        client_factory: ClientFactory | None = None,
        *,
        api: str = "interactions",
    ):
        if api not in BATCH_AUDIO_APIS:
            raise ValueError(f"Unknown Gemini batch audio API: {api}")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout_seconds
        self._client_factory = client_factory
        self.api = api

    def _segments_from_interactions(
        self, client: Any, uploaded: Any, mime_type: str | None, language: str | None
    ) -> list[TranscriptSegment]:
        generation_config: dict[str, Any] = {}
        if language:
            generation_config["transcription_config"] = {"language_codes": [language]}
        interaction = client.interactions.create(
            model=self.model,
            input=[{"type": "audio", "uri": uploaded.uri, "mime_type": mime_type}],
            generation_config=generation_config,
        )
        text = str(interaction.output_text or "").strip()
        return [TranscriptSegment(text=text)] if text else []

    def _request_generate_content(
        self, client: Any, uploaded: Any, language: str | None
    ) -> str | None:
        response = client.models.generate_content(
            model=self.model,
            contents=[uploaded, "Transcribe this audio."],
            config={
                "system_instruction": _transcription_instruction(language),
                "temperature": 0,
                "response_mime_type": "application/json",
                "response_schema": _TRANSCRIPT_SCHEMA,
            },
        )
        return response.text

    def transcribe(
        self,
        audio_path: Path,
        language: str | None = None,
        context: TranscriptionContext | None = None,
    ) -> TranscriptResult:
        client = self._client()
        structured: str | None = None
        segments: list[TranscriptSegment] = []
        try:
            uploaded = client.files.upload(file=str(audio_path))
            mime_type = uploaded.mime_type or mimetypes.guess_type(audio_path.name)[0]
            if self.api == "generate_content":
                structured = self._request_generate_content(client, uploaded, language)
            else:
                segments = self._segments_from_interactions(client, uploaded, mime_type, language)
        except Exception as error:
            # SDK messages can echo keys, paths, or transcript text.
            raise SafeProviderError("gemini", "transcription", error) from None
        if self.api == "generate_content":
            segments = _parse_transcript_segments(structured, wav_duration_seconds(audio_path))
        if not segments:
            raise EmptyTranscriptError("Gemini produced an empty transcript")
        return TranscriptResult(
            text="\n".join(segment.text for segment in segments),
            segments=segments,
            language=language,
            provider=self.name,
            model=self.model,
            diarized=False,
        )

    def health(self) -> tuple[bool, str]:
        return _sdk_health(self.api_key, self.model)


class GeminiLanguageProvider(_GeminiClientMixin):
    name = "gemini"

    def __init__(
        self,
        model: str,
        api_key: str,
        timeout_seconds: float,
        privacy: PrivacyConfig,
        output_language: str = "en",
        client_factory: ClientFactory | None = None,
    ):
        self.model = model
        self.api_key = api_key
        self.timeout = timeout_seconds
        self.privacy = privacy
        self.output_language = output_language
        self._client_factory = client_factory

    def analyze(self, meeting: MeetingInput, transcript: TranscriptResult) -> MeetingAnalysis:
        system, user, meeting_type = analysis_messages(
            meeting, transcript, self.privacy, self.output_language
        )
        client = self._client()
        structured_config = {
            "system_instruction": system,
            "temperature": 0,
            "response_mime_type": "application/json",
            "response_schema": openai_strict_schema(MeetingAnalysis.model_json_schema()),
        }
        try:
            response = client.models.generate_content(
                model=self.model,
                contents=user,
                config=structured_config,
            )
            content = response.text
        except Exception as structured_error:
            if not _is_http_bad_request(structured_error):
                raise SafeProviderError("gemini", "analysis", structured_error) from None
            fallback_system, fallback_user = _fallback_analysis_prompt(system, user)
            try:
                response = client.models.generate_content(
                    model=self.model,
                    contents=fallback_user,
                    config={
                        "system_instruction": fallback_system,
                        "temperature": 0,
                        "response_mime_type": "application/json",
                    },
                )
                content = response.text
            except Exception as fallback_error:
                raise SafeProviderError("gemini", "analysis", fallback_error) from None
        try:
            data = json.loads(content or "")
        except json.JSONDecodeError:
            raise RuntimeError("Gemini returned non-JSON analysis") from None
        return _validate(data, meeting, meeting_type, transcript)

    def health(self) -> tuple[bool, str]:
        return _sdk_health(self.api_key, self.model)


class GeminiLiveLanguageProvider(_GeminiClientMixin):
    """Display-only live translation and rolling summary via models.generate_content."""

    name = "gemini"

    def __init__(
        self,
        model: str,
        api_key: str,
        timeout_seconds: float,
        client_factory: ClientFactory | None = None,
    ):
        self.model = model
        self.api_key = api_key
        self.timeout = timeout_seconds
        self._client_factory = client_factory

    def _ask(self, action: str, instruction: str, text: str) -> str:
        client = self._client()
        try:
            response = client.models.generate_content(
                model=self.model,
                contents=text,
                config={
                    "system_instruction": instruction,
                    "temperature": 0,
                    "response_mime_type": "text/plain",
                },
            )
            content = response.text
        except Exception as error:
            raise _redacted(action, error) from None
        return str(content or "").strip()

    def translate(self, text: str, target_language: str) -> str:
        if not text.strip():
            return ""
        language = language_display_name(target_language)
        instruction = (
            f"Translate accurately into {language}. "
            "Return only the translation as plain text, with no notes or formatting."
        )
        return self._ask("translation", instruction, text)

    def summarize(self, transcript: str, output_language: str) -> list[str]:
        if not transcript.strip():
            return []
        language = language_display_name(output_language)
        instruction = (
            f"Summarize in {language} as up to five concise bullet points, one per line, "
            f"each starting with '- '. {LIVE_SUMMARY_RULES} Return only the bullets."
        )
        result = self._ask("summary", instruction, transcript)
        bullets = (
            line.strip().removeprefix("- ").removeprefix("* ") for line in result.splitlines()
        )
        return [bullet.strip() for bullet in bullets if bullet.strip()]

    def health(self) -> tuple[bool, str]:
        return _sdk_health(self.api_key, self.model)


def _redacted(action: str, error: BaseException) -> RuntimeError:
    # SDK messages can echo keys, paths, or transcript text; keep only allowlisted metadata.
    return LiveProviderError("Gemini", action, error)


# Gemini Live transcription expects BCP-47 locale codes from its supported-language table.
_LIVE_LANGUAGE_CODES = {"en": "en-US", "zh": "cmn-Hans-CN", "zh-CN": "cmn-Hans-CN"}


def live_language_code(language: str | None) -> str | None:
    """Map a configured language to a Live API locale. Unknown values fall back to auto."""
    return _LIVE_LANGUAGE_CODES.get(language or "")


def _transcription_text(transcription: Any) -> str | None:
    text = getattr(transcription, "text", None)
    return text if isinstance(text, str) and text.strip() else None


def _transcript_events(message: Any) -> list[LiveTranscriptEvent]:
    """Classify by SDK field: interim_input_transcription vs input_transcription."""
    content = getattr(message, "server_content", None)
    if content is None:
        return []
    events: list[LiveTranscriptEvent] = []
    interim = _transcription_text(getattr(content, "interim_input_transcription", None))
    if interim is not None:
        events.append(LiveTranscriptEvent(LiveTranscriptKind.INTERIM, interim))
    final = _transcription_text(getattr(content, "input_transcription", None))
    if final is not None:
        events.append(LiveTranscriptEvent(LiveTranscriptKind.FINAL, final))
    return events


# Gemini Live connections last about 10 minutes; roll over before the server aborts.
_MAX_CONNECTION_SECONDS = 540.0
_DRAIN_SECONDS = 2.0
_END = object()

ConnectFactory = Callable[[dict[str, Any]], Any]


def _resumption_handle(message: Any) -> str | None:
    update = getattr(message, "session_resumption_update", None)
    if update is None or getattr(update, "resumable", None) is not True:
        return None
    handle = getattr(update, "new_handle", None)
    return handle if isinstance(handle, str) and handle else None


@dataclass
class _Connection:
    context: Any
    session: Any
    opened_at: float
    queue: asyncio.Queue[Any] = field(default_factory=asyncio.Queue)
    receiver: asyncio.Task[None] | None = None
    closing: bool = False


class _GeminiLiveSession:
    """One logical live session that renews its provider connection before expiry.

    Renewal uses SDK session resumption (latest resumable handle) and falls back to a fresh
    connection. Events from each connection are yielded in connection order.
    """

    def __init__(
        self,
        connect: ConnectFactory,
        blob_type: Any,
        transcription: dict[str, Any],
        *,
        max_connection_seconds: float,
        drain_seconds: float,
        clock: Callable[[], float],
    ):
        self._connect = connect
        self._blob_type = blob_type
        self._transcription = transcription
        self._max_connection_seconds = max_connection_seconds
        self._drain_seconds = drain_seconds
        self._clock = clock
        self._lock = asyncio.Lock()
        self._changed = asyncio.Event()
        self._connections: list[_Connection] = []
        self._current: _Connection | None = None
        self._handle: str | None = None
        self._expiring = False
        self._renewing = False
        self._finished = False
        self._audio_ended = False
        self._closed = False

    def _config(self, handle: str | None) -> dict[str, Any]:
        # Matches the documented live transcription setup. Resumption is requested only when
        # the server has issued a handle; renewal otherwise opens a fresh connection.
        config: dict[str, Any] = {
            "response_modalities": ["TEXT"],
            "input_audio_transcription": self._transcription,
        }
        if handle:
            config["session_resumption"] = {"handle": handle}
        return config

    async def start(self) -> None:
        await self._open(None, first=None)

    async def _open(self, handle: str | None, first: LiveSessionStatus | None) -> None:
        context = self._connect(self._config(handle))
        sdk_session = await context.__aenter__()
        connection = _Connection(context, sdk_session, self._clock())
        if first is not None:
            connection.queue.put_nowait(first)
        connection.receiver = asyncio.create_task(self._receive(connection))
        self._connections.append(connection)
        self._current = connection
        self._changed.set()

    def _observe(self, connection: _Connection, message: Any) -> None:
        handle = _resumption_handle(message)
        if handle is not None:
            self._handle = handle
        if getattr(message, "go_away", None) is not None and connection is self._current:
            self._expiring = True

    async def _receive(self, connection: _Connection) -> None:
        # SDK receive() stops after each completed turn; re-enter until a pass yields nothing.
        try:
            while True:
                received = False
                async for message in connection.session.receive():
                    received = True
                    self._observe(connection, message)
                    for event in _transcript_events(message):
                        connection.queue.put_nowait(event)
                if not received:
                    break
        except Exception as error:
            # After go_away or during renewal the server closing the socket is expected.
            if not (connection.closing or self._expiring):
                connection.queue.put_nowait(_redacted("receive", error))
        finally:
            # A renewing connection is ended by _close_connection so late notices stay in order.
            if not (connection.closing or self._expiring or self._renewing):
                self._finished = True
                connection.queue.put_nowait(_END)
            self._changed.set()

    def _require_accepting_audio(self) -> None:
        if self._closed:
            raise RuntimeError("Gemini live session is closed")
        if self._audio_ended:
            raise RuntimeError("Gemini live audio stream has ended")
        if self._finished and self._current is None:
            raise LiveSessionExpiredError()

    def _renewal_due(self, connection: _Connection) -> bool:
        age = self._clock() - connection.opened_at
        return self._expiring or age >= self._max_connection_seconds

    async def send_audio(self, pcm: bytes) -> None:
        self._require_accepting_audio()
        if not isinstance(pcm, bytes):
            raise TypeError("Live audio must be bytes of 16-bit PCM")
        if not pcm:
            raise ValueError("Live audio chunk is empty")
        if len(pcm) % 2:
            raise ValueError("Live audio must be 16-bit PCM with an even byte length")
        blob = self._blob_type(data=pcm, mime_type=_LIVE_PCM_MIME_TYPE)
        async with self._lock:
            self._require_accepting_audio()
            connection = self._require_current()
            if self._renewal_due(connection):
                connection = await self._renew(connection)
            try:
                await connection.session.send_realtime_input(audio=blob)
                return
            except Exception as error:
                if not self._expiring:
                    raise _redacted("audio send", error) from None
            # The expiring connection rejected this chunk, so it was not consumed: resend it.
            connection = await self._renew(connection)
            try:
                await connection.session.send_realtime_input(audio=blob)
            except Exception as error:
                raise _redacted("audio send", error) from None

    def _require_current(self) -> _Connection:
        if self._current is None:
            raise LiveSessionExpiredError()
        return self._current

    async def _renew(self, old: _Connection) -> _Connection:
        self._renewing = True
        old.queue.put_nowait(LiveSessionStatus(LiveSessionStatusCode.RENEWING))
        old.closing = True
        # Flush audio already sent so its final transcription arrives before the swap.
        with contextlib.suppress(Exception):
            await old.session.send_realtime_input(audio_stream_end=True)
        if old.receiver is not None:
            await asyncio.wait({old.receiver}, timeout=self._drain_seconds)
        await self._close_connection(old, suppress_errors=True)
        self._current = None
        self._expiring = False
        handle, self._handle = self._handle, None
        try:
            if handle is not None:
                with contextlib.suppress(Exception):
                    await self._open(handle, LiveSessionStatus(LiveSessionStatusCode.RESUMED))
            if self._current is None:
                await self._open(None, LiveSessionStatus(LiveSessionStatusCode.RESTARTED))
        except Exception:
            self._finished = True
            raise LiveSessionExpiredError() from None
        finally:
            self._renewing = False
            self._changed.set()
        return self._require_current()

    async def end_audio(self) -> None:
        self._require_accepting_audio()
        async with self._lock:
            connection = self._require_current()
            try:
                await connection.session.send_realtime_input(audio_stream_end=True)
            except Exception as error:
                raise _redacted("audio send", error) from None
        self._audio_ended = True

    async def events(self) -> AsyncIterator[LiveTranscriptEvent | LiveSessionStatus]:
        index = 0
        while True:
            while index >= len(self._connections):
                if self._finished or self._closed:
                    return
                self._changed.clear()
                if index < len(self._connections) or self._finished or self._closed:
                    continue
                await self._changed.wait()
            connection = self._connections[index]
            while (item := await connection.queue.get()) is not _END:
                if isinstance(item, BaseException):
                    raise item from None
                yield item
            index += 1

    async def _close_connection(self, connection: _Connection, suppress_errors: bool) -> None:
        connection.closing = True
        if connection.receiver is not None and not connection.receiver.done():
            connection.receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await connection.receiver
        failure: RuntimeError | None = None
        try:
            await connection.session.close()
        except Exception as error:
            failure = _redacted("close", error)
        try:
            await connection.context.__aexit__(None, None, None)
        except Exception as error:
            failure = failure or _redacted("close", error)
        connection.queue.put_nowait(_END)
        self._changed.set()
        if failure is not None and not suppress_errors:
            raise failure from None

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._finished = True
        current, self._current = self._current, None
        if current is None:
            self._changed.set()
            return
        await self._close_connection(current, suppress_errors=False)


class GeminiLiveTranscriber(_GeminiClientMixin):
    name = "gemini"

    def __init__(
        self,
        model: str,
        api_key: str,
        timeout_seconds: float,
        client_factory: ClientFactory | None = None,
        *,
        max_connection_seconds: float = _MAX_CONNECTION_SECONDS,
        drain_seconds: float = _DRAIN_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.model = model
        self.api_key = api_key
        self.timeout = timeout_seconds
        self._client_factory = client_factory
        self.max_connection_seconds = max_connection_seconds
        self.drain_seconds = drain_seconds
        self._clock = clock

    @asynccontextmanager
    async def open_session(self, language: str | None = None) -> AsyncIterator[_GeminiLiveSession]:
        client = self._client()
        try:
            sdk_types = _import_genai_types()
        except ImportError as error:
            raise RuntimeError(_INSTALL_ERROR) from error
        locale = live_language_code(language)
        session = _GeminiLiveSession(
            lambda config: client.aio.live.connect(model=self.model, config=config),
            sdk_types.Blob,
            {"language_codes": [locale]} if locale else {},
            max_connection_seconds=self.max_connection_seconds,
            drain_seconds=self.drain_seconds,
            clock=self._clock,
        )
        try:
            await session.start()
        except Exception as error:
            raise _redacted("connection", error) from None
        body_failed = False
        try:
            yield session
        except BaseException:
            body_failed = True
            raise
        finally:
            try:
                await session.close()
            except RuntimeError:
                if not body_failed:
                    raise

    def health(self) -> tuple[bool, str]:
        return _sdk_health(self.api_key, self.model)
