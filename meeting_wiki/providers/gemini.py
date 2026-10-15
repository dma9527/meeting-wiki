"""Native Gemini providers built on the google-genai SDK (meeting-wiki[gemini])."""

from __future__ import annotations

import json
import mimetypes
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from types import ModuleType
from typing import Any

from ..config import PrivacyConfig
from ..models import MeetingAnalysis, MeetingInput, TranscriptResult, TranscriptSegment
from .base import (
    LiveTranscriptEvent,
    LiveTranscriptKind,
    TranscriptionCapabilities,
    TranscriptionContext,
)
from .llm import _validate, analysis_messages

_INSTALL_HINT = "install meeting-wiki[gemini]"
_INSTALL_ERROR = "Gemini SDK is not installed. Run: pip install 'meeting-wiki[gemini]'"
_LIVE_PCM_MIME_TYPE = "audio/pcm;rate=16000"

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
    capabilities = TranscriptionCapabilities(hardware="remote-or-server")

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

    def transcribe(
        self,
        audio_path: Path,
        language: str | None = None,
        context: TranscriptionContext | None = None,
    ) -> TranscriptResult:
        client = self._client()
        generation_config: dict[str, Any] = {}
        if language:
            generation_config["transcription_config"] = {"language_codes": [language]}
        try:
            uploaded = client.files.upload(file=str(audio_path))
            mime_type = uploaded.mime_type or mimetypes.guess_type(audio_path.name)[0]
            interaction = client.interactions.create(
                model=self.model,
                input=[{"type": "audio", "uri": uploaded.uri, "mime_type": mime_type}],
                generation_config=generation_config,
            )
            text = str(interaction.output_text or "").strip()
        except Exception as error:
            # Redacted: SDK messages can echo keys, paths, or transcript text.
            raise RuntimeError(
                f"Gemini transcription request failed ({type(error).__name__})"
            ) from None
        if not text:
            raise RuntimeError("Gemini produced an empty transcript")
        return TranscriptResult(
            text=text,
            segments=[TranscriptSegment(text=text)],
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
        client_factory: ClientFactory | None = None,
    ):
        self.model = model
        self.api_key = api_key
        self.timeout = timeout_seconds
        self.privacy = privacy
        self._client_factory = client_factory

    def analyze(self, meeting: MeetingInput, transcript: TranscriptResult) -> MeetingAnalysis:
        system, user, meeting_type = analysis_messages(meeting, transcript, self.privacy)
        client = self._client()
        try:
            response = client.models.generate_content(
                model=self.model,
                contents=user,
                config={
                    "system_instruction": system,
                    "temperature": 0,
                    "response_mime_type": "application/json",
                },
            )
            content = response.text
        except Exception as error:
            raise RuntimeError(f"Gemini analysis request failed ({type(error).__name__})") from None
        try:
            data = json.loads(content or "")
        except json.JSONDecodeError:
            raise RuntimeError("Gemini returned non-JSON analysis") from None
        return _validate(data, meeting, meeting_type, transcript)

    def health(self) -> tuple[bool, str]:
        return _sdk_health(self.api_key, self.model)


def _redacted(action: str, error: BaseException) -> RuntimeError:
    # SDK messages can echo keys, paths, or transcript text; keep only the type name.
    return RuntimeError(f"Gemini live {action} failed ({type(error).__name__})")


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


class _GeminiLiveSession:
    def __init__(self, sdk_session: Any, blob_type: Any):
        self._session = sdk_session
        self._blob_type = blob_type
        self._audio_ended = False
        self._closed = False

    def _require_accepting_audio(self) -> None:
        if self._closed:
            raise RuntimeError("Gemini live session is closed")
        if self._audio_ended:
            raise RuntimeError("Gemini live audio stream has ended")

    async def send_audio(self, pcm: bytes) -> None:
        self._require_accepting_audio()
        if not isinstance(pcm, bytes):
            raise TypeError("Live audio must be bytes of 16-bit PCM")
        if not pcm:
            raise ValueError("Live audio chunk is empty")
        if len(pcm) % 2:
            raise ValueError("Live audio must be 16-bit PCM with an even byte length")
        blob = self._blob_type(data=pcm, mime_type=_LIVE_PCM_MIME_TYPE)
        try:
            await self._session.send_realtime_input(audio=blob)
        except Exception as error:
            raise _redacted("audio send", error) from None

    async def end_audio(self) -> None:
        self._require_accepting_audio()
        try:
            await self._session.send_realtime_input(audio_stream_end=True)
        except Exception as error:
            raise _redacted("audio send", error) from None
        self._audio_ended = True

    async def events(self) -> AsyncIterator[LiveTranscriptEvent]:
        # SDK receive() stops after each completed turn; re-enter until a pass yields nothing.
        while not self._closed:
            received = False
            try:
                async for message in self._session.receive():
                    received = True
                    for event in _transcript_events(message):
                        yield event
            except Exception as error:
                raise _redacted("receive", error) from None
            if not received:
                return

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self._session.close()
        except Exception as error:
            raise _redacted("close", error) from None


class GeminiLiveTranscriber(_GeminiClientMixin):
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

    @asynccontextmanager
    async def open_session(self, language: str | None = None) -> AsyncIterator[_GeminiLiveSession]:
        client = self._client()
        try:
            sdk_types = _import_genai_types()
        except ImportError as error:
            raise RuntimeError(_INSTALL_ERROR) from error
        transcription = {"language_codes": [language]} if language else {}
        connection = client.aio.live.connect(
            model=self.model, config={"input_audio_transcription": transcription}
        )
        try:
            sdk_session = await connection.__aenter__()
        except Exception as error:
            raise _redacted("connection", error) from None
        session = _GeminiLiveSession(sdk_session, sdk_types.Blob)
        body_failed = False
        try:
            yield session
        except BaseException:
            body_failed = True
            raise
        finally:
            await self._shutdown(connection, session, suppress_errors=body_failed)

    @staticmethod
    async def _shutdown(
        connection: Any, session: _GeminiLiveSession, suppress_errors: bool
    ) -> None:
        failure: RuntimeError | None = None
        try:
            await session.close()
        except RuntimeError as error:
            failure = error
        try:
            await connection.__aexit__(None, None, None)
        except Exception as error:
            failure = failure or _redacted("close", error)
        if failure is not None and not suppress_errors:
            raise failure from None

    def health(self) -> tuple[bool, str]:
        return _sdk_health(self.api_key, self.model)
