"""Native Gemini providers built on the google-genai SDK (meeting-wiki[gemini])."""

from __future__ import annotations

import json
import mimetypes
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

from ..config import PrivacyConfig
from ..models import MeetingAnalysis, MeetingInput, TranscriptResult, TranscriptSegment
from .base import TranscriptionCapabilities, TranscriptionContext
from .llm import _validate, analysis_messages

_INSTALL_HINT = "install meeting-wiki[gemini]"

ClientFactory = Callable[[], Any]


def _import_genai() -> ModuleType:
    from google import genai

    return genai


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
            raise RuntimeError(
                "Gemini SDK is not installed. Run: pip install 'meeting-wiki[gemini]'"
            ) from error
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
