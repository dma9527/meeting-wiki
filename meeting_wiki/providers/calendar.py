"""Calendar providers. None/manual is the privacy-preserving default."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from .base import CalendarEvent


class NoneCalendarProvider:
    name = "none"

    def upcoming(self, within_minutes: int) -> list[CalendarEvent]:
        return []

    def match(
        self,
        occurred_at: datetime,
        tolerance_minutes: int = 15,
    ) -> CalendarEvent | None:
        return None


class ICSCalendarProvider:
    name = "ics"

    def __init__(self, path: Path):
        if path is None:
            raise ValueError("ICS path is required")
        self.path = path

    def _events(self) -> list[CalendarEvent]:
        try:
            from icalendar import Calendar
        except ImportError as error:
            raise RuntimeError("Install meeting-wiki[ics] to use ICS calendar") from error
        calendar = Calendar.from_ical(self.path.read_bytes())
        events = []
        for component in calendar.walk("VEVENT"):
            decoded_start = component.decoded("DTSTART")
            decoded_end = component.decoded("DTEND")
            all_day = not isinstance(decoded_start, datetime)
            start = decoded_start
            end = decoded_end
            if not isinstance(start, datetime):
                start = datetime.combine(start, datetime.min.time(), tzinfo=UTC)
            if not isinstance(end, datetime):
                end = datetime.combine(end, datetime.min.time(), tzinfo=UTC)
            if start.tzinfo is None:
                start = start.replace(tzinfo=UTC)
            if end.tzinfo is None:
                end = end.replace(tzinfo=UTC)
            attendee_values = component.get("ATTENDEE", [])
            if not isinstance(attendee_values, list):
                attendee_values = [attendee_values]
            attendees = []
            for attendee in attendee_values:
                common_name = attendee.params.get("CN") if hasattr(attendee, "params") else None
                attendees.append(str(common_name or attendee))
            title = str(component.get("SUMMARY", "Untitled meeting"))
            lowered = title.lower()
            events.append(
                CalendarEvent(
                    event_id=str(component.get("UID", title + start.isoformat())),
                    title=title,
                    start=start.astimezone(UTC),
                    end=end.astimezone(UTC),
                    attendees=attendees,
                    private_hint=any(term in lowered for term in ("1:1", "one-on-one", "career")),
                    all_day=all_day,
                    description=str(component.get("DESCRIPTION", "")),
                )
            )
        return sorted(events, key=lambda event: event.start)

    def upcoming(self, within_minutes: int) -> list[CalendarEvent]:
        now = datetime.now(UTC)
        end_window = now + timedelta(minutes=within_minutes)
        return [
            event
            for event in self._events()
            if not event.all_day and now <= event.start <= end_window
        ]

    def match(
        self,
        occurred_at: datetime,
        tolerance_minutes: int = 15,
    ) -> CalendarEvent | None:
        moment = occurred_at if occurred_at.tzinfo else occurred_at.replace(tzinfo=UTC)
        moment = moment.astimezone(UTC)
        tolerance = timedelta(minutes=tolerance_minutes)
        candidates = [
            event
            for event in self._events()
            if not event.all_day and event.start - tolerance <= moment <= event.end + tolerance
        ]
        return candidates[0] if len(candidates) == 1 else None
