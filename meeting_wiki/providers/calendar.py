"""Calendar providers. None/manual is the privacy-preserving default."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

from ..config import PrivacyConfig
from ..privacy import title_has_private_terms
from .base import CalendarEvent

# Fail closed instead of silently dropping a pathological series that could hide a private hint.
_MAX_OCCURRENCE_SCAN = 50_000


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


def _as_utc(value: date | datetime, default_tz=UTC) -> datetime:
    if not isinstance(value, datetime):
        value = datetime.combine(value, time.min, tzinfo=default_tz)
    if value.tzinfo is None:
        value = value.replace(tzinfo=default_tz)
    return value.astimezone(UTC)


def _date_values(component, name: str) -> list[date | datetime]:
    raw = component.get(name)
    if raw is None:
        return []
    groups = raw if isinstance(raw, list) else [raw]
    values: list[date | datetime] = []
    for group in groups:
        for item in getattr(group, "dts", []):
            values.append(item.dt)
    return values


def _bounds(component) -> tuple[datetime, datetime, bool, datetime]:
    """Return UTC start/end, all-day flag, and the zone-aware local start for expansion."""
    decoded_start = component.decoded("DTSTART")
    all_day = not isinstance(decoded_start, datetime)
    local_start = (
        datetime.combine(decoded_start, time.min, tzinfo=UTC) if all_day else decoded_start
    )
    if local_start.tzinfo is None:
        local_start = local_start.replace(tzinfo=UTC)
    if component.get("DTEND") is not None:
        end = _as_utc(component.decoded("DTEND"), local_start.tzinfo)
    elif component.get("DURATION") is not None:
        end = local_start.astimezone(UTC) + component.decoded("DURATION")
    else:
        # RFC 5545: no DTEND/DURATION means one day for dates, zero length for times.
        end = local_start.astimezone(UTC) + (timedelta(days=1) if all_day else timedelta())
    start = local_start.astimezone(UTC)
    return start, max(end, start), all_day, local_start


def _rule_text(component, local_start: datetime) -> list[str]:
    raw = component.get("RRULE")
    rules = raw if isinstance(raw, list) else [raw]
    texts = []
    for rule in rules:
        until = rule.get("UNTIL")
        parts = [
            part
            for part in rule.to_ical().decode().split(";")
            if part and not part.upper().startswith("UNTIL=")
        ]
        if until:
            value = until[0]
            if not isinstance(value, datetime):
                value = datetime.combine(value, time.max, tzinfo=local_start.tzinfo)
            elif value.tzinfo is None:
                value = value.replace(tzinfo=local_start.tzinfo)
            parts.append(f"UNTIL={value.astimezone(UTC):%Y%m%dT%H%M%SZ}")
        texts.append(";".join(parts))
    return texts


def _occurrences(
    component,
    local_start: datetime,
    window_start: datetime,
    window_end: datetime,
) -> list[datetime]:
    from dateutil.rrule import rruleset, rrulestr

    series = rruleset()
    for text in _rule_text(component, local_start):
        series.rrule(rrulestr(text, dtstart=local_start))
    for value in _date_values(component, "RDATE"):
        series.rdate(_as_utc(value, local_start.tzinfo))
    for value in _date_values(component, "EXDATE"):
        series.exdate(_as_utc(value, local_start.tzinfo))
    found: list[datetime] = []
    for scanned, occurrence in enumerate(series):
        if scanned >= _MAX_OCCURRENCE_SCAN:
            raise ValueError("Calendar recurrence is too dense to expand safely")
        moment = occurrence.astimezone(UTC)
        if moment > window_end:
            break
        if moment >= window_start:
            found.append(moment)
    return found


class ICSCalendarProvider:
    name = "ics"

    def __init__(self, path: Path, privacy: PrivacyConfig | None = None):
        if path is None:
            raise ValueError("ICS path is required")
        self.path = path
        self.privacy = privacy or PrivacyConfig()

    def _event(
        self,
        component,
        start: datetime,
        end: datetime,
        all_day: bool,
        event_id: str,
    ) -> CalendarEvent:
        attendee_values = component.get("ATTENDEE", [])
        if not isinstance(attendee_values, list):
            attendee_values = [attendee_values]
        attendees = []
        for attendee in attendee_values:
            common_name = attendee.params.get("CN") if hasattr(attendee, "params") else None
            attendees.append(str(common_name or attendee))
        title = str(component.get("SUMMARY", "Untitled meeting"))
        return CalendarEvent(
            event_id=event_id,
            title=title,
            start=start,
            end=end,
            attendees=attendees,
            private_hint=title_has_private_terms(title, self.privacy),
            all_day=all_day,
            description=str(component.get("DESCRIPTION", "")),
        )

    def _events(
        self,
        window_start: datetime | None = None,
        window_end: datetime | None = None,
    ) -> list[CalendarEvent]:
        """Events overlapping the window; recurring series expand only when a window is given."""
        try:
            from icalendar import Calendar
        except ImportError as error:
            raise RuntimeError("Install meeting-wiki[ics] to use ICS calendar") from error
        calendar = Calendar.from_ical(self.path.read_bytes())
        masters = []
        overrides: dict[tuple[str, datetime], object] = {}
        for component in calendar.walk("VEVENT"):
            if component.get("DTSTART") is None:
                continue
            uid = str(component.get("UID", ""))
            if component.get("RECURRENCE-ID") is not None:
                original = _as_utc(component.decoded("RECURRENCE-ID"))
                overrides[(uid, original)] = component
            else:
                masters.append(component)

        def overlaps(start: datetime, end: datetime) -> bool:
            if window_start is None or window_end is None:
                return True
            return start <= window_end and end >= window_start

        def cancelled(component) -> bool:
            return str(component.get("STATUS", "")).upper() == "CANCELLED"

        events: list[CalendarEvent] = []
        for component in masters:
            start, end, all_day, local_start = _bounds(component)
            uid = str(component.get("UID", ""))
            summary = str(component.get("SUMMARY", "Untitled meeting"))
            fallback_id = uid or summary + start.isoformat()
            recurring = component.get("RRULE") is not None or component.get("RDATE") is not None
            if not recurring or window_start is None or window_end is None:
                if not cancelled(component) and overlaps(start, end):
                    events.append(self._event(component, start, end, all_day, fallback_id))
                continue
            duration = end - start
            for occurrence in _occurrences(
                component, local_start, window_start - duration, window_end
            ):
                occurrence_id = f"{fallback_id}/{occurrence:%Y%m%dT%H%M%SZ}"
                override = overrides.pop((uid, occurrence), None)
                source = override if override is not None else component
                if cancelled(source):
                    continue
                if override is not None:
                    o_start, o_end, o_all_day, _ = _bounds(override)
                else:
                    o_start, o_end, o_all_day = occurrence, occurrence + duration, all_day
                if overlaps(o_start, o_end):
                    events.append(self._event(source, o_start, o_end, o_all_day, occurrence_id))
        # Moved instances whose original slot fell outside the window.
        for (uid, original), component in overrides.items():
            if cancelled(component):
                continue
            start, end, all_day, _ = _bounds(component)
            if window_start is not None and window_end is not None and overlaps(start, end):
                events.append(
                    self._event(component, start, end, all_day, f"{uid}/{original:%Y%m%dT%H%M%SZ}")
                )
        return sorted(events, key=lambda event: event.start)

    def upcoming(self, within_minutes: int) -> list[CalendarEvent]:
        now = datetime.now(UTC)
        end_window = now + timedelta(minutes=within_minutes)
        return [
            event
            for event in self._events(now, end_window)
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
            for event in self._events(moment - tolerance, moment + tolerance)
            if not event.all_day and event.start - tolerance <= moment <= event.end + tolerance
        ]
        return candidates[0] if len(candidates) == 1 else None
