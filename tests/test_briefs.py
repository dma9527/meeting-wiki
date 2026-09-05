from __future__ import annotations

import json
import re
from datetime import UTC, datetime

import meeting_wiki.cli as cli
from meeting_wiki.briefs import generate_upcoming_briefs
from meeting_wiki.cli import main
from meeting_wiki.config import AppConfig
from meeting_wiki.providers.base import CalendarEvent
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.wiki import WikiRenderer


class _StubCalendar:
    name = "stub"

    def __init__(self, events: list[CalendarEvent]):
        self._events = events

    def upcoming(self, within_minutes: int) -> list[CalendarEvent]:
        return list(self._events)

    def match(self, occurred_at, tolerance_minutes: int = 15):
        return None


class _RecordingStorage:
    """Wraps a storage and records every read_text key for privacy assertions."""

    def __init__(self, inner):
        self.inner = inner
        self.reads: list[str] = []

    def read_text(self, key: str) -> str | None:
        self.reads.append(key)
        return self.inner.read_text(key)

    def write_text(self, key: str, content: str, private: bool = False) -> None:
        self.inner.write_text(key, content, private=private)

    def exists(self, key: str) -> bool:
        return self.inner.exists(key)

    def list_keys(self, prefix: str = "") -> list[str]:
        return self.inner.list_keys(prefix)


def _seed_wiki(storage, meeting, analysis) -> str:
    result = WikiRenderer(storage).apply(meeting, analysis, "transcripts/source.txt")
    return result.meeting_key.removeprefix("wiki/meetings/").removesuffix(".md")


def _shared_event() -> CalendarEvent:
    return CalendarEvent(
        event_id="evt-shared",
        title="Architecture sync",
        start=datetime(2026, 9, 10, 15, 0, tzinfo=UTC),
        end=datetime(2026, 9, 10, 16, 0, tzinfo=UTC),
        attendees=["Alex", "Sam"],
        description="Objective one\nObjective two",
    )


