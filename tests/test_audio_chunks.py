from __future__ import annotations

import wave

import pytest

from meeting_wiki.audio_chunks import split_wav, wav_duration_seconds


def write_wav(path, frames: bytes, framerate=10, sampwidth=1, nchannels=1):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(nchannels)
        output.setsampwidth(sampwidth)
        output.setframerate(framerate)
        output.writeframes(frames)


def test_duration_reads_a_pcm_wav_and_rejects_anything_else(tmp_path):
    audio = tmp_path / "meeting.wav"
    write_wav(audio, bytes(25))
    other = tmp_path / "meeting.mp3"
    other.write_bytes(b"ID3 not a wav")

    assert wav_duration_seconds(audio) == 2.5
    assert wav_duration_seconds(other) is None
    assert wav_duration_seconds(tmp_path / "missing.wav") is None


def test_split_keeps_every_frame_in_order_with_the_source_format(tmp_path):
    audio = tmp_path / "meeting.wav"
    frames = bytes(range(50)) * 2
    write_wav(audio, frames, framerate=10, sampwidth=2, nchannels=1)
    workdir = tmp_path / "work"
    workdir.mkdir()

    chunks = split_wav(audio, 2, workdir)

    assert [(chunk.start_seconds, chunk.end_seconds) for chunk in chunks] == [
        (0.0, 2.0),
        (2.0, 4.0),
        (4.0, 5.0),
    ]
    rebuilt = b""
    for chunk in chunks:
        with wave.open(str(chunk.path), "rb") as part:
            assert (part.getframerate(), part.getsampwidth(), part.getnchannels()) == (10, 2, 1)
            rebuilt += part.readframes(part.getnframes())
    assert rebuilt == frames
    assert all(chunk.path.parent == workdir for chunk in chunks)


def test_split_rejects_a_non_positive_chunk_length(tmp_path):
    audio = tmp_path / "meeting.wav"
    write_wav(audio, bytes(10))

    with pytest.raises(ValueError, match="positive"):
        split_wav(audio, 0, tmp_path)
