"""Calendar providers. None/manual is the privacy-preserving default."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from .base import CalendarEvent


class NoneCalendarProvider:
    name = "none"

    def upcoming(self, within_minutes: int) -> list[CalendarEvent]:
        return []


class ICSCalendarProvider:
    name = "ics"

    def __init__(self, path: Path):
        if path is None:
            raise ValueError("ICS path is required")
        self.path = path

    def upcoming(self, within_minutes: int) -> list[CalendarEvent]:
        try:
            from icalendar import Calendar
        except ImportError as error:
            raise RuntimeError("Install meeting-wiki[ics] to use ICS calendar") from error
        calendar = Calendar.from_ical(self.path.read_bytes())
        now = datetime.now(UTC)
        end_window = now + timedelta(minutes=within_minutes)
        events = []
        for component in calendar.walk("VEVENT"):
            start = component.decoded("DTSTART")
            end = component.decoded("DTEND")
            if not isinstance(start, datetime):
                start = datetime.combine(start, datetime.min.time(), tzinfo=UTC)
            if not isinstance(end, datetime):
                end = datetime.combine(end, datetime.min.time(), tzinfo=UTC)
            if start.tzinfo is None:
                start = start.replace(tzinfo=UTC)
            if end.tzinfo is None:
                end = end.replace(tzinfo=UTC)
            if not now <= start.astimezone(UTC) <= end_window:
                continue
            attendees = []
            for attendee in component.get("ATTENDEE", []):
                common_name = attendee.params.get("CN") if hasattr(attendee, "params") else None
                attendees.append(str(common_name or attendee))
            title = str(component.get("SUMMARY", "Untitled meeting"))
            lowered = title.lower()
            events.append(
                CalendarEvent(
                    event_id=str(component.get("UID", title + start.isoformat())),
                    title=title,
                    start=start,
                    end=end,
                    attendees=attendees,
                    private_hint=any(term in lowered for term in ("1:1", "one-on-one", "career")),
                )
            )
        return sorted(events, key=lambda event: event.start)
