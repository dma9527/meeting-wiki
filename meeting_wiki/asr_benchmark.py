"""Privacy-safe ASR benchmark metrics and runner.

Default results contain only aggregate measurements, provider/model identifiers,
and error classes. Audio paths, references, predictions, speaker names, and case
identifiers are omitted unless a caller explicitly requests per-case metrics.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import resource
import time
from collections import Counter
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .models import TranscriptResult, TranscriptSegment
from .providers.base import TranscriptionContext

_TOKEN = re.compile(r"\w+", re.UNICODE)
_CASE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")


class ReferenceSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    speaker: str = Field(min_length=1, max_length=100)
    text: str = ""


class BenchmarkCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    case_id: str
    audio_path: Path
    language: str | None = None
    duration_seconds: float = Field(gt=0)
    expected_speakers: list[str] = Field(default_factory=list, max_length=20)
    hotwords: list[str] = Field(default_factory=list, max_length=100)
    reference_segments: list[ReferenceSegment] = Field(default_factory=list)

    @field_validator("case_id")
    @classmethod
    def safe_case_id(cls, value: str) -> str:
        if not _CASE_ID.fullmatch(value):
            raise ValueError("case_id must be a short opaque identifier")
        return value


class BenchmarkManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cases: list[BenchmarkCase] = Field(min_length=1)


class _Transcriber(Protocol):
    name: str

    def transcribe(
        self,
        audio_path: Path,
        language: str | None = None,
        context: TranscriptionContext | None = None,
    ) -> TranscriptResult: ...


def _words(text: str) -> list[str]:
    return _TOKEN.findall(text.casefold())


def _edit_distance(expected: list[str], actual: list[str]) -> int:
    previous = list(range(len(actual) + 1))
    for expected_item in expected:
        current = [previous[0] + 1]
        for index, actual_item in enumerate(actual, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[index] + 1,
                    previous[index - 1] + (expected_item != actual_item),
                )
            )
        previous = current
    return previous[-1]


def word_error_rate(reference: str, hypothesis: str) -> float:
    expected = _words(reference)
    actual = _words(hypothesis)
    if not expected:
        return 0.0 if not actual else 1.0
    return _edit_distance(expected, actual) / len(expected)


def character_error_rate(reference: str, hypothesis: str) -> float:
    expected = [character for character in reference.casefold() if character.isalnum()]
    actual = [character for character in hypothesis.casefold() if character.isalnum()]
    if not expected:
        return 0.0 if not actual else 1.0
    return _edit_distance(expected, actual) / len(expected)


def _active_speaker(segments: Iterable, moment: float) -> str | None:
    for segment in segments:
        if segment.start_seconds <= moment < segment.end_seconds:
            return segment.speaker
    return None


def _optimal_speaker_mapping(
    confusion: Counter[tuple[str, str]],
    predicted_speakers: list[str],
    reference_speakers: list[str],
) -> dict[str, str]:
    if not predicted_speakers or not reference_speakers:
        return {}
    if len(reference_speakers) > 12:
        return {
            predicted: max(
                reference_speakers,
                key=lambda reference: confusion[(predicted, reference)],
            )
            for predicted in predicted_speakers
        }

    states: dict[int, tuple[int, dict[str, str]]] = {0: (0, {})}
    for predicted in predicted_speakers:
        next_states = dict(states)
        for used, (score, mapping) in states.items():
            for reference_index, reference in enumerate(reference_speakers):
                bit = 1 << reference_index
                if used & bit:
                    continue
                candidate_score = score + confusion[(predicted, reference)]
                candidate_mapping = {**mapping, predicted: reference}
                current = next_states.get(used | bit)
                if current is None or candidate_score > current[0]:
                    next_states[used | bit] = (candidate_score, candidate_mapping)
        states = next_states
    return max(states.values(), key=lambda item: item[0])[1]


def diarization_error_rate(
    reference: list[ReferenceSegment],
    predicted: list[TranscriptSegment],
    frame_seconds: float = 0.1,
) -> float:
    if frame_seconds <= 0:
        raise ValueError("frame_seconds must be positive")
    end = max(
        [segment.end_seconds for segment in reference]
        + [segment.end_seconds for segment in predicted]
        + [0.0]
    )
    frames: list[tuple[str | None, str | None]] = []
    confusion: Counter[tuple[str, str]] = Counter()
    for frame_index in range(math.ceil(end / frame_seconds)):
        moment = (frame_index + 0.5) * frame_seconds
        reference_speaker = _active_speaker(reference, moment)
        predicted_speaker = _active_speaker(predicted, moment)
        if predicted_speaker is None and any(
            segment.start_seconds <= moment < segment.end_seconds for segment in predicted
        ):
            predicted_speaker = "__unknown__"
        frames.append((reference_speaker, predicted_speaker))
        if reference_speaker and predicted_speaker:
            confusion[(predicted_speaker, reference_speaker)] += 1

    reference_speakers = sorted({speaker for speaker, _predicted in frames if speaker})
    predicted_speakers = sorted({speaker for _reference, speaker in frames if speaker})
    mapping = _optimal_speaker_mapping(confusion, predicted_speakers, reference_speakers)
    reference_frames = sum(reference_speaker is not None for reference_speaker, _ in frames)
    errors = 0
    for reference_speaker, predicted_speaker in frames:
        missing_or_false_alarm = (reference_speaker is None) != (predicted_speaker is None)
        speaker_confusion = (
            reference_speaker is not None
            and predicted_speaker is not None
            and mapping.get(predicted_speaker) != reference_speaker
        )
        if missing_or_false_alarm or speaker_confusion:
            errors += 1
    if reference_frames == 0:
        return 0.0 if errors == 0 else 1.0
    return errors / reference_frames


def timestamp_mae_seconds(
    reference: list[ReferenceSegment], predicted: list[TranscriptSegment]
) -> float | None:
    pairs = list(zip(reference, predicted, strict=False))
    if not pairs:
        return None
    absolute_errors = [
        error
        for expected, actual in pairs
        for error in (
            abs(expected.start_seconds - actual.start_seconds),
            abs(expected.end_seconds - actual.end_seconds),
        )
    ]
    return sum(absolute_errors) / len(absolute_errors)


def _peak_rss_mb() -> float:
    raw = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return raw / (1024 * 1024) if platform.system() == "Darwin" else raw / 1024


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def run_benchmark(
    provider: _Transcriber,
    cases: list[BenchmarkCase],
    *,
    include_case_metrics: bool = False,
    model_size_bytes: int | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> dict[str, object]:
    metrics: list[dict[str, float | None]] = []
    per_case: list[dict[str, object]] = []
    errors: Counter[str] = Counter()
    models: set[str] = set()
    cold_start_seconds: float | None = None

    for case in cases:
        started = clock()
        try:
            context = TranscriptionContext(
                expected_speakers=tuple(case.expected_speakers),
                hotwords=tuple(case.hotwords),
            )
            transcript = provider.transcribe(
                case.audio_path,
                case.language,
                context,
            )
            elapsed = clock() - started
            if cold_start_seconds is None:
                cold_start_seconds = elapsed
            models.add(transcript.model)
            reference_text = " ".join(segment.text for segment in case.reference_segments)
            case_metrics: dict[str, float | None] = {
                "wer": word_error_rate(reference_text, transcript.text),
                "cer": character_error_rate(reference_text, transcript.text),
                "der": diarization_error_rate(case.reference_segments, transcript.segments),
                "timestamp_mae_seconds": timestamp_mae_seconds(
                    case.reference_segments, transcript.segments
                ),
                "rtf": elapsed / case.duration_seconds,
            }
            metrics.append(case_metrics)
            if include_case_metrics:
                per_case.append({"case_id": case.case_id, "metrics": case_metrics})
        except Exception as error:
            errors[type(error).__name__] += 1
            if include_case_metrics:
                per_case.append({"case_id": case.case_id, "error_type": type(error).__name__})

    output: dict[str, object] = {
        "schema_version": 1,
        "provider": provider.name,
        "models": sorted(models),
        "architecture": platform.machine(),
        "case_count": len(cases),
        "success_count": len(metrics),
        "failure_count": sum(errors.values()),
        "error_types": dict(sorted(errors.items())),
        "metrics": {
            "wer": _mean([value for item in metrics if (value := item["wer"]) is not None]),
            "cer": _mean([value for item in metrics if (value := item["cer"]) is not None]),
            "der": _mean([value for item in metrics if (value := item["der"]) is not None]),
            "timestamp_mae_seconds": _mean(
                [value for item in metrics if (value := item["timestamp_mae_seconds"]) is not None]
            ),
            "rtf": _mean([value for item in metrics if (value := item["rtf"]) is not None]),
            "cold_start_seconds": cold_start_seconds,
            "peak_rss_mb": _peak_rss_mb(),
            "model_size_bytes": model_size_bytes,
        },
    }
    if include_case_metrics:
        output["cases"] = per_case
    return output


def load_manifest(path: Path) -> BenchmarkManifest:
    expanded = path.expanduser().resolve()
    manifest = BenchmarkManifest.model_validate_json(expanded.read_text(encoding="utf-8"))
    cases = [
        case.model_copy(
            update={
                "audio_path": (
                    case.audio_path
                    if case.audio_path.is_absolute()
                    else (expanded.parent / case.audio_path).resolve()
                )
            }
        )
        for case in manifest.cases
    ]
    return manifest.model_copy(update={"cases": cases})


def directory_size_bytes(path: Path | None) -> int | None:
    if path is None:
        return None
    expanded = path.expanduser().resolve()
    if expanded.is_file():
        return expanded.stat().st_size
    if not expanded.is_dir():
        raise FileNotFoundError(expanded)
    return sum(item.stat().st_size for item in expanded.rglob("*") if item.is_file())


def _write_result(path: Path | None, output: dict[str, object]) -> None:
    serialized = json.dumps(output, indent=2, sort_keys=True) + "\n"
    if path is None:
        print(serialized, end="")
        return
    expanded = path.expanduser().resolve()
    expanded.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    expanded.write_text(serialized, encoding="utf-8")
    os.chmod(expanded, 0o600)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m meeting_wiki.asr_benchmark")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--model-path", type=Path)
    parser.add_argument("--include-case-metrics", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    manifest = load_manifest(args.manifest)
    missing = [case.case_id for case in manifest.cases if not case.audio_path.is_file()]
    if missing:
        _write_result(
            args.output,
            {
                "schema_version": 1,
                "valid": False,
                "case_count": len(manifest.cases),
                "missing_audio_count": len(missing),
            },
        )
        return 1
    if args.dry_run:
        _write_result(
            args.output,
            {
                "schema_version": 1,
                "valid": True,
                "case_count": len(manifest.cases),
            },
        )
        return 0

    from .config import load_config
    from .providers.registry import build_providers

    config = load_config(args.config)
    provider = build_providers(config).transcription
    output = run_benchmark(
        provider,
        manifest.cases,
        include_case_metrics=args.include_case_metrics,
        model_size_bytes=directory_size_bytes(args.model_path),
    )
    _write_result(args.output, output)
    return 0 if output["failure_count"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
