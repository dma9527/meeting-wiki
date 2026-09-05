"""Deterministic pre-meeting briefs.

A brief is compiled once from upcoming calendar events and the existing Markdown
wiki. It reads no raw transcripts and calls no LLM or network service beyond the
calendar provider's local ICS file. Output is deterministic and idempotent: the
same event and wiki state always produce identical bytes.

Privacy asymmetry is structural, not advisory:

- A shared event reads only ``wiki/`` (people timelines, the open action table,
  meeting pages) and writes to ``wiki/briefs/``.
- A private-hint or one-on-one event gets a privacy-safe brief built ONLY from
  the event's own metadata. It reads no shared people, action, topic, or meeting
  content, and writes to ``private/briefs/``.
"""

from __future__ import annotations

import re
from datetime import UTC

from .config import AppConfig, PrivacyConfig
from .models import MeetingInput, MeetingType
from .privacy import classify
from .providers.base import CalendarEvent, CalendarProvider, StorageProvider
from .wiki import canonical, frontmatter, inline_text, parse_frontmatter, slugify, stable_id

_MAX_WINDOW_MINUTES = 7 * 24 * 60
_MAX_RELATED_MEETINGS = 5
_MAX_OBJECTIVES = 20
_MAX_OPEN_QUESTIONS = 12
_SOURCE_MARKER = re.compile(r"<!-- source:([^>]+?) -->")
_NONE = "None recorded."


def generate_upcoming_briefs(
    shared_storage: StorageProvider,
    private_storage: StorageProvider,
    calendar: CalendarProvider,
    config: AppConfig,
    within_minutes: int,
) -> list[dict[str, object]]:
    """Write a brief per upcoming event and return a privacy-safe summary.

    Private events never expose their title or attendee list in the summary,
    only the storage key, so a shell transcript of the command leaks nothing.
    """
    window = max(1, min(int(within_minutes), _MAX_WINDOW_MINUTES))
    summary: list[dict[str, object]] = []
    for event in calendar.upcoming(window):
        private = _is_private(event, config.privacy)
        key = _brief_key(event, private)
        if private:
            private_storage.write_text(key, _private_brief(event), private=True)
            summary.append({"privacy": "private", "brief_key": key})
        else:
            shared_storage.write_text(key, _shared_brief(shared_storage, event))
            summary.append(
                {
                    "privacy": "shared",
                    "brief_key": key,
                    "title": event.title,
                    "event_start": _iso(event),
                    "attendees": len(event.attendees),
                }
            )
    return summary


def _is_private(event: CalendarEvent, policy: PrivacyConfig) -> bool:
    if event.private_hint:
        return True
    probe = MeetingInput(
        title=event.title, attendees=list(event.attendees), occurred_at=event.start
    )
    return classify(probe, policy) is MeetingType.ONE_ON_ONE


def _brief_key(event: CalendarEvent, private: bool) -> str:
    date = event.start.astimezone(UTC).strftime("%Y-%m-%d")
    # A private key omits the title slug: the CLI prints it to stdout, so the
    # subject must never appear there. The event id keeps it deterministic.
    if private:
        return f"private/briefs/{date}-{stable_id(event.event_id)}.md"
    stem = f"{date}-{slugify(event.title)}-{stable_id(event.event_id)}"
    return f"wiki/briefs/{stem}.md"


def _iso(event: CalendarEvent) -> str:
    return event.start.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _format_range(event: CalendarEvent) -> tuple[str, str]:
    start = event.start.astimezone(UTC).isoformat().replace("+00:00", "Z")
    end = event.end.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return start, end


def _attendee_line(event: CalendarEvent) -> str:
    names = [inline_text(name) for name in event.attendees if name and name.strip()]
    return ", ".join(names) if names else "None listed."


def _objectives(event: CalendarEvent) -> list[str]:
    """Explicit objectives come only from the event's own description."""
    lines: list[str] = []
    for raw in (event.description or "").splitlines():
        item = inline_text(raw)
        if item:
            lines.append(f"- {item}")
        if len(lines) >= _MAX_OBJECTIVES:
            break
    return lines


def _section(lines: list[str]) -> str:
    return "\n".join(lines) if lines else _NONE


def _private_brief(event: CalendarEvent) -> str:
    start, end = _format_range(event)
    title = inline_text(event.title)
    fields = {
        "attendees": [inline_text(name) for name in event.attendees if name and name.strip()],
        "description": "Privacy-safe brief. No shared wiki history is read for a private meeting.",
        "event_end": end,
        "event_start": start,
        "privacy": "private",
        "tags": ["brief"],
        "timestamp": start,
        "title": f"Brief: {title}",
        "type": "private-brief",
    }
    body = [
        f"# Brief: {title}",
        "",
        "## Event",
        f"- Time: {start} to {end}",
        f"- Attendees: {_attendee_line(event)}",
        "",
        "## Objectives",
        _section(_objectives(event)),
        "",
        "_No shared wiki history is included for a private meeting._",
    ]
    return frontmatter(fields) + "\n".join(body).rstrip() + "\n"


