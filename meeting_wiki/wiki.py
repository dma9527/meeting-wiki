"""Deterministic Markdown rendering. LLMs never write whole pages."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC

from .models import ActionItem, MeetingAnalysis, MeetingInput, MeetingType
from .providers.base import StorageProvider

SECTION_ORDER: dict[MeetingType, list[str]] = {
    MeetingType.STANDUP: [
        "Summary",
        "Status by Person",
        "Blockers",
        "Coordination",
        "Action Items",
        "Decisions",
        "Open Questions",
    ],
    MeetingType.DESIGN_REVIEW: [
        "Summary",
        "Problem and Constraints",
        "Alternatives Considered",
        "Decision and Rationale",
        "Risks and Trade-offs",
        "Open Questions",
        "Action Items",
    ],
    MeetingType.CUSTOMER: [
        "Summary",
        "Customer Context and Goals",
        "Pain Points",
        "Feedback and Requests",
        "Commitments Made",
        "Risks",
        "Follow-up",
    ],
    MeetingType.GENERIC: [
        "Summary",
        "Participants",
        "Decisions",
        "Action Items",
        "Topics",
        "Open Questions",
    ],
    MeetingType.ONE_ON_ONE: [
        "Context",
        "Discussion",
        "Private Commitments",
        "Follow-ups for Me",
        "Open Questions",
    ],
}


def slugify(value: str, fallback: str = "untitled") -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    if slug:
        return slug[:100]
    # Distinct non-Latin names/topics must never collapse into one shared
    # `untitled.md` page. Hash the original Unicode value deterministically.
    return f"{fallback}-{hashlib.sha256(value.encode()).hexdigest()[:10]}"


def inline_text(value: str) -> str:
    """Collapse control/newline/table delimiters while preserving readable text."""
    return " ".join(value.replace("|", "&#124;").split())


def stable_id(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode()).hexdigest()[:16]


def yaml_scalar(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def frontmatter(fields: dict[str, str | list[str]]) -> str:
    lines = ["---"]
    for key in sorted(fields):
        value = fields[key]
        if isinstance(value, list):
            rendered = ", ".join(yaml_scalar(item) for item in sorted(set(value)))
            lines.append(f"{key}: [{rendered}]")
        else:
            lines.append(f"{key}: {yaml_scalar(value)}")
    lines += ["---", ""]
    return "\n".join(lines)


def bullet_list(items: list[str], empty: str = "None recorded.") -> str:
    cleaned = [inline_text(item) for item in items if item and item.strip()]
    return "\n".join(f"- {item}" for item in cleaned) if cleaned else empty


def action_lines(items: list[ActionItem]) -> list[str]:
    return [
        f"- [{'x' if item.done else ' '}] **{inline_text(item.owner)}**: "
        f"{inline_text(item.action)}" + (f" (due: {inline_text(item.due)})" if item.due else "")
        for item in items
    ]


def meeting_sections(analysis: MeetingAnalysis) -> dict[str, str]:
    participants = [
        f"**{participant.name}**" + (f" ({participant.role})" if participant.role else "")
        for participant in analysis.participants
    ]
    decisions = [
        f"**{decision.title}**: {decision.decision}"
        + (f" Rationale: {decision.rationale}" if decision.rationale else "")
        for decision in analysis.decisions
    ]
    topics = [f"**{topic.topic}**: {topic.insight}" for topic in analysis.topics]
    actions = action_lines(analysis.action_items)
    base = {
        "Summary": bullet_list(analysis.summary),
        "Participants": bullet_list(participants),
        "Status by Person": bullet_list(participants),
        "Blockers": bullet_list(analysis.blockers),
        "Coordination": bullet_list(topics),
        "Action Items": "\n".join(actions) if actions else "None recorded.",
        "Decisions": bullet_list(decisions),
        "Decision and Rationale": bullet_list(decisions),
        "Topics": bullet_list(topics),
        "Open Questions": bullet_list(analysis.open_questions),
        "Risks": bullet_list(analysis.risks),
        "Risks and Trade-offs": bullet_list(analysis.risks),
        "Problem and Constraints": bullet_list(analysis.blockers + analysis.summary[:1]),
        "Alternatives Considered": bullet_list(analysis.open_questions),
        "Customer Context and Goals": bullet_list(analysis.summary[:2]),
        "Pain Points": bullet_list(analysis.blockers),
        "Feedback and Requests": bullet_list(topics),
        "Commitments Made": "\n".join(actions) if actions else "None recorded.",
        "Follow-up": "\n".join(actions) if actions else "None recorded.",
        "Context": bullet_list(analysis.summary[:2]),
        "Discussion": bullet_list(analysis.summary),
        "Private Commitments": "\n".join(actions) if actions else "None recorded.",
        "Follow-ups for Me": "\n".join(actions) if actions else "None recorded.",
    }
    return base


def render_meeting(meeting: MeetingInput, analysis: MeetingAnalysis, source_key: str) -> str:
    occurred = meeting.occurred_at.astimezone(UTC)
    meeting_type = analysis.meeting_type
    fields = {
        "description": analysis.summary[0],
        "meeting_type": meeting_type.value,
        "privacy": "private" if analysis.private else "shared",
        "resource": source_key,
        "tags": [slugify(topic.topic) for topic in analysis.topics],
        "timestamp": occurred.isoformat().replace("+00:00", "Z"),
        "title": analysis.title,
        "type": "private-meeting" if analysis.private else "meeting",
    }
    sections = meeting_sections(analysis)
    content = [frontmatter(fields), f"# {inline_text(analysis.title)}", ""]
    for section in SECTION_ORDER[meeting_type]:
        content += [f"## {section}", sections.get(section, "None recorded."), ""]
    return "\n".join(content).rstrip() + "\n"


def append_timeline(
    existing: str | None, title: str, page_type: str, source: str, entry: str
) -> str:
    marker = f"<!-- source:{source} -->"
    if existing and marker in existing:
        return existing
    safe_title = inline_text(title)
    if existing:
        base = existing.rstrip() + "\n\n"
    else:
        base = (
            frontmatter(
                {
                    "description": f"Evolving {page_type} knowledge for {safe_title}.",
                    "tags": [],
                    "timestamp": "",
                    "title": safe_title,
                    "type": page_type,
                }
            )
            + f"# {safe_title}\n\n## Timeline\n"
        )
    return base + f"\n{marker}\n### {source}\n\n{entry.strip()}\n"


@dataclass
class RenderResult:
    meeting_key: str
    written_keys: list[str]


class WikiRenderer:
    def __init__(self, storage: StorageProvider):
        self.storage = storage

    def apply(
        self, meeting: MeetingInput, analysis: MeetingAnalysis, transcript_key: str
    ) -> RenderResult:
        occurred = meeting.occurred_at.astimezone(UTC)
        date = occurred.strftime("%Y-%m-%d")
        source = f"{date}-{slugify(meeting.title)}-{stable_id(transcript_key)}"
        if analysis.private or analysis.meeting_type is MeetingType.ONE_ON_ONE:
            key = f"private/meetings/{source}.md"
            content = render_meeting(
                meeting, analysis.model_copy(update={"private": True}), transcript_key
            )
            self.storage.write_text(key, content, private=True)
            return RenderResult(meeting_key=key, written_keys=[key])

        meeting_key = f"wiki/meetings/{source}.md"
        written = [meeting_key]
        self.storage.write_text(meeting_key, render_meeting(meeting, analysis, transcript_key))

        for participant in analysis.participants:
            key = f"wiki/people/{slugify(participant.name)}.md"
            existing = self.storage.read_text(key)
            entry = f"Discussed in [[meetings/{source}]].\n\n{bullet_list(analysis.summary[:3])}"
            self.storage.write_text(
                key, append_timeline(existing, participant.name, "person", source, entry)
            )
            written.append(key)

        for topic in analysis.topics:
            key = f"wiki/topics/{slugify(topic.topic)}.md"
            existing = self.storage.read_text(key)
            entry = f"{topic.insight} (from [[meetings/{source}]])"
            self.storage.write_text(
                key, append_timeline(existing, topic.topic, "topic", source, entry)
            )
            written.append(key)

        for decision in analysis.decisions:
            decision_id = stable_id(source, decision.title)
            key = f"wiki/decisions/{date}-{slugify(decision.title)}-{decision_id}.md"
            decision_text = frontmatter(
                {
                    "description": decision.decision,
                    "tags": [slugify(topic.topic) for topic in analysis.topics],
                    "timestamp": occurred.isoformat().replace("+00:00", "Z"),
                    "title": decision.title,
                    "type": "decision",
                }
            )
            decision_text += (
                f"# {decision.title}\n\n## Decision\n{decision.decision}\n\n"
                f"## Rationale\n{decision.rationale or 'Not recorded.'}\n\n"
                f"## Owner\n{decision.owner or 'Unassigned'}\n\n"
                f"Source: [[meetings/{source}]]\n"
            )
            self.storage.write_text(key, decision_text)
            written.append(key)

        self._update_actions(analysis.action_items, source)
        written.append("wiki/action-items/active.md")
        self._rebuild_indexes()
        return RenderResult(meeting_key=meeting_key, written_keys=sorted(set(written)))

    def _update_actions(self, items: list[ActionItem], source: str) -> None:
        key = "wiki/action-items/active.md"
        existing = self.storage.read_text(key) or ""
        rows: dict[str, str] = {}
        for line in existing.splitlines():
            if (
                line.startswith("|")
                and not line.startswith("| Owner")
                and not line.startswith("|---")
            ):
                columns = [column.strip() for column in line.strip("|").split("|")]
                if len(columns) >= 5:
                    rows[columns[0] + "\x00" + columns[1]] = line
        for item in items:
            status = "done" if item.done else "open"
            owner = inline_text(item.owner)
            action = inline_text(item.action)
            due = inline_text(item.due or "")
            row = f"| {owner} | {action} | [[meetings/{source}]] | {due} | {status} |"
            rows[owner + "\x00" + action] = row
        content = frontmatter(
            {
                "description": "Open and completed action items across meetings.",
                "tags": ["actions"],
                "timestamp": "",
                "title": "Action Items",
                "type": "action-items",
            }
        )
        content += (
            "# Action Items\n\n| Owner | Action | Source | Due | Status |\n|---|---|---|---|---|\n"
        )
        content += "\n".join(rows[key] for key in sorted(rows)) + ("\n" if rows else "")
        self.storage.write_text(key, content)

    def _rebuild_indexes(self) -> None:
        for category in ("meetings", "people", "topics", "decisions"):
            keys = [
                key
                for key in self.storage.list_keys(f"wiki/{category}")
                if key.endswith(".md") and not key.endswith("/index.md")
            ]
            lines = [f"# {category.title()} Index", ""]
            for key in sorted(keys):
                slug = key.removeprefix(f"wiki/{category}/").removesuffix(".md")
                lines.append(f"- [[{category}/{slug}]]")
            self.storage.write_text(f"wiki/{category}/index.md", "\n".join(lines) + "\n")
        top = ["# Meeting Wiki", ""] + [
            f"- [[{category}/index]]"
            for category in ("meetings", "people", "topics", "decisions", "action-items")
        ]
        self.storage.write_text("wiki/index.md", "\n".join(top) + "\n")
