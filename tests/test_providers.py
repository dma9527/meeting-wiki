from __future__ import annotations

import socket
from datetime import UTC, datetime, timedelta

import pytest

from meeting_wiki.providers.base import (
    CalendarEvent,
    TranscriptionCapabilities,
    TranscriptionContext,
)
from meeting_wiki.providers.calendar import ICSCalendarProvider
from meeting_wiki.providers.integrations import validate_webhook_url
from meeting_wiki.providers.s3_storage import S3Storage
from meeting_wiki.providers.transcription import TextImportTranscriber


def test_text_import_detects_speaker_labels(tmp_path):
    path = tmp_path / "meeting.txt"
    path.write_text("Alex: hello\nSam: hi")
    result = TextImportTranscriber().transcribe(path, "en")
    assert result.diarized is True
    assert result.language == "en"
    assert result.text.startswith("Alex")


def test_webhook_requires_https():
    with pytest.raises(ValueError, match="https"):
        validate_webhook_url("http://example.com/hook")
    with pytest.raises(ValueError, match="https"):
        validate_webhook_url("file:///etc/passwd")


def test_webhook_rejects_private_resolution(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))],
    )
    with pytest.raises(ValueError, match="private/reserved"):
        validate_webhook_url("https://internal.example/hook")
    validate_webhook_url("https://internal.example/hook", allow_private_networks=True)


def test_s3_provider_hard_blocks_private_prefix_without_network():
    provider = object.__new__(S3Storage)
    provider.prefix = "meeting-wiki/"
    with pytest.raises(PermissionError, match="Private"):
        provider._key("private/meetings/secret.md")
    with pytest.raises(PermissionError, match="Private"):
        provider.write_text("private/meetings/secret.md", "secret", private=True)


def test_webhook_rejects_ipv4_mapped_private_address(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::ffff:169.254.169.254", 443, 0, 0))
        ],
    )
    with pytest.raises(ValueError, match="private/reserved"):
        validate_webhook_url("https://rebind.example/hook")


