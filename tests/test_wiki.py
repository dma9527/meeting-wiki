from __future__ import annotations

from datetime import UTC, datetime

import pytest

from meeting_wiki.models import MeetingType
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.wiki import WikiRenderer, frontmatter, slugify


def test_slugify_and_frontmatter_are_deterministic():
    assert slugify("Café / Architecture Review") == "cafe-architecture-review"
    assert frontmatter({"title": "B", "tags": ["z", "a", "a"], "type": "topic"}) == (
        '---\ntags: ["a", "z"]\ntitle: "B"\ntype: "topic"\n---\n'
    )


def test_render_is_idempotent_and_preserves_timeline(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    renderer = WikiRenderer(storage)
    first = renderer.apply(meeting, analysis, "transcripts/source.txt")
    snapshot = {key: storage.read_text(key) for key in storage.list_keys() if key.endswith(".md")}
    second = renderer.apply(meeting, analysis, "transcripts/source.txt")
    assert first.meeting_key == second.meeting_key
    assert snapshot == {
        key: storage.read_text(key) for key in storage.list_keys() if key.endswith(".md")
    }
    alex = storage.read_text("wiki/people/alex.md")
    assert alex.count("<!-- source:") == 1
    assert "Option B was selected" in storage.read_text("wiki/topics/architecture.md")
    assert "Write migration plan" in storage.read_text("wiki/action-items/active.md")
    assert "[[meetings/index]]" in storage.read_text("wiki/index.md")


def test_later_meeting_appends_without_erasing_history(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    renderer = WikiRenderer(storage)
    renderer.apply(meeting, analysis, "transcripts/first.txt")
    before = storage.read_text("wiki/people/alex.md")
    later = meeting.model_copy(
        update={
            "title": "Follow-up",
            "occurred_at": datetime(2026, 9, 5, 15, 0, tzinfo=UTC),
        }
    )
    renderer.apply(
        later, analysis.model_copy(update={"title": "Follow-up"}), "transcripts/second.txt"
    )
    after = storage.read_text("wiki/people/alex.md")
    assert before in after
    assert after.count("<!-- source:") == 2


def test_private_meeting_writes_only_private_tree(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    private_meeting = meeting.model_copy(
        update={"private": True, "meeting_type": MeetingType.ONE_ON_ONE}
    )
    private_analysis = analysis.model_copy(
        update={"private": True, "meeting_type": MeetingType.ONE_ON_ONE}
    )
    result = WikiRenderer(storage).apply(
        private_meeting, private_analysis, "private/transcripts/source.txt"
    )
    assert result.meeting_key.startswith("private/meetings/")
    assert storage.list_keys("wiki/") == []
    assert storage.list_keys("private/") == [result.meeting_key]
    assert "privacy" in storage.read_text(result.meeting_key)


def test_storage_rejects_private_content_under_shared_path(tmp_path):
    storage = LocalFileStorage(tmp_path)
    with pytest.raises(ValueError, match="Private content"):
        storage.write_text("wiki/meetings/private.md", "secret", private=True)
    with pytest.raises(ValueError, match="private=True"):
        storage.write_text("private/meetings/x.md", "secret", private=False)
    with pytest.raises(ValueError, match="Invalid storage key"):
        storage.write_text("../escape.md", "bad")


def test_meeting_path_does_not_depend_on_model_title(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    renderer = WikiRenderer(storage)
    first = renderer.apply(meeting, analysis, "transcripts/stable.txt")
    second = renderer.apply(
        meeting,
        analysis.model_copy(update={"title": "A different model-generated title"}),
        "transcripts/stable.txt",
    )
    assert first.meeting_key == second.meeting_key


def test_unicode_slugs_do_not_collide():
    assert slugify("张三") != slugify("李四")
    assert slugify("张三").startswith("untitled-")


def test_action_table_escapes_pipes_and_newlines_idempotently(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    unsafe = analysis.model_copy(
        update={
            "action_items": [
                analysis.action_items[0].model_copy(
                    update={"owner": "Sam | Team", "action": "Write A | B\nthen review"}
                )
            ]
        }
    )
    renderer = WikiRenderer(storage)
    renderer.apply(meeting, unsafe, "transcripts/unsafe.txt")
    first = storage.read_text("wiki/action-items/active.md")
    renderer.apply(meeting, unsafe, "transcripts/unsafe.txt")
    second = storage.read_text("wiki/action-items/active.md")
    assert first == second
    assert "Sam &#124; Team" in first
    assert "Write A &#124; B then review" in first
    action_rows = [line for line in first.splitlines() if line.startswith("| Sam")]
    assert len(action_rows) == 1


def test_local_storage_and_jobs_use_private_permissions(tmp_path):
    import stat

    from meeting_wiki.jobs import JobQueue

    storage = LocalFileStorage(tmp_path / "data")
    storage.write_text("wiki/test.md", "secret")
    queue = JobQueue(tmp_path / "data/jobs.db")
    assert stat.S_IMODE((tmp_path / "data").stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "data/wiki/test.md").stat().st_mode) == 0o600
    assert stat.S_IMODE(queue.path.stat().st_mode) == 0o600
