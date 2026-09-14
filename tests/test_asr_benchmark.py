from __future__ import annotations

import json
from pathlib import Path

import pytest

from meeting_wiki.asr_benchmark import (
    BenchmarkCase,
    ReferenceSegment,
    character_error_rate,
    diarization_error_rate,
    load_manifest,
    main,
    run_benchmark,
    timestamp_mae_seconds,
    word_error_rate,
)
from meeting_wiki.models import TranscriptResult, TranscriptSegment


class _FakeProvider:
    name = "fake-asr"

    def __init__(self, result: TranscriptResult):
        self.result = result
        self.calls = []

    def transcribe(self, audio_path, language=None, context=None):
        self.calls.append((audio_path, language))
        return self.result

    def health(self):
        return True, "ok"


def test_word_error_rate_handles_insertions_and_empty_reference():
    assert word_error_rate("hello world", "hello brave world") == pytest.approx(0.5)
    assert word_error_rate("", "") == 0.0
    assert word_error_rate("", "unexpected") == 1.0


def test_character_error_rate_handles_cjk_without_spaces():
    assert character_error_rate("会议维基", "会议百科") == pytest.approx(0.5)
    assert character_error_rate("", "") == 0.0


def test_diarization_error_rate_is_speaker_label_permutation_invariant():
    reference = [
        ReferenceSegment(start_seconds=0, end_seconds=1, speaker="Alex", text="hello"),
        ReferenceSegment(start_seconds=1, end_seconds=2, speaker="Sam", text="hi"),
    ]
    predicted = [
        TranscriptSegment(start_seconds=0, end_seconds=1, speaker="spk_1", text="hello"),
        TranscriptSegment(start_seconds=1, end_seconds=2, speaker="spk_0", text="hi"),
    ]
    assert diarization_error_rate(reference, predicted) == 0.0


def test_diarization_error_rate_counts_missed_speech():
    reference = [
        ReferenceSegment(start_seconds=0, end_seconds=2, speaker="Alex", text="hello"),
    ]
    predicted = [
        TranscriptSegment(start_seconds=0, end_seconds=1, speaker="speaker", text="hello"),
    ]
    assert diarization_error_rate(reference, predicted) == pytest.approx(0.5)


def test_timestamp_mae_pairs_segment_boundaries_in_order():
    reference = [
        ReferenceSegment(start_seconds=0, end_seconds=1, speaker="Alex", text="hello"),
    ]
    predicted = [
        TranscriptSegment(start_seconds=0.2, end_seconds=1.4, speaker="spk", text="hello"),
    ]
    assert timestamp_mae_seconds(reference, predicted) == pytest.approx(0.3)


def test_benchmark_default_output_is_aggregate_and_path_safe(tmp_path):
    private_audio = tmp_path / "private-career-meeting.wav"
    result = TranscriptResult(
        text="Alex hello",
        segments=[TranscriptSegment(start_seconds=0, end_seconds=1, speaker="spk_0", text="hello")],
        language="en",
        provider="fake-asr",
        model="test-model",
        diarized=True,
    )
    provider = _FakeProvider(result)
    case = BenchmarkCase(
        case_id="synthetic-en-1",
        audio_path=private_audio,
        language="en",
        duration_seconds=1,
        reference_segments=[
            ReferenceSegment(start_seconds=0, end_seconds=1, speaker="Alex", text="hello")
        ],
    )

    output = run_benchmark(provider, [case], clock=iter([10.0, 10.5]).__next__)
    serialized = json.dumps(output)

    assert output["case_count"] == 1
    assert output["metrics"]["rtf"] == pytest.approx(0.5)
    assert "cases" not in output
    assert str(private_audio) not in serialized
    assert "private-career" not in serialized
    assert "Alex" not in serialized
    assert "hello" not in serialized


def test_benchmark_failure_records_only_error_type(tmp_path):
    class _FailingProvider:
        name = "failing"

        def transcribe(self, audio_path, language=None, context=None):
            raise RuntimeError(f"secret transcript at {audio_path}")

        def health(self):
            return True, "ok"

    case = BenchmarkCase(
        case_id="synthetic-failure",
        audio_path=tmp_path / "secret.wav",
        duration_seconds=1,
        reference_segments=[
            ReferenceSegment(start_seconds=0, end_seconds=1, speaker="A", text="secret")
        ],
    )
    output = run_benchmark(_FailingProvider(), [case])
    serialized = json.dumps(output)

    assert output["failure_count"] == 1
    assert output["error_types"] == {"RuntimeError": 1}
    assert "secret.wav" not in serialized
    assert "secret transcript" not in serialized


def test_case_id_rejects_paths_and_freeform_names():
    with pytest.raises(ValueError):
        BenchmarkCase(
            case_id="../../private meeting",
            audio_path=Path("audio.wav"),
            duration_seconds=1,
            reference_segments=[],
        )


def test_manifest_resolves_audio_relative_to_manifest(tmp_path):
    audio = tmp_path / "fixture.wav"
    audio.write_bytes(b"synthetic")
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "case_id": "synthetic-relative",
                        "audio_path": "fixture.wav",
                        "duration_seconds": 1,
                        "reference_segments": [],
                    }
                ]
            }
        )
    )
    manifest = load_manifest(manifest_path)
    assert manifest.cases[0].audio_path == audio


def test_cli_dry_run_writes_private_aggregate_without_paths(tmp_path):
    audio = tmp_path / "private-source.wav"
    audio.write_bytes(b"synthetic")
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "case_id": "synthetic-dry-run",
                        "audio_path": str(audio),
                        "duration_seconds": 1,
                        "reference_segments": [],
                    }
                ]
            }
        )
    )
    output_path = tmp_path / "results" / "aggregate.json"

    assert (
        main(
            [
                "--config",
                str(tmp_path / "unused.toml"),
                "--manifest",
                str(manifest_path),
                "--output",
                str(output_path),
                "--dry-run",
            ]
        )
        == 0
    )
    output = output_path.read_text()
    assert json.loads(output) == {"case_count": 1, "schema_version": 1, "valid": True}
    assert str(audio) not in output
    assert output_path.stat().st_mode & 0o777 == 0o600