def test_ics_event_parses_description_for_objectives(tmp_path):
    icalendar = pytest.importorskip("icalendar")
    assert icalendar  # provider imports it lazily
    path = tmp_path / "calendar.ics"
    path.write_text(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\n"
        "BEGIN:VEVENT\r\nUID:evt-desc-1\r\nSUMMARY:Design review\r\n"
        "DTSTART:20260910T150000Z\r\nDTEND:20260910T160000Z\r\n"
        "DESCRIPTION:Objective one\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    events = ICSCalendarProvider(path)._events()
    assert len(events) == 1
    assert events[0].title == "Design review"
    assert "Objective one" in events[0].description


def test_calendar_match_requires_one_non_all_day_candidate(tmp_path, monkeypatch):
    provider = ICSCalendarProvider(tmp_path / "calendar.ics")
    moment = datetime(2026, 9, 4, 15, 5, tzinfo=UTC)
    event = CalendarEvent(
        event_id="event-1",
        title="Design review",
        start=moment - timedelta(minutes=5),
        end=moment + timedelta(minutes=55),
    )
    monkeypatch.setattr(provider, "_events", lambda *_window: [event])
    assert provider.match(moment) is event

    overlap = CalendarEvent(
        event_id="event-2",
        title="Overlapping meeting",
        start=moment,
        end=moment + timedelta(minutes=30),
    )
    monkeypatch.setattr(provider, "_events", lambda *_window: [event, overlap])
    assert provider.match(moment) is None

    all_day = CalendarEvent(
        event_id="all-day",
        title="Company holiday",
        start=moment.replace(hour=0),
        end=moment.replace(hour=23),
        all_day=True,
    )
    monkeypatch.setattr(provider, "_events", lambda *_window: [all_day])
    assert provider.match(moment) is None


def _write_ics(path, *events):
    body = "".join(f"BEGIN:VEVENT\r\n{event}END:VEVENT\r\n" for event in events)
    path.write_text(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\n"
        f"{body}END:VCALENDAR\r\n"
    )
    return path


def test_ics_expands_weekly_rrule_and_honors_exdate(tmp_path):
    pytest.importorskip("icalendar")
    path = _write_ics(
        tmp_path / "calendar.ics",
        "UID:weekly-sync\r\nSUMMARY:Platform sync\r\n"
        "DTSTART:20260902T150000Z\r\nDTEND:20260902T153000Z\r\n"
        "RRULE:FREQ=WEEKLY;COUNT=10\r\nEXDATE:20260916T150000Z\r\n",
    )
    provider = ICSCalendarProvider(path)

    third_week = provider.match(datetime(2026, 9, 23, 15, 3, tzinfo=UTC))
    assert third_week is not None
    assert third_week.title == "Platform sync"
    assert third_week.start == datetime(2026, 9, 23, 15, 0, tzinfo=UTC)
    assert third_week.end == datetime(2026, 9, 23, 15, 30, tzinfo=UTC)
    assert third_week.event_id != "weekly-sync"
    assert third_week.event_id.startswith("weekly-sync")

    assert provider.match(datetime(2026, 9, 16, 15, 3, tzinfo=UTC)) is None
    # COUNT=10 ends the series on 2026-11-04.
    assert provider.match(datetime(2026, 11, 11, 15, 3, tzinfo=UTC)) is None


def test_ics_rrule_with_tzid_and_until_and_moved_override(tmp_path):
    pytest.importorskip("icalendar")
    path = _write_ics(
        tmp_path / "calendar.ics",
        "UID:daily-standup\r\nSUMMARY:Team standup\r\n"
        "DTSTART;TZID=America/New_York:20260907T090000\r\n"
        "DTEND;TZID=America/New_York:20260907T091500\r\n"
        "RRULE:FREQ=DAILY;UNTIL=20260911T130000Z\r\n",
        "UID:daily-standup\r\nSUMMARY:Team standup (moved)\r\n"
        "RECURRENCE-ID;TZID=America/New_York:20260909T090000\r\n"
        "DTSTART;TZID=America/New_York:20260909T140000\r\n"
        "DTEND;TZID=America/New_York:20260909T141500\r\n",
    )
    provider = ICSCalendarProvider(path)

    # 09:00 EDT is 13:00 UTC.
    tuesday = provider.match(datetime(2026, 9, 8, 13, 2, tzinfo=UTC))
    assert tuesday is not None and tuesday.start == datetime(2026, 9, 8, 13, 0, tzinfo=UTC)
    assert provider.match(datetime(2026, 9, 9, 13, 2, tzinfo=UTC)) is None
    moved = provider.match(datetime(2026, 9, 9, 18, 2, tzinfo=UTC))
    assert moved is not None and moved.title == "Team standup (moved)"
    assert provider.match(datetime(2026, 9, 12, 13, 2, tzinfo=UTC)) is None


def test_ics_duration_and_missing_dtend_are_safe(tmp_path):
    pytest.importorskip("icalendar")
    path = _write_ics(
        tmp_path / "calendar.ics",
        "UID:with-duration\r\nSUMMARY:Long review\r\n"
        "DTSTART:20260910T150000Z\r\nDURATION:PT2H\r\n",
        "UID:no-end\r\nSUMMARY:Quick chat\r\nDTSTART:20260911T150000Z\r\n",
        "UID:all-day-no-end\r\nSUMMARY:Offsite\r\nDTSTART;VALUE=DATE:20260912\r\n",
    )
    provider = ICSCalendarProvider(path)

    long_review = provider.match(datetime(2026, 9, 10, 16, 30, tzinfo=UTC))
    assert long_review is not None
    assert long_review.end == datetime(2026, 9, 10, 17, 0, tzinfo=UTC)

    quick = provider.match(datetime(2026, 9, 11, 15, 10, tzinfo=UTC))
    assert quick is not None and quick.end == quick.start
    assert provider.match(datetime(2026, 9, 11, 16, 0, tzinfo=UTC)) is None

    all_day = [event for event in provider._events() if event.event_id == "all-day-no-end"]
    assert all_day[0].all_day is True
    assert all_day[0].end - all_day[0].start == timedelta(days=1)


def test_ics_private_hint_uses_configured_privacy_terms(tmp_path):
    pytest.importorskip("icalendar")
    from meeting_wiki.config import PrivacyConfig

    path = _write_ics(
        tmp_path / "calendar.ics",
        "UID:mentoring\r\nSUMMARY:Mentoring session\r\n"
        "DTSTART:20260910T150000Z\r\nDTEND:20260910T160000Z\r\n",
        "UID:skip-level\r\nSUMMARY:Skip-level with director\r\n"
        "DTSTART:20260911T150000Z\r\nDTEND:20260911T160000Z\r\n",
        "UID:planning\r\nSUMMARY:Quarterly planning\r\n"
        "DTSTART:20260912T150000Z\r\nDTEND:20260912T160000Z\r\n",
    )
    default = {event.event_id: event.private_hint for event in ICSCalendarProvider(path)._events()}
    assert default == {"mentoring": False, "skip-level": True, "planning": False}

    custom = PrivacyConfig(private_terms=["mentoring"])
    configured = {
        event.event_id: event.private_hint
        for event in ICSCalendarProvider(path, custom)._events()
    }
    # Explicit 1:1 phrasing stays private; configured terms replace the defaults.
    assert configured == {"mentoring": True, "skip-level": False, "planning": False}


def test_registry_builds_ics_calendar_with_configured_privacy(tmp_path):
    from meeting_wiki.cli import _build_calendar
    from meeting_wiki.config import AppConfig

    config = AppConfig.model_validate(
        {
            "data_dir": str(tmp_path),
            "providers": {"calendar": "ics"},
            "ics": {"path": str(tmp_path / "calendar.ics")},
            "privacy": {"private_terms": ["mentoring"]},
        }
    )
    provider = _build_calendar(config)
    assert provider.privacy.private_terms == ["mentoring"]


def test_calendar_event_normalizes_naive_datetimes_to_utc():
    """Naive bounds become tz-aware UTC so brief keys/times are machine-TZ-independent."""
    naive = datetime(2026, 9, 10, 15, 0)
    aware = datetime(2026, 9, 10, 16, 0, tzinfo=UTC)
    event = CalendarEvent(event_id="evt", title="Sync", start=naive, end=aware)
    assert event.start.tzinfo == UTC
    assert event.start == datetime(2026, 9, 10, 15, 0, tzinfo=UTC)
    assert event.end is aware


def test_transcription_context_and_capabilities_are_typed_and_immutable():
    context = TranscriptionContext(
        expected_speakers=("Alex", "Sam"),
        hotwords=("Meeting Wiki", "VibeVoice"),
        meeting_title="ASR review",
    )
    capabilities = TranscriptionCapabilities(
        diarization=True,
        timestamps=True,
        hotwords=True,
        max_duration_minutes=60,
        hardware="cpu",
    )
    assert context.expected_speakers == ("Alex", "Sam")
    assert capabilities.max_duration_minutes == 60
    with pytest.raises((AttributeError, TypeError)):
        context.hotwords = ()


def test_live_provider_contracts_are_runtime_checkable():
    from meeting_wiki.providers.base import LiveLanguageProvider, LiveTranscriptionProvider

    assert isinstance(LiveTranscriptionProvider, type)
    assert isinstance(LiveLanguageProvider, type)


def test_live_provider_selection_rejects_unknown_provider():
    from meeting_wiki.config import AppConfig
    from meeting_wiki.providers.registry import validate_live_provider_selection

    validate_live_provider_selection(AppConfig())
    config = AppConfig.model_validate({"providers": {"live_language": "unknown"}})
    with pytest.raises(ValueError, match="Unknown live language provider"):
        validate_live_provider_selection(config)


def test_live_provider_selection_accepts_gemini():
    from meeting_wiki.config import AppConfig
    from meeting_wiki.providers.registry import validate_live_provider_selection

    config = AppConfig.model_validate(
        {
            "providers": {"live_transcription": "gemini", "live_language": "gemini"},
            "live": {"allow_external_providers": True},
            "gemini": {
                "batch_audio_model": "gemini-3.5-transcribe",
                "live_model": "gemini-3.5-transcribe-live",
                "language_model": "gemini-test-language",
            },
        }
    )
    validate_live_provider_selection(config)


def test_registry_builds_default_local_live_providers():
    from meeting_wiki.config import AppConfig
    from meeting_wiki.providers.base import LiveLanguageProvider, LiveTranscriptionProvider
    from meeting_wiki.providers.live import ChunkedMLXWhisperProvider, OllamaLiveLanguageProvider
    from meeting_wiki.providers.registry import build_providers

    config = AppConfig.model_validate(
        {
            "mlx_whisper": {"model": "test-mlx-model"},
            "ollama": {"base_url": "http://127.0.0.1:11434/", "model": "test-ollama-model"},
        }
    )

    bundle = build_providers(config)

    assert isinstance(bundle.live_transcription, ChunkedMLXWhisperProvider)
    assert isinstance(bundle.live_transcription, LiveTranscriptionProvider)
    assert bundle.live_transcription._batch.model == "test-mlx-model"
    assert isinstance(bundle.live_language, OllamaLiveLanguageProvider)
    assert isinstance(bundle.live_language, LiveLanguageProvider)
    assert bundle.live_language.base_url == "http://127.0.0.1:11434"
    assert bundle.live_language.model == "test-ollama-model"
    assert bundle.live_language.timeout == config.ollama.timeout_seconds


def test_registry_leaves_unimplemented_live_selections_unbuilt(monkeypatch):
    from meeting_wiki.config import AppConfig
    from meeting_wiki.providers.registry import build_providers

    monkeypatch.setenv("MEETING_WIKI_GEMINI_API_KEY", "test-gemini-key-not-real")
    config = AppConfig.model_validate(
        {
            "providers": {
                "live_transcription": "openai_compatible",
                "live_language": "openai_compatible",
            },
            "live": {"allow_external_providers": True},
            "gemini": {"language_model": "test-gemini-language-model"},
        }
    )

    bundle = build_providers(config)

    assert bundle.live_transcription is None
    assert bundle.live_language is None


def test_session_live_contract_is_distinct_from_chunked_contract():
    from meeting_wiki.providers.base import (
        LiveSessionTranscriptionProvider,
        LiveTranscriptEvent,
        LiveTranscriptionSession,
        LiveTranscriptKind,
    )
    from meeting_wiki.providers.live import ChunkedMLXWhisperProvider

    event = LiveTranscriptEvent(kind=LiveTranscriptKind.FINAL, text="hello")
    assert event.is_final is True
    assert LiveTranscriptEvent(LiveTranscriptKind.INTERIM, "he").is_final is False
    with pytest.raises((AttributeError, TypeError)):
        event.text = "changed"
    assert isinstance(LiveTranscriptionSession, type)
    assert not isinstance(
        ChunkedMLXWhisperProvider("test-mlx-model"), LiveSessionTranscriptionProvider
    )
