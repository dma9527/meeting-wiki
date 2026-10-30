"""Split long PCM WAV recordings into sequential chunks for providers with a length limit."""

from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AudioChunk:
    start_seconds: float
    end_seconds: float
    path: Path


def wav_duration_seconds(path: Path) -> float | None:
    """Return a PCM WAV file's duration, or None if it cannot be read as one."""
    try:
        with wave.open(str(path), "rb") as source:
            rate = source.getframerate()
            if rate <= 0:
                return None
            return source.getnframes() / rate
    except (EOFError, OSError, wave.Error):
        return None


def split_wav(path: Path, chunk_seconds: float, workdir: Path) -> list[AudioChunk]:
    """Write sequential chunk files under workdir, preserving the source WAV parameters."""
    if chunk_seconds <= 0:
        raise ValueError("chunk_seconds must be positive")
    chunks: list[AudioChunk] = []
    with wave.open(str(path), "rb") as source:
        params = source.getparams()
        rate = source.getframerate()
        total_frames = source.getnframes()
        frames_per_chunk = max(1, int(chunk_seconds * rate))
        start_frame = 0
        while start_frame < total_frames:
            frame_count = min(frames_per_chunk, total_frames - start_frame)
            source.setpos(start_frame)
            frames = source.readframes(frame_count)
            chunk_path = workdir / f"chunk-{len(chunks):04d}.wav"
            with wave.open(str(chunk_path), "wb") as destination:
                destination.setparams(params)
                destination.writeframes(frames)
            chunks.append(
                AudioChunk(start_frame / rate, (start_frame + frame_count) / rate, chunk_path)
            )
            start_frame += frame_count
    return chunks
