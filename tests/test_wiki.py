from __future__ import annotations

from datetime import UTC, datetime

import pytest

from meeting_wiki.models import (
    ActionItem,
    Decision,
    DecisionStatus,
    MeetingAnalysis,
    MeetingInput,
    MeetingType,
)
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.wiki import (
    WikiRenderer,
    apply_supersession,
    decision_status,
    frontmatter,
    parse_frontmatter,
    slugify,
    stable_id,
)


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


def _decision_pages(storage) -> list[str]:
    return [
        key
        for key in storage.list_keys("wiki/decisions/")
        if key.endswith(".md") and not key.endswith("index.md")
    ]


def _render_actions(storage, occurred, actions, transcript_key):
    meeting = MeetingInput(title="Sync", occurred_at=occurred, meeting_type=MeetingType.GENERIC)
    analysis = MeetingAnalysis(
        title="Sync",
        meeting_type=MeetingType.GENERIC,
        summary=["Discussed work."],
        action_items=actions,
        decisions=[],
    )
    return WikiRenderer(storage).apply(meeting, analysis, transcript_key)


def _rows(storage, key):
    return WikiRenderer._parse_action_rows(storage.read_text(key))


def test_decision_page_has_lifecycle_frontmatter_defaulting_accepted(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    result = WikiRenderer(storage).apply(meeting, analysis, "transcripts/source.txt")
    source = result.meeting_key.removeprefix("wiki/meetings/").removesuffix(".md")
    pages = _decision_pages(storage)
    assert len(pages) == 1
    fields, _ = parse_frontmatter(storage.read_text(pages[0]))
    assert fields["status"] == "accepted"
    assert fields["decision_id"] == stable_id(source, "Choose option B")
    assert fields["source"] == f"meetings/{source}"
    assert fields["superseded_by"] == ""
    assert fields["supersedes"] == ""
    assert str(fields["effective"]).endswith("Z")
    assert decision_status(fields) == "accepted"


def test_supersession_marks_target_by_id_and_is_idempotent(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    first = WikiRenderer(storage).apply(meeting, analysis, "transcripts/first.txt")
    source1 = first.meeting_key.removeprefix("wiki/meetings/").removesuffix(".md")
    decision_id = stable_id(source1, "Choose option B")
    d1_page = _decision_pages(storage)[0]

    later = meeting.model_copy(
        update={"title": "Follow-up review", "occurred_at": datetime(2026, 9, 6, 15, tzinfo=UTC)}
    )
    new_decision = Decision(
        title="Adopt option C", decision="Switch to C", owner="Alex", supersedes=decision_id
    )
    later_analysis = analysis.model_copy(
        update={"title": "Follow-up review", "decisions": [new_decision]}
    )
    second = WikiRenderer(storage).apply(later, later_analysis, "transcripts/second.txt")
    source2 = second.meeting_key.removeprefix("wiki/meetings/").removesuffix(".md")
    d2_stem = f"{source2[:10]}-{slugify('Adopt option C')}-{stable_id(source2, 'Adopt option C')}"

    d1_fields, _ = parse_frontmatter(storage.read_text(d1_page))
    assert d1_fields["status"] == "superseded"
    assert d1_fields["superseded_by"] == f"decisions/{d2_stem}"

    d2_fields, _ = parse_frontmatter(storage.read_text(f"wiki/decisions/{d2_stem}.md"))
    assert d2_fields["status"] == "accepted"
    assert d2_fields["supersedes"] == decision_id

    before = storage.read_text(d1_page)
    WikiRenderer(storage).apply(later, later_analysis, "transcripts/second.txt")
    assert storage.read_text(d1_page) == before


def test_supersession_by_exact_path_is_idempotent(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    WikiRenderer(storage).apply(meeting, analysis, "transcripts/source.txt")
    d1_page = _decision_pages(storage)[0]

    assert apply_supersession(storage, d1_page, "decisions/newer") == d1_page
    fields, _ = parse_frontmatter(storage.read_text(d1_page))
    assert fields["status"] == "superseded"
    assert fields["superseded_by"] == "decisions/newer"

    before = storage.read_text(d1_page)
    assert apply_supersession(storage, d1_page, "decisions/newer") == d1_page
    assert storage.read_text(d1_page) == before


def test_supersession_refuses_cross_boundary_and_unknown_targets(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    result = WikiRenderer(storage).apply(meeting, analysis, "transcripts/source.txt")
    assert apply_supersession(storage, "private/decisions/secret.md", "decisions/x") is None
    assert apply_supersession(storage, "wiki/decisions/../../private/x.md", "decisions/x") is None
    assert apply_supersession(storage, result.meeting_key, "decisions/x") is None
    assert apply_supersession(storage, "wiki/decisions/nope.md", "decisions/x") is None
    assert apply_supersession(storage, "0000nonexistentid00", "decisions/x") is None
    assert storage.list_keys("private/") == []


def test_reversed_decision_status_renders(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    reversed_decision = analysis.decisions[0].model_copy(update={"status": DecisionStatus.REVERSED})
    WikiRenderer(storage).apply(
        meeting, analysis.model_copy(update={"decisions": [reversed_decision]}), "transcripts/r.txt"
    )
    fields, _ = parse_frontmatter(storage.read_text(_decision_pages(storage)[0]))
    assert fields["status"] == "reversed"


def test_old_decision_without_status_reads_accepted_and_can_be_superseded(tmp_path):
    storage = LocalFileStorage(tmp_path)
    old_page = "wiki/decisions/2026-01-01-legacy-testdecision0001.md"
    storage.write_text(
        old_page, "---\ntype: decision\ntitle: Legacy\n---\n# Legacy\n\n## Decision\nOld choice.\n"
    )
    fields, _ = parse_frontmatter(storage.read_text(old_page))
    assert decision_status(fields) == "accepted"

    assert apply_supersession(storage, old_page, "decisions/replacement") == old_page
    updated, _ = parse_frontmatter(storage.read_text(old_page))
    assert updated["status"] == "superseded"
    assert updated["superseded_by"] == "decisions/replacement"


def test_reprocess_preserves_external_supersession(tmp_path, meeting, analysis):
    storage = LocalFileStorage(tmp_path)
    first = WikiRenderer(storage).apply(meeting, analysis, "transcripts/first.txt")
    source1 = first.meeting_key.removeprefix("wiki/meetings/").removesuffix(".md")
    decision_id = stable_id(source1, "Choose option B")
    d1_page = _decision_pages(storage)[0]

    later = meeting.model_copy(
        update={"title": "Follow-up", "occurred_at": datetime(2026, 9, 6, 15, tzinfo=UTC)}
    )
    superseder = Decision(title="Adopt C", decision="Switch", supersedes=decision_id)
    WikiRenderer(storage).apply(
        later,
        analysis.model_copy(update={"title": "Follow-up", "decisions": [superseder]}),
        "transcripts/second.txt",
    )
    assert parse_frontmatter(storage.read_text(d1_page))[0]["status"] == "superseded"

    WikiRenderer(storage).apply(meeting, analysis, "transcripts/first.txt")
    reprocessed, _ = parse_frontmatter(storage.read_text(d1_page))
    assert reprocessed["status"] == "superseded"
    assert str(reprocessed["superseded_by"]).startswith("decisions/")


def test_actions_split_open_to_active_and_done_to_archive(tmp_path):
    storage = LocalFileStorage(tmp_path)
    _render_actions(
        storage,
        datetime(2026, 9, 1, 15, tzinfo=UTC),
        [
            ActionItem(owner="Sam", action="Open task"),
            ActionItem(owner="Alex", action="Closed task", done=True),
        ],
        "transcripts/a.txt",
    )
    active_rows = _rows(storage, "wiki/action-items/active.md")
    archive_rows = _rows(storage, "wiki/action-items/archive.md")
    assert [row["action"] for row in active_rows] == ["Open task"]
    assert active_rows[0]["status"] == "open"
    assert [row["action"] for row in archive_rows] == ["Closed task"]
    assert archive_rows[0]["status"] == "done"


def test_later_done_closes_action_and_moves_it_to_archive(tmp_path):
    storage = LocalFileStorage(tmp_path)
    _render_actions(
        storage,
        datetime(2026, 9, 1, 15, tzinfo=UTC),
        [ActionItem(owner="Sam", action="Ship it")],
        "transcripts/m1.txt",
    )
    assert [row["action"] for row in _rows(storage, "wiki/action-items/active.md")] == ["Ship it"]

    _render_actions(
        storage,
        datetime(2026, 9, 3, 15, tzinfo=UTC),
        [ActionItem(owner="Sam", action="Ship it", done=True)],
        "transcripts/m2.txt",
    )
    assert _rows(storage, "wiki/action-items/active.md") == []
    assert [row["action"] for row in _rows(storage, "wiki/action-items/archive.md")] == ["Ship it"]


def test_completed_action_reopens_when_it_reappears_open(tmp_path):
    storage = LocalFileStorage(tmp_path)
    _render_actions(
        storage,
        datetime(2026, 9, 1, 15, tzinfo=UTC),
        [ActionItem(owner="Sam", action="Ship it", done=True)],
        "transcripts/m1.txt",
    )
    assert [row["action"] for row in _rows(storage, "wiki/action-items/archive.md")] == ["Ship it"]

    _render_actions(
        storage,
        datetime(2026, 9, 4, 15, tzinfo=UTC),
        [ActionItem(owner="Sam", action="Ship it")],
        "transcripts/m2.txt",
    )
    assert [row["action"] for row in _rows(storage, "wiki/action-items/active.md")] == ["Ship it"]
    assert _rows(storage, "wiki/action-items/archive.md") == []


def test_older_meeting_does_not_reopen_a_completed_action(tmp_path):
    storage = LocalFileStorage(tmp_path)
    _render_actions(
        storage,
        datetime(2026, 9, 5, 15, tzinfo=UTC),
        [ActionItem(owner="Sam", action="Ship it", done=True)],
        "transcripts/late.txt",
    )
    _render_actions(
        storage,
        datetime(2026, 9, 1, 15, tzinfo=UTC),
        [ActionItem(owner="Sam", action="Ship it")],
        "transcripts/early.txt",
    )
    assert _rows(storage, "wiki/action-items/active.md") == []
    assert [row["action"] for row in _rows(storage, "wiki/action-items/archive.md")] == ["Ship it"]


def test_canonical_identity_collapses_case_and_whitespace(tmp_path):
    storage = LocalFileStorage(tmp_path)
    _render_actions(
        storage,
        datetime(2026, 9, 1, 15, tzinfo=UTC),
        [ActionItem(owner="Sam", action="Write plan")],
        "transcripts/m1.txt",
    )
    _render_actions(
        storage,
        datetime(2026, 9, 2, 15, tzinfo=UTC),
        [ActionItem(owner="sam", action="write  plan", done=True)],
        "transcripts/m2.txt",
    )
    assert _rows(storage, "wiki/action-items/active.md") == []
    assert len(_rows(storage, "wiki/action-items/archive.md")) == 1


def test_old_action_table_migrates_done_rows_to_archive(tmp_path):
    storage = LocalFileStorage(tmp_path)
    storage.write_text(
        "wiki/action-items/active.md",
        "# Action Items\n\n| Owner | Action | Source | Due | Status |\n|---|---|---|---|---|\n"
        "| Alex | Keep open | [[meetings/2026-08-01-x-aaaaaaaaaaaaaaaa]] |  | open |\n"
        "| Sam | Already done | [[meetings/2026-08-01-x-aaaaaaaaaaaaaaaa]] |  | done |\n",
    )
    _render_actions(storage, datetime(2026, 9, 2, 15, tzinfo=UTC), [], "transcripts/mig.txt")
    assert [row["action"] for row in _rows(storage, "wiki/action-items/active.md")] == ["Keep open"]
    assert [row["action"] for row in _rows(storage, "wiki/action-items/archive.md")] == [
        "Already done"
    ]


def test_action_carryover_is_idempotent(tmp_path):
    storage = LocalFileStorage(tmp_path)
    items = [
        ActionItem(owner="Sam", action="Open task"),
        ActionItem(owner="Alex", action="Done task", done=True),
    ]
    _render_actions(storage, datetime(2026, 9, 1, 15, tzinfo=UTC), items, "transcripts/m.txt")
    active_before = storage.read_text("wiki/action-items/active.md")
    archive_before = storage.read_text("wiki/action-items/archive.md")
    _render_actions(storage, datetime(2026, 9, 1, 15, tzinfo=UTC), items, "transcripts/m.txt")
    assert storage.read_text("wiki/action-items/active.md") == active_before
    assert storage.read_text("wiki/action-items/archive.md") == archive_before


def test_later_same_day_meeting_wins_action_status(tmp_path):
    storage = LocalFileStorage(tmp_path)
    renderer = WikiRenderer(storage)
    early = MeetingInput(
        title="Zulu sync",
        occurred_at=datetime(2026, 9, 5, 9, tzinfo=UTC),
        meeting_type=MeetingType.GENERIC,
    )
    later = MeetingInput(
        title="Alpha sync",
        occurred_at=datetime(2026, 9, 5, 17, tzinfo=UTC),
        meeting_type=MeetingType.GENERIC,
    )
    open_analysis = MeetingAnalysis(
        title="Zulu sync",
        summary=["Opened action."],
        action_items=[ActionItem(owner="Sam", action="Ship it")],
    )
    done_analysis = MeetingAnalysis(
        title="Alpha sync",
        summary=["Closed action."],
        action_items=[ActionItem(owner="Sam", action="Ship it", done=True)],
    )

    renderer.apply(early, open_analysis, "transcripts/early-same-day.txt")
    renderer.apply(later, done_analysis, "transcripts/later-same-day.txt")

    assert _rows(storage, "wiki/action-items/active.md") == []
    assert [row["action"] for row in _rows(storage, "wiki/action-items/archive.md")] == ["Ship it"]
