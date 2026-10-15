"""Local-first providers for display-only live meeting updates."""

from __future__ import annotations

import httpx

from ..models import TranscriptSegment
from .base import LiveTranscriptRequest
from .transcription import MLXWhisperTranscriber


class ChunkedMLXWhisperProvider:
    name = "chunked_mlx_whisper"

    def __init__(self, model: str):
        self._batch = MLXWhisperTranscriber(model)

    def transcribe_chunk(self, request: LiveTranscriptRequest) -> list[TranscriptSegment]:
        result = self._batch.transcribe(request.audio_path, request.language)
        return result.segments or [TranscriptSegment(text=result.text)]

    def health(self) -> tuple[bool, str]:
        return self._batch.health()


class OllamaLiveLanguageProvider:
    name = "ollama"

    def __init__(self, base_url: str, model: str, timeout_seconds: float):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout_seconds

    def _ask(self, instruction: str, text: str) -> str:
        response = httpx.post(
            f"{self.base_url}/api/chat",
            json={
                "model": self.model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": instruction},
                    {"role": "user", "content": text},
                ],
                "options": {"temperature": 0},
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        return str(response.json().get("message", {}).get("content", "")).strip()

    def translate(self, text: str, target_language: str) -> str:
        if not text.strip():
            return ""
        language = "Chinese" if target_language == "zh" else target_language
        instruction = f"Translate accurately into {language}. Return only the translation."
        return self._ask(instruction, text)

    def summarize(self, transcript: str) -> list[str]:
        if not transcript.strip():
            return []
        result = self._ask("Summarize as up to three concise bullet points.", transcript)
        return [line.removeprefix("- ").strip() for line in result.splitlines() if line.strip()]

    def health(self) -> tuple[bool, str]:
        try:
            response = httpx.get(f"{self.base_url}/api/tags", timeout=3)
            return response.status_code < 500, f"endpoint returned {response.status_code}"
        except httpx.HTTPError as error:
            return False, type(error).__name__
