"""Transcription providers."""

from __future__ import annotations

import re
from pathlib import Path

import httpx

from ..models import TranscriptResult, TranscriptSegment


class TextImportTranscriber:
    name = "text"

    def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptResult:
        text = audio_path.read_text(encoding="utf-8").strip()
        if not text:
            raise ValueError(f"Transcript file is empty: {audio_path}")
        return TranscriptResult(
            text=text,
            segments=[TranscriptSegment(text=text)],
            language=language,
            provider=self.name,
            model="text-import",
            diarized=bool(re.search(r"(?m)^\s*(?:spk_\d+|[^:\n]{1,40}):\s+", text)),
        )

    def health(self) -> tuple[bool, str]:
        return True, "text import ready"


class MLXWhisperTranscriber:
    name = "mlx_whisper"

    def __init__(self, model: str):
        self.model = model

    def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptResult:
        try:
            import mlx_whisper
        except ImportError as error:
            raise RuntimeError(
                "MLX Whisper is not installed. Run: pip install 'meeting-wiki[mlx]'"
            ) from error
        kwargs = {"path_or_hf_repo": self.model}
        if language:
            kwargs["language"] = language
        result = mlx_whisper.transcribe(str(audio_path), **kwargs)
        text = str(result.get("text", "")).strip()
        if not text:
            raise RuntimeError("MLX Whisper produced an empty transcript")
        segments = [
            TranscriptSegment(
                start_seconds=float(segment.get("start", 0)),
                end_seconds=float(segment.get("end", 0)),
                text=str(segment.get("text", "")).strip(),
            )
            for segment in result.get("segments", [])
            if str(segment.get("text", "")).strip()
        ]
        return TranscriptResult(
            text=text,
            segments=segments,
            language=str(result.get("language") or language or "") or None,
            provider=self.name,
            model=self.model,
            diarized=False,
        )

    def health(self) -> tuple[bool, str]:
        try:
            import mlx_whisper  # noqa: F401

            return True, f"MLX Whisper ready ({self.model})"
        except ImportError:
            return False, "install meeting-wiki[mlx]"


class OpenAITranscriber:
    name = "openai_compatible"

    def __init__(self, base_url: str, model: str, api_key: str, timeout_seconds: float):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout_seconds

    def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptResult:
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        data = {"model": self.model, "response_format": "verbose_json"}
        if language:
            data["language"] = language
        with audio_path.open("rb") as handle:
            response = httpx.post(
                f"{self.base_url}/audio/transcriptions",
                headers=headers,
                data=data,
                files={"file": (audio_path.name, handle, "application/octet-stream")},
                timeout=self.timeout,
            )
        response.raise_for_status()
        result = response.json()
        text = str(result.get("text", "")).strip()
        if not text:
            raise RuntimeError("Transcription endpoint produced an empty transcript")
        segments = [
            TranscriptSegment(
                start_seconds=float(segment.get("start", 0)),
                end_seconds=float(segment.get("end", 0)),
                speaker=str(segment.get("speaker")) if segment.get("speaker") else None,
                text=str(segment.get("text", "")).strip(),
            )
            for segment in result.get("segments", [])
            if str(segment.get("text", "")).strip()
        ]
        return TranscriptResult(
            text=text,
            segments=segments,
            language=str(result.get("language") or language or "") or None,
            provider=self.name,
            model=self.model,
            diarized=any(segment.speaker for segment in segments),
        )

    def health(self) -> tuple[bool, str]:
        try:
            response = httpx.get(self.base_url.replace("/v1", ""), timeout=3)
            return response.status_code < 500, f"endpoint returned {response.status_code}"
        except httpx.HTTPError as error:
            return False, type(error).__name__