def test_shared_brief_content_and_deterministic_rerun(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    source = _seed_wiki(storage, meeting, analysis)
    calendar = _StubCalendar([_shared_event()])
    config = AppConfig(data_dir=tmp_path)

    summary = generate_upcoming_briefs(storage, storage, calendar, config, 240)
    assert len(summary) == 1
    entry = summary[0]
    assert entry["privacy"] == "shared"
    assert entry["brief_key"].startswith("wiki/briefs/")
    assert entry["title"] == "Architecture sync"
    assert entry["attendees"] == 2

    brief = storage.read_text(entry["brief_key"])
    assert "# Brief: Architecture sync" in brief
    assert "- Time: 2026-09-10T15:00:00Z to 2026-09-10T16:00:00Z" in brief
    assert "- Objective one" in brief and "- Objective two" in brief
    assert "**Alex**" in brief and "**Sam**" in brief
    assert "recorded discussion" in brief
    assert "Write migration plan" in brief
    assert f"[[meetings/{source}]]" in brief
    assert "When should migration start?" in brief

    rerun = generate_upcoming_briefs(storage, storage, calendar, config, 240)
    assert rerun == summary
    assert storage.read_text(entry["brief_key"]) == brief


def test_shared_brief_reads_only_wiki_and_never_transcripts(tmp_path, meeting, analysis):
    inner = LocalFileStorage(tmp_path)
    _seed_wiki(inner, meeting, analysis)
    recorder = _RecordingStorage(inner)
    config = AppConfig(data_dir=tmp_path)

    generate_upcoming_briefs(recorder, recorder, _StubCalendar([_shared_event()]), config, 240)

    assert recorder.reads, "a shared brief must read wiki knowledge"
    assert all(key.startswith("wiki/") for key in recorder.reads)
    assert not any("transcript" in key for key in recorder.reads)
    assert not any(key.startswith("private/") for key in recorder.reads)


def test_private_hint_brief_excludes_shared_content_and_reads_nothing(tmp_path, meeting, analysis):
    inner = LocalFileStorage(tmp_path)
    _seed_wiki(inner, meeting, analysis)
    recorder = _RecordingStorage(inner)
    config = AppConfig(data_dir=tmp_path)
    event = CalendarEvent(
        event_id="evt-private",
        title="Sync with Sam",
        start=datetime(2026, 9, 11, 15, 0, tzinfo=UTC),
        end=datetime(2026, 9, 11, 15, 30, tzinfo=UTC),
        attendees=["Sam"],
        private_hint=True,
        description="Discuss growth plan",
    )

    summary = generate_upcoming_briefs(recorder, recorder, _StubCalendar([event]), config, 240)

    assert summary == [{"privacy": "private", "brief_key": summary[0]["brief_key"]}]
    key = summary[0]["brief_key"]
    assert key.startswith("private/briefs/")
    assert recorder.reads == [], "a private brief must not read shared wiki content"

    brief = inner.read_text(key)
    assert "Discuss growth plan" in brief
    assert "No shared wiki history is included" in brief
    assert "Write migration plan" not in brief
    assert "recorded discussion" not in brief
    assert "When should migration start?" not in brief


def test_classified_private_event_uses_private_brief_without_hint(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    _seed_wiki(storage, meeting, analysis)
    config = AppConfig(data_dir=tmp_path)
    event = CalendarEvent(
        event_id="evt-career",
        title="Career check-in",
        start=datetime(2026, 9, 12, 15, 0, tzinfo=UTC),
        end=datetime(2026, 9, 12, 15, 30, tzinfo=UTC),
        attendees=["Sam"],
        private_hint=False,
    )

    summary = generate_upcoming_briefs(storage, storage, _StubCalendar([event]), config, 240)

    assert summary[0]["privacy"] == "private"
    assert summary[0]["brief_key"].startswith("private/briefs/")
    assert storage.list_keys("wiki/briefs/") == []


def test_cli_brief_writes_correct_trees_and_privacy_safe_summary(
    tmp_path, monkeypatch, capsys, meeting, analysis
):
    storage = LocalFileStorage(tmp_path)
    _seed_wiki(storage, meeting, analysis)
    config_path = tmp_path / "config.toml"
    config_path.write_text(f'data_dir = "{tmp_path}"\n')
    private_event = CalendarEvent(
        event_id="evt-private",
        title="Private career 1:1",
        start=datetime(2026, 9, 13, 15, 0, tzinfo=UTC),
        end=datetime(2026, 9, 13, 15, 30, tzinfo=UTC),
        attendees=["Sam"],
        private_hint=True,
    )
    monkeypatch.setattr(
        cli, "_build_calendar", lambda _config: _StubCalendar([_shared_event(), private_event])
    )

    assert main(["--config", str(config_path), "brief", "--within", "180"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert len(output) == 2
    shared = next(item for item in output if item["privacy"] == "shared")
    private = next(item for item in output if item["privacy"] == "private")

    assert shared["title"] == "Architecture sync"
    assert "title" not in private and "attendees" not in private
    assert "career" not in json.dumps(output).lower()
    assert re.fullmatch(r"private/briefs/\d{4}-\d{2}-\d{2}-[0-9a-f]{16}\.md", private["brief_key"])
    assert (tmp_path / shared["brief_key"]).exists()
    assert (tmp_path / private["brief_key"]).exists()


def test_shared_brief_ignores_private_marked_wiki_pages(tmp_path):
    storage = LocalFileStorage(tmp_path)
    storage.write_text(
        "wiki/people/alex.md",
        "---\ntype: person\ntitle: Alex\n---\n# Alex\n\n## Timeline\n"
        "<!-- source:2026-09-09-secret-career -->\n### secret\nPrivate context.\n",
    )
    storage.write_text(
        "wiki/meetings/2026-09-09-secret-career.md",
        "---\ntype: private-meeting\nprivacy: private\ntitle: Secret career\n"
        "timestamp: 2026-09-09T15:00:00Z\n---\n# Secret career\n",
    )

    summary = generate_upcoming_briefs(
        storage,
        storage,
        _StubCalendar([_shared_event()]),
        AppConfig(data_dir=tmp_path),
        240,
    )
    brief = storage.read_text(summary[0]["brief_key"])

    assert "secret-career" not in brief
    assert "Secret career" not in brief
