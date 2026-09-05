"""Deterministic Markdown rendering. LLMs never write whole pages."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC
from pathlib import PurePosixPath

from .models import ActionItem, DecisionStatus, MeetingAnalysis, MeetingInput, MeetingType
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


def canonical(value: str) -> str:
    """Stable identity key: collapse whitespace and casefold. No fuzzy matching."""
    return " ".join(value.split()).casefold()


def parse_frontmatter(text: str) -> tuple[dict[str, object], str]:
    """Split a page into (frontmatter fields, body).

    Values written by ``frontmatter`` are JSON scalars/arrays, so they round-trip
    exactly; bare legacy values fall back to a quote-stripped string.
    """
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    fields: dict[str, object] = {}
    for line in text[4:end].split("\n"):
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        raw = raw.strip()
        try:
            fields[key.strip()] = json.loads(raw) if raw else ""
        except json.JSONDecodeError:
            fields[key.strip()] = raw.strip('"')
    return fields, text[end + len("\n---\n") :]


def decision_status(fields: dict[str, object]) -> str:
    """A decision page with no status is accepted (backward-compatible reader)."""
    return str(fields.get("status") or DecisionStatus.ACCEPTED.value)


def _has_private_part(key: str) -> bool:
    normalized = key.replace("\\", "/").lstrip("/")
    return any(part.lower() == "private" for part in PurePosixPath(normalized).parts)


def _resolve_decision_target(storage: StorageProvider, supersedes: str) -> str | None:
    """Resolve an explicit reference to a shared decision page, or None.

    Accepts an exact ``decision_id`` or an exact ``wiki/decisions/*.md`` path.
    Refuses traversal and any private path, so a shared decision can never
    supersede across the privacy boundary. Never matches decision titles.
    """
    ref = (supersedes or "").strip()
    if not ref or "\x00" in ref:
        return None
    normalized = ref.replace("\\", "/").lstrip("/")
    parts = PurePosixPath(normalized).parts
    if ".." in parts or _has_private_part(normalized):
        return None
    if "/" in normalized or normalized.endswith(".md"):
        if not normalized.startswith("wiki/decisions/") or not normalized.endswith(".md"):
            return None
        return normalized if storage.exists(normalized) else None
    for key in storage.list_keys("wiki/decisions/"):
        if not key.endswith(".md") or key.endswith("/index.md"):
            continue
        fields, _ = parse_frontmatter(storage.read_text(key) or "")
        if fields.get("decision_id") == ref:
            return key
    return None


def apply_supersession(storage: StorageProvider, supersedes: str, superseded_by: str) -> str | None:
    """Mark the referenced decision page superseded. Exact, idempotent, shared-only.

    Returns the updated page key, or None when the reference does not resolve to
    an existing shared decision page. Rewriting an already-superseded page with
    the same reference is a byte-identical no-op.
    """
    target = _resolve_decision_target(storage, supersedes)
    if target is None:
        return None
    text = storage.read_text(target)
    if text is None:
        return None
    fields, body = parse_frontmatter(text)
    if fields.get("type") != "decision":
        return None
    updated = dict(fields)
    updated["status"] = DecisionStatus.SUPERSEDED.value
    updated["superseded_by"] = superseded_by
    rewritten = frontmatter(updated) + body
    if rewritten != text:
        storage.write_text(target, rewritten)
    return target


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
        "ingest_id": meeting.ingest_id,
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

        occurred_iso = occurred.isoformat().replace("+00:00", "Z")
        supersessions: list[tuple[str, str]] = []
        for decision in analysis.decisions:
            decision_id = stable_id(source, decision.title)
            stem = f"{date}-{slugify(decision.title)}-{decision_id}"
            key = f"wiki/decisions/{stem}.md"
            # Preserve a supersession applied by a later meeting: reprocessing the
            # meeting that first recorded a decision must not silently reset it.
            prior_fields, _ = parse_frontmatter(self.storage.read_text(key) or "")
            superseded_by = str(prior_fields.get("superseded_by") or "")
            status = DecisionStatus.SUPERSEDED.value if superseded_by else decision.status.value
            decision_text = frontmatter(
                {
                    "decision_id": decision_id,
                    "description": decision.decision,
                    "effective": occurred_iso,
                    "source": f"meetings/{source}",
                    "status": status,
                    "superseded_by": superseded_by,
                    "supersedes": decision.supersedes or "",
                    "tags": [slugify(topic.topic) for topic in analysis.topics],
                    "timestamp": occurred_iso,
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
            if decision.supersedes:
                supersessions.append((decision.supersedes, f"decisions/{stem}"))

        for supersedes, superseded_by in supersessions:
            target = apply_supersession(self.storage, supersedes, superseded_by)
            if target:
                written.append(target)

        self._update_actions(analysis.action_items, source, occurred_iso)
        written.append("wiki/action-items/active.md")
        written.append("wiki/action-items/archive.md")
        self._rebuild_indexes()
        return RenderResult(meeting_key=meeting_key, written_keys=sorted(set(written)))

    def _update_actions(
        self,
        items: list[ActionItem],
        source: str,
        occurred_iso: str,
    ) -> None:
        """Carry actions forward by exact canonical owner+action identity.

        Each action keeps one row. The full meeting timestamp decides recency,
        with the source stem as a deterministic legacy fallback. A later done
        closes an action and a later open reopens it.
        """
        active_key = "wiki/action-items/active.md"
        archive_key = "wiki/action-items/archive.md"
        entries: dict[str, dict[str, str]] = {}
        for existing_key in (active_key, archive_key):
            for row in self._parse_action_rows(self.storage.read_text(existing_key)):
                row["seen_at"] = self._meeting_timestamp(row["source"])
                identity = canonical(row["owner"]) + "\x00" + canonical(row["action"])
                current = entries.get(identity)
                if current is None or self._action_recency(row) >= self._action_recency(current):
                    entries[identity] = row
        for item in items:
            owner = inline_text(item.owner)
            action = inline_text(item.action)
            identity = canonical(owner) + "\x00" + canonical(action)
            current = entries.get(identity)
            candidate = {
                "owner": owner,
                "action": action,
                "source": source,
                "seen_at": occurred_iso,
                "due": inline_text(item.due or ""),
                "status": "done" if item.done else "open",
            }
            if current is None or self._action_recency(candidate) >= self._action_recency(current):
                entries[identity] = candidate
        rows = list(entries.values())
        self.storage.write_text(
            active_key,
            self._render_action_table(
                [row for row in rows if row["status"] != "done"],
                "Action Items",
                "Open action items across meetings.",
                "action-items",
            ),
        )
        self.storage.write_text(
            archive_key,
            self._render_action_table(
                [row for row in rows if row["status"] == "done"],
                "Completed Action Items",
                "Completed action items across meetings.",
                "action-archive",
            ),
        )

    def _meeting_timestamp(self, source: str) -> str:
        fields, _body = parse_frontmatter(
            self.storage.read_text(f"wiki/meetings/{source}.md") or ""
        )
        return str(fields.get("timestamp") or "")

    @staticmethod
    def _action_recency(row: dict[str, str]) -> tuple[str, str]:
        return row.get("seen_at", ""), row.get("source", "")

    @staticmethod
    def _parse_action_rows(text: str | None) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        for line in (text or "").splitlines():
            if not line.startswith("|") or line.startswith("| Owner") or line.startswith("|---"):
                continue
            columns = [column.strip() for column in line.strip("|").split("|")]
            if len(columns) < 5:
                continue
            match = re.search(r"\[\[meetings/([^\]]+)\]\]", columns[2])
            rows.append(
                {
                    "owner": columns[0],
                    "action": columns[1],
                    "source": match.group(1) if match else "",
                    "due": columns[3],
                    "status": columns[4],
                }
            )
        return rows

    @staticmethod
    def _render_action_table(
        rows: list[dict[str, str]], title: str, description: str, page_type: str
    ) -> str:
        content = frontmatter(
            {
                "description": description,
                "tags": ["actions"],
                "timestamp": "",
                "title": title,
                "type": page_type,
            }
        )
        content += f"# {title}\n\n"
        content += "| Owner | Action | Source | Due | Status |\n|---|---|---|---|---|\n"
        lines = sorted(
            "| {owner} | {action} | {source} | {due} | {status} |".format(
                owner=row["owner"],
                action=row["action"],
                source=f"[[meetings/{row['source']}]]" if row["source"] else "",
                due=row["due"],
                status=row["status"],
            )
            for row in rows
        )
        content += "\n".join(lines) + ("\n" if lines else "")
        return content

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
