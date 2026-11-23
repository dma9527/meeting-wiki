from __future__ import annotations

import stat
from datetime import date
from types import SimpleNamespace

import pytest

from meeting_wiki import usage
from meeting_wiki.usage import UsageLog, live_budget_reached, price_for


def test_usage_accumulates_per_day_model_and_operation_in_an_owner_only_file(tmp_path):
    log = UsageLog(tmp_path / "usage.db")
    day = date(2026, 11, 17)
    log.record(
        "gemini", "gemini-3.6-flash", "analysis", input_tokens=1000, output_tokens=200, day=day
    )
    log.record(
        "gemini", "gemini-3.6-flash", "analysis", input_tokens=500, output_tokens=100, day=day
    )

    report = log.month("2026-11")

    [item] = report["items"]
    assert (item["calls"], item["input_tokens"], item["output_tokens"]) == (2, 1500, 300)
    assert item["estimated_usd"] == pytest.approx(1500 * 0.75 / 1e6 + 300 * 3.75 / 1e6, abs=1e-4)
    assert stat.S_IMODE((tmp_path / "usage.db").stat().st_mode) == 0o600


def test_prices_follow_the_published_schedule_and_retired_names():
    assert price_for("gemini-3.6-flash", date(2026, 12, 31)).input_per_million == 0.75
    assert price_for("gemini-3.6-flash", date(2027, 1, 1)).input_per_million == 1.50
    assert price_for("gemini-3.5-flash", date(2026, 11, 1)) == price_for(
        "gemini-3.6-flash", date(2026, 11, 1)
    )
    assert price_for("my-local-model", date(2026, 11, 1)) is None


def test_live_audio_minutes_are_priced_and_unknown_models_are_flagged(tmp_path):
    log = UsageLog(tmp_path / "usage.db")
    day = date(2026, 11, 3)
    log.record(
        "gemini", "gemini-3.5-transcribe-live", "live_transcription", audio_seconds=600, day=day
    )
    log.record("openai_compatible", "custom-model", "analysis", input_tokens=10, day=day)

    report = log.month("2026-11")

    by_model = {item["model"]: item for item in report["items"]}
    assert by_model["gemini-3.5-transcribe-live"]["estimated_usd"] == pytest.approx(0.09)
    assert by_model["custom-model"]["estimated_usd"] is None
    assert report["unpriced"] is True
    assert report["estimated_usd"] == pytest.approx(0.09)


@pytest.mark.parametrize("name", ["", "has space", "../x", "a" * 81])
def test_unsafe_names_and_negative_counts_are_never_stored(tmp_path, name):
    log = UsageLog(tmp_path / "usage.db")
    log.record(name, "gemini-3.6-flash", "analysis", input_tokens=5)
    log.record("gemini", "gemini-3.6-flash", "analysis", input_tokens=-5, output_tokens=True)

    [item] = log.month(usage.current_month())["items"]
    assert (item["input_tokens"], item["output_tokens"]) == (0, 0)


def test_gemini_and_openai_responses_report_tokens_including_thinking(tmp_path):
    usage.use_log(tmp_path)
    response = SimpleNamespace(
        usage_metadata=SimpleNamespace(
            prompt_token_count=100, candidates_token_count=20, thoughts_token_count=30
        )
    )
    usage.report_gemini(response, "gemini-3.6-flash", "live_summary")
    usage.report_gemini(SimpleNamespace(), "gemini-3.6-flash", "live_summary")
    usage.report_openai(
        {"usage": {"prompt_tokens": 7, "completion_tokens": 3}}, "gpt-test", "analysis"
    )
    usage.report_openai({"text": "hi", "duration": 12.5}, "whisper-test", "transcription")
    interaction = SimpleNamespace(
        usage=SimpleNamespace(total_input_tokens=40, total_output_tokens=9, total_thought_tokens=1)
    )
    usage.report_gemini_interaction(interaction, "gemini-3.5-transcribe", "transcription")
    usage.report_gemini_interaction(SimpleNamespace(), "gemini-3.5-transcribe", "transcription")

    items = {
        item["model"]: item
        for item in UsageLog(tmp_path / "usage.db").month(usage.current_month())["items"]
    }
    assert (items["gemini-3.6-flash"]["calls"], items["gemini-3.6-flash"]["output_tokens"]) == (
        1,
        50,
    )
    assert items["gpt-test"]["input_tokens"] == 7
    assert items["whisper-test"]["audio_seconds"] == 12.5
    transcribe = items["gemini-3.5-transcribe"]
    assert (transcribe["calls"], transcribe["input_tokens"], transcribe["output_tokens"]) == (
        1,
        40,
        10,
    )


def test_live_budget_is_reached_only_when_set_and_used_up(tmp_path):
    log = UsageLog(tmp_path / "usage.db")
    log.record("gemini", "gemini-3.6-flash", "analysis", input_tokens=2_000_000)

    assert live_budget_reached(tmp_path, 0) is False
    assert live_budget_reached(tmp_path, 1) is True
    assert live_budget_reached(tmp_path, 5) is False


def test_reporting_never_raises_when_the_log_cannot_be_written(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    usage.use_log(blocker)
    usage.report("gemini", "gemini-3.6-flash", "analysis", input_tokens=1)
