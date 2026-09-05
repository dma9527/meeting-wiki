from __future__ import annotations

import socket
from datetime import UTC, datetime, timedelta

import pytest

from meeting_wiki.providers.base import CalendarEvent
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
    monkeypatch.setattr(provider, "_events", lambda: [event])
    assert provider.match(moment) is event

    overlap = CalendarEvent(
        event_id="event-2",
        title="Overlapping meeting",
        start=moment,
        end=moment + timedelta(minutes=30),
    )
    monkeypatch.setattr(provider, "_events", lambda: [event, overlap])
    assert provider.match(moment) is None

    all_day = CalendarEvent(
        event_id="all-day",
        title="Company holiday",
        start=moment.replace(hour=0),
        end=moment.replace(hour=23),
        all_day=True,
    )
    monkeypatch.setattr(provider, "_events", lambda: [all_day])
    assert provider.match(moment) is None


def test_calendar_event_normalizes_naive_datetimes_to_utc():
    """Naive bounds become tz-aware UTC so brief keys/times are machine-TZ-independent."""
    naive = datetime(2026, 9, 10, 15, 0)
    aware = datetime(2026, 9, 10, 16, 0, tzinfo=UTC)
    event = CalendarEvent(event_id="evt", title="Sync", start=naive, end=aware)
    assert event.start.tzinfo == UTC
    assert event.start == datetime(2026, 9, 10, 15, 0, tzinfo=UTC)
    assert event.end is aware