def _shared_brief(storage: StorageProvider, event: CalendarEvent) -> str:
    start, end = _format_range(event)
    title = inline_text(event.title)
    people_lines, related_sources = _participant_history(storage, event.attendees)
    related_lines, related_keys = _related_meetings(storage, related_sources)
    fields = {
        "attendees": [inline_text(name) for name in event.attendees if name and name.strip()],
        "description": f"Pre-meeting brief for {title}.",
        "event_end": end,
        "event_start": start,
        "privacy": "shared",
        "tags": ["brief"],
        "timestamp": start,
        "title": f"Brief: {title}",
        "type": "brief",
    }
    body = [
        f"# Brief: {title}",
        "",
        "## Event",
        f"- Time: {start} to {end}",
        f"- Attendees: {_attendee_line(event)}",
        "",
        "## Objectives",
        _section(_objectives(event)),
        "",
        "## Participant History",
        _section(people_lines),
        "",
        "## Open Action Items",
        _section(_open_actions(storage, event.attendees)),
        "",
        "## Recent Related Meetings",
        _section(related_lines),
        "",
        "## Open Questions",
        _section(_open_questions(storage, related_keys)),
    ]
    return frontmatter(fields) + "\n".join(body).rstrip() + "\n"


def _is_private_page(fields: dict[str, object]) -> bool:
    return str(fields.get("privacy") or "").casefold() == "private" or str(
        fields.get("type") or ""
    ).casefold().startswith("private")


def _is_shared_meeting_source(storage: StorageProvider, source: str) -> bool:
    text = storage.read_text(f"wiki/meetings/{source}.md")
    if text is None:
        return False
    fields, _body = parse_frontmatter(text)
    return not _is_private_page(fields)


def _participant_history(
    storage: StorageProvider, attendees: list[str]
) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    sources: dict[str, None] = {}
    for attendee in attendees:
        if not attendee or not attendee.strip():
            continue
        page = storage.read_text(f"wiki/people/{slugify(attendee)}.md")
        if page is None:
            continue
        page_fields, _body = parse_frontmatter(page)
        if _is_private_page(page_fields):
            continue
        found = sorted(
            {
                match.strip()
                for match in _SOURCE_MARKER.findall(page)
                if match.strip() and _is_shared_meeting_source(storage, match.strip())
            }
        )
        if not found:
            continue
        lines.append(
            f"- **{inline_text(attendee)}**: {len(found)} recorded discussion(s), "
            f"latest by date [[meetings/{found[-1]}]]."
        )
        for source in found:
            sources.setdefault(source, None)
    return lines, list(sources)


def _open_actions(storage: StorageProvider, attendees: list[str]) -> list[str]:
    text = storage.read_text("wiki/action-items/active.md")
    if not text:
        return []
    owners = {canonical(inline_text(name)) for name in attendees if name and name.strip()}
    lines: list[str] = []
    for line in text.splitlines():
        if not line.startswith("|") or line.startswith("| Owner") or line.startswith("|---"):
            continue
        columns = [column.strip() for column in line.strip("|").split("|")]
        if len(columns) < 5 or columns[4] == "done" or canonical(columns[0]) not in owners:
            continue
        due = f" (due: {columns[3]})" if columns[3] else ""
        source = f" {columns[2]}" if columns[2] else ""
        lines.append(f"- **{columns[0]}**: {columns[1]}{due}{source}")
    return sorted(lines)


def _related_meetings(storage: StorageProvider, sources: list[str]) -> tuple[list[str], list[str]]:
    items: list[tuple[str, str, str, str]] = []
    for source in sources:
        key = f"wiki/meetings/{source}.md"
        text = storage.read_text(key)
        if text is None:
            continue
        fields, _ = parse_frontmatter(text)
        if _is_private_page(fields):
            continue
        timestamp = str(fields.get("timestamp") or "")
        title = inline_text(str(fields.get("title") or source))
        items.append((timestamp, source, title, key))
    items.sort(reverse=True)
    top = items[:_MAX_RELATED_MEETINGS]
    lines = [
        f"- [[meetings/{source}]] {title} ({timestamp or 'no timestamp'})"
        for timestamp, source, title, _key in top
    ]
    return lines, [key for _timestamp, _source, _title, key in top]


def _open_questions(storage: StorageProvider, meeting_keys: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for key in meeting_keys:
        text = storage.read_text(key)
        if text is None:
            continue
        for question in _section_bullets(text, "Open Questions"):
            seen.setdefault(question, None)
            if len(seen) >= _MAX_OPEN_QUESTIONS:
                return [f"- {question}" for question in seen]
    return [f"- {question}" for question in seen]


def _section_bullets(text: str, heading: str) -> list[str]:
    bullets: list[str] = []
    in_section = False
    for line in text.splitlines():
        if line.startswith("## "):
            in_section = line[3:].strip().casefold() == heading.casefold()
            continue
        if in_section and line.startswith("- "):
            item = line[2:].strip()
            if item and item != _NONE:
                bullets.append(item)
    return bullets
