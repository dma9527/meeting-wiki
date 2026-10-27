from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from meeting_wiki.cli import main
from meeting_wiki.memory import MemoryStore
from meeting_wiki.memory_reindex import reindex_memory
from meeting_wiki.models import (
    ActionItem,
    Decision,
    MeetingAnalysis,
    MeetingInput,
    MeetingType,
    Participant,
    TopicInsight,
    TranscriptResult,
    TranscriptSegment,
)
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.wiki import WikiRenderer, parse_frontmatter, stable_id


def make_meeting(title: str, day: int, private: bool = False) -> MeetingInput:
    return MeetingInput(
        title=title,
        occurred_at=datetime(2026, 9, day, 15, 0, tzinfo=UTC),
        private=private,
        meeting_type=MeetingType.GENERIC,
    )


def make_transcript(*lines: tuple[str, str]) -> TranscriptResult:
    return TranscriptResult(
        text="\n".join(f"{speaker}: {text}" for speaker, text in lines),
        segments=[TranscriptSegment(speaker=speaker, text=text) for speaker, text in lines],
        provider="fake",
        model="fake",
        diarized=True,
    )


def make_analysis(title: str, topic: str, insight: str, private: bool = False) -> MeetingAnalysis:
    return MeetingAnalysis(
        title=title,
        summary=[f"{title} summary."],
        participants=[Participant(name="Alex")],
        decisions=[Decision(title=f"{topic} decision", decision=insight, owner="Alex")],
        action_items=[ActionItem(owner="Alex", action=f"Follow up on {topic}")],
        topics=[TopicInsight(topic=topic, insight=insight)],
        private=private,
    )


def store_meeting(
    data_dir: Path,
    meeting: MeetingInput,
    analysis: MeetingAnalysis,
    transcript: TranscriptResult,
) -> str:
    """Write artifacts with the same keys MeetingEngine.ingest uses."""
    storage = LocalFileStorage(data_dir)
    private = analysis.private
    stem = f"{meeting.occurred_at:%Y-%m-%d}-{meeting.ingest_id}"
    tree = "private/" if private else ""
    transcript_key = f"{tree}transcripts/{stem}.txt"
    storage.write_text(transcript_key, transcript.text + "\n", private=private)
    storage.write_text(
        f"{tree}transcript-data/{stem}.json", transcript.model_dump_json(), private=private
    )
    storage.write_text(f"{tree}analysis/{stem}.json", analysis.model_dump_json(), private=private)
    return WikiRenderer(storage).apply(meeting, analysis, transcript_key).meeting_key


@pytest.fixture
def archive(tmp_path) -> dict[str, object]:
    data_dir = tmp_path / "data"
    shared_meeting = make_meeting("Platform sync", 4)
    shared_key = store_meeting(
        data_dir,
        shared_meeting,
        make_analysis("Platform sync", "Rollout", "Ship the canary rollout"),
        make_transcript(("Alex", "Canary rollout starts Monday."), ("Sam", "Agreed.")),
    )
    private_meeting = make_meeting("Career chat", 5, private=True)
    private_key = store_meeting(
        data_dir,
        private_meeting,
        make_analysis("Career chat", "Rollout", "Confidential canary concern", private=True),
        make_transcript(("Alex", "Private canary worry.")),
    )
    return {
        "data_dir": data_dir,
        "shared_key": shared_key,
        "private_key": private_key,
        "shared_id": shared_meeting.ingest_id,
        "private_id": private_meeting.ingest_id,
    }


def memory(data_dir: Path) -> MemoryStore:
    return MemoryStore(data_dir / "memory.db")


def test_reindex_rebuilds_shared_and_private_and_reports_counts_only(archive):
    report = reindex_memory(archive["data_dir"]).to_dict()
    assert report == {"meetings_indexed": 2, "shared": 1, "private": 1, "skipped": {}}
    assert "Career" not in json.dumps(report)
    assert oct(os.stat(archive["data_dir"] / "memory.db").st_mode & 0o777) == "0o600"

    shared = memory(archive["data_dir"]).search("canary")
    assert shared
    assert {item["privacy"] for item in shared} == {"shared"}
    assert "Confidential" not in json.dumps(shared)
    assert "Private canary" not in json.dumps(shared)

    everything = memory(archive["data_dir"]).search("canary", include_private=True)
    assert {item["privacy"] for item in everything} == {"shared", "private"}


def test_shared_results_carry_source_backed_relations(archive):
    reindex_memory(archive["data_dir"])
    [decision] = memory(archive["data_dir"]).search("canary", node_types=["decision"])
    assert decision["source"] == {
        "source_id": archive["shared_id"],
        "title": "Platform sync",
        "occurred_at": "2026-09-04T15:00:00+00:00",
        "privacy": "shared",
        "meeting_key": archive["shared_key"],
    }
    relations = {
        (item["relation"], item["direction"], item["label"]) for item in decision["relations"]
    }
    assert ("decided_in", "out", "Platform sync") in relations
    assert ("owned_by", "out", "Alex") in relations
    sources = {item["source"]["meeting_key"] for item in decision["relations"]}
    assert sources == {archive["shared_key"]}


def test_shared_search_never_returns_private_relations_or_sources(archive):
    reindex_memory(archive["data_dir"])
    [topic] = memory(archive["data_dir"]).search("rollout", node_types=["topic"])
    assert topic["privacy"] == "shared"
    assert [item["label"] for item in topic["relations"]] == ["Platform sync"]
    private_topics = memory(archive["data_dir"]).search(
        "rollout", node_types=["topic"], include_private=True
    )
    private_topic = next(item for item in private_topics if item["privacy"] == "private")
    assert private_topic["relations"][0]["source"]["meeting_key"] == archive["private_key"]


def test_type_filters_accept_multiple_types_and_reject_unknown(archive):
    reindex_memory(archive["data_dir"])
    store = memory(archive["data_dir"])
    types = {item["node_type"] for item in store.search("canary", node_types=["decision", "topic"])}
    assert types <= {"decision", "topic"} and "decision" in types
    segments = store.search("canary", node_types=["transcript_segment"])
    assert [item["label"] for item in segments] == ["Alex"]
    with pytest.raises(ValueError, match="Unknown memory node type"):
        store.search("canary", node_types=["secret_table"])
    with pytest.raises(ValueError):
        store.search("canary", node_type="private")


def test_reindex_drops_stale_rows_and_reclassified_shared_nodes(archive):
    data_dir = archive["data_dir"]
    store = memory(data_dir)
    stale = make_meeting("Deleted meeting", 1)
    store.index_meeting(
        stale,
        make_analysis("Deleted meeting", "Obsolete", "zebra migration"),
        make_transcript(("Alex", "zebra")),
        "wiki/meetings/deleted.md",
    )
    # The same meeting later became private; only its private copy may remain.
    reclassified = make_meeting("Platform sync", 4)
    store_meeting(
        data_dir,
        reclassified,
        make_analysis("Platform sync", "Quokka", "quokka plan", private=True),
        make_transcript(("Alex", "quokka")),
    )
    assert store.search("zebra")
    report = reindex_memory(data_dir).to_dict()
    assert report["skipped"] == {"superseded_duplicate": 1}
    assert report["shared"] == 0 and report["private"] == 2
    assert store.search("zebra", include_private=True) == []
    assert store.search("canary") == []
    assert store.search("quokka") == []
    assert store.search("quokka", include_private=True)


def test_reindex_skips_symlinked_or_mislabelled_shared_pages(archive):
    data_dir = archive["data_dir"]
    shared_page = data_dir / archive["shared_key"]
    text = shared_page.read_text()
    shared_page.unlink()
    shared_page.symlink_to(data_dir / archive["private_key"])
    (data_dir / "wiki/meetings/claims-private.md").write_text(
        text.replace('privacy: "shared"', 'privacy: "private"')
    )
    (data_dir / "wiki/meetings/points-private.md").write_text(
        text.replace('resource: "transcripts/', 'resource: "private/transcripts/')
    )
    (data_dir / "wiki/meetings/traversal.md").write_text(
        text.replace('resource: "transcripts/', 'resource: "transcripts/../private/transcripts/')
    )
    report = reindex_memory(data_dir).to_dict()
    assert report["shared"] == 0
    assert report["skipped"] == {
        "privacy_mismatch": 1,
        "unrecognized_source": 2,
        "unsafe_path": 1,
    }
    assert memory(data_dir).search("canary") == []


def test_reindex_skips_shared_artifact_symlinked_into_private_tree(archive):
    data_dir = archive["data_dir"]
    analysis = next((data_dir / "analysis").glob("*.json"))
    analysis.unlink()
    analysis.symlink_to(next((data_dir / "private/analysis").glob("*.json")))
    report = reindex_memory(data_dir).to_dict()
    assert report["skipped"] == {"unsafe_path": 1}
    assert memory(data_dir).search("confidential") == []


def test_reindex_is_atomic_when_an_entry_fails(archive, monkeypatch):
    data_dir = archive["data_dir"]
    reindex_memory(data_dir)
    original = MemoryStore._index_meeting
    calls = []

    def failing(self, connection, *entry):
        calls.append(entry)
        if len(calls) == 2:
            raise RuntimeError("disk full")
        return original(self, connection, *entry)

    monkeypatch.setattr(MemoryStore, "_index_meeting", failing)
    with pytest.raises(RuntimeError):
        reindex_memory(data_dir)
    monkeypatch.undo()
    assert memory(data_dir).search("canary")
    with sqlite3.connect(data_dir / "memory.db") as connection:
        assert connection.execute("SELECT COUNT(*) FROM memory_fts").fetchone()[0] > 0


def write_config(tmp_path: Path, data_dir: Path, storage: str = "local") -> Path:
    config = tmp_path / "config.toml"
    config.write_text(
        f'data_dir = "{data_dir}"\n[providers]\nstorage = "{storage}"\n'
        + ('[s3]\nbucket = "test-bucket"\n' if storage == "s3" else "")
    )
    return config


def test_cli_reindex_and_memory_search_default_to_shared(archive, tmp_path, capsys):
    config = write_config(tmp_path, archive["data_dir"])
    assert main(["--config", str(config), "reindex-memory"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["meetings_indexed"] == 2
    assert main(["--config", str(config), "memory-search", "--query=canary"]) == 0
    shared = json.loads(capsys.readouterr().out)
    assert shared["count"] > 0
    assert {item["privacy"] for item in shared["items"]} == {"shared"}
    assert (
        main(
            [
                "--config",
                str(config),
                "memory-search",
                "--query=canary",
                "--type=topic",
                "--type=decision",
                "--include-private",
            ]
        )
        == 0
    )
    both = json.loads(capsys.readouterr().out)
    assert {item["privacy"] for item in both["items"]} == {"shared", "private"}
    assert {item["node_type"] for item in both["items"]} <= {"topic", "decision"}


def test_cli_memory_search_rejects_bad_input(archive, tmp_path, capsys):
    config = write_config(tmp_path, archive["data_dir"])
    assert main(["--config", str(config), "memory-search", "--query=!"]) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "invalid_memory_query"
    assert main(["--config", str(config), "memory-search", "--query=ok", "--limit=99"]) == 1
    capsys.readouterr()
    with pytest.raises(SystemExit):
        main(["--config", str(config), "memory-search", "--query=ok", "--type=secret"])


def test_cli_reindex_refuses_non_local_storage(archive, tmp_path, capsys):
    config = write_config(tmp_path, archive["data_dir"], storage="s3")
    assert main(["--config", str(config), "reindex-memory"]) == 1
    assert json.loads(capsys.readouterr().out) == {"error": "reindex_requires_local_storage"}
    assert not (archive["data_dir"] / "memory.db").exists()


def test_mcp_memory_search_stays_shared_after_reindex(archive):
    reindex_memory(archive["data_dir"])

    async def run():
        env = os.environ.copy()
        env["MEETING_WIKI_DATA_DIR"] = str(archive["data_dir"])
        params = StdioServerParameters(
            command=os.sys.executable,
            args=["-m", "meeting_wiki.mcp_server"],
            env=env,
            cwd=Path(__file__).parents[1],
        )
        async with (
            stdio_client(params) as (read_stream, write_stream),
            ClientSession(read_stream, write_stream) as session,
        ):
            await session.initialize()
            result = await session.call_tool("meeting_wiki_memory_search", {"query": "canary"})
            payload = json.dumps(result.structured_content)
            assert result.structured_content["count"] > 0
            assert "Confidential" not in payload and "Private canary" not in payload
            assert archive["private_id"] not in payload
            assert '"private"' not in payload

    asyncio.run(run())


def _private_entity_rows(data_dir: Path, label: str) -> tuple[int, int]:
    with sqlite3.connect(data_dir / "memory.db") as connection:
        nodes = connection.execute(
            "SELECT COUNT(*) FROM memory_nodes WHERE privacy='private' AND label=? "
            "AND node_type IN ('person','topic')",
            (label,),
        ).fetchone()[0]
        fts = connection.execute(
            "SELECT COUNT(*) FROM memory_fts WHERE label=? "
            "AND (node_id LIKE 'person:%' OR node_id LIKE 'topic:%') "
            "AND node_id NOT IN (SELECT node_id FROM memory_nodes WHERE privacy='shared')",
            (label,),
        ).fetchone()[0]
    return nodes, fts


def test_reprocessing_a_private_meeting_removes_its_stale_people_and_topics(tmp_path):
    data_dir = tmp_path / "data"
    store = memory(data_dir)
    meeting = make_meeting("Career chat", 5, private=True)
    first = make_analysis("Career chat", "Promotion packet", "Confidential", private=True)
    first = first.model_copy(update={"participants": [Participant(name="Pat Example")]})
    store.index_meeting(meeting, first, make_transcript(("Pat Example", "Hi.")), "private/m.md")
    assert _private_entity_rows(data_dir, "Pat Example") == (1, 1)

    second = make_analysis("Career chat", "Team goals", "Updated", private=True)
    store.index_meeting(meeting, second, make_transcript(("Alex", "Hi.")), "private/m.md")

    assert _private_entity_rows(data_dir, "Pat Example") == (0, 0)
    assert _private_entity_rows(data_dir, "Promotion packet") == (0, 0)
    assert _private_entity_rows(data_dir, "Team goals") == (1, 1)
    assert store.search("Promotion", include_private=True) == []


def test_reprocessing_removes_legacy_unscoped_private_entities_but_keeps_shared(tmp_path):
    data_dir = tmp_path / "data"
    store = memory(data_dir)
    shared = make_meeting("Platform sync", 4)
    store.index_meeting(
        shared,
        make_analysis("Platform sync", "Rollout", "Ship it"),
        make_transcript(("Alex", "Ship it.")),
        "wiki/meetings/a.md",
    )
    private = make_meeting("Career chat", 5, private=True)
    analysis = make_analysis("Career chat", "Promotion packet", "Confidential", private=True)
    store.index_meeting(private, analysis, make_transcript(("Alex", "Hi.")), "private/m.md")
    # Rows written before entity scoping carried no meeting source.
    with sqlite3.connect(data_dir / "memory.db") as connection:
        connection.execute(
            "UPDATE memory_nodes SET source_id='' WHERE privacy='private' "
            "AND node_type IN ('person','topic')"
        )

    store.index_meeting(
        private,
        analysis.model_copy(update={"topics": [TopicInsight(topic="Goals", insight="New")]}),
        make_transcript(("Alex", "Hi.")),
        "private/m.md",
    )

    assert _private_entity_rows(data_dir, "Promotion packet") == (0, 0)
    assert _private_entity_rows(data_dir, "Alex") == (1, 1)
    shared_people = [item for item in store.search("Alex", node_type="person")]
    assert [item["privacy"] for item in shared_people] == ["shared"]
    assert shared_people[0]["source_id"] == ""


def test_private_deletion_preview_counts_meeting_scoped_people_and_topics(archive):
    from meeting_wiki.deletion import preview_meeting_deletion

    reindex_memory(archive["data_dir"])
    plan = preview_meeting_deletion(
        archive["data_dir"],
        LocalFileStorage(archive["data_dir"]),
        archive["private_key"],
        allow_private=True,
    )
    assert plan["memory"]["nodes"]["person"] == 1
    assert plan["memory"]["nodes"]["topic"] == 1

    shared = preview_meeting_deletion(
        archive["data_dir"], LocalFileStorage(archive["data_dir"]), archive["shared_key"]
    )
    assert "person" not in shared["memory"]["nodes"]
    assert "topic" not in shared["memory"]["nodes"]


def timed_transcript() -> TranscriptResult:
    lines = [("Alex", "Canary rollout starts Monday.", 65.0, 71.5), ("Sam", "Agreed.", 72.0, 73.0)]
    return TranscriptResult(
        text="\n".join(f"{speaker}: {text}" for speaker, text, _, _ in lines),
        segments=[
            TranscriptSegment(speaker=speaker, text=text, start_seconds=start, end_seconds=end)
            for speaker, text, start, end in lines
        ],
        provider="fake",
        model="fake",
        diarized=True,
    )


@pytest.fixture
def timed_archive(tmp_path) -> dict[str, object]:
    data_dir = tmp_path / "timed"
    meeting = make_meeting("Platform sync", 4)
    key = store_meeting(
        data_dir,
        meeting,
        make_analysis("Platform sync", "Rollout", "Ship the canary rollout"),
        timed_transcript(),
    )
    private = make_meeting("Career chat", 5, private=True)
    private_key = store_meeting(
        data_dir,
        private,
        make_analysis("Career chat", "Rollout", "Confidential canary concern", private=True),
        timed_transcript(),
    )
    reindex_memory(data_dir)
    return {"data_dir": data_dir, "key": key, "id": meeting.ingest_id, "private_key": private_key}


def citation_for(key: str, ingest_id: str, anchor: dict | None = None) -> dict:
    return {
        "version": 1,
        "meeting_id": MemoryStore._node_id("meeting", ingest_id),
        "meeting_title": "Platform sync",
        "occurred_at": "2026-09-04T15:00:00+00:00",
        "privacy": "shared",
        "source_path": key,
        "anchor": anchor,
    }


def test_a_decision_cites_its_meeting_with_the_full_citation_shape(timed_archive):
    [decision] = memory(timed_archive["data_dir"]).search("canary", node_types=["decision"])
    assert decision["citation"] == citation_for(timed_archive["key"], timed_archive["id"])
    assert decision["citation"]["source_path"] == decision["source"]["meeting_key"]


def test_a_meeting_result_cites_itself(timed_archive):
    [meeting] = memory(timed_archive["data_dir"]).search("platform", node_types=["meeting"])
    assert meeting["citation"] == citation_for(timed_archive["key"], timed_archive["id"])


def test_a_citation_meeting_id_is_the_meeting_node_id_other_commands_accept(timed_archive):
    store = memory(timed_archive["data_dir"])
    [meeting] = store.search("platform", node_types=["meeting"])
    [decision] = store.search("canary", node_types=["decision"])
    assert meeting["citation"]["meeting_id"] == meeting["node_id"]
    assert decision["citation"]["meeting_id"] == meeting["node_id"]


def test_a_transcript_line_cites_the_time_inside_the_meeting(timed_archive):
    lines = memory(timed_archive["data_dir"]).search(
        "canary rollout starts", node_types=["transcript_segment"]
    )
    [line] = [item for item in lines if item["privacy"] == "shared"]
    assert line["citation"] == citation_for(
        timed_archive["key"],
        timed_archive["id"],
        {"kind": "transcript_segment", "start_seconds": 65.0, "end_seconds": 71.5, "index": 0},
    )


def test_relations_carry_their_own_citation_and_an_entity_has_none_of_its_own(timed_archive):
    [topic] = memory(timed_archive["data_dir"]).search("rollout", node_types=["topic"])
    assert topic["citation"] is None, "a shared topic spans meetings, so it has no single source"
    assert [relation["citation"] for relation in topic["relations"]] == [
        citation_for(timed_archive["key"], timed_archive["id"])
    ]
    [decision] = memory(timed_archive["data_dir"]).search("canary", node_types=["decision"])
    assert all(relation["citation"] is not None for relation in decision["relations"])


def test_a_related_transcript_line_carries_its_anchor(timed_archive):
    [meeting] = memory(timed_archive["data_dir"]).search("platform", node_types=["meeting"])
    anchors = [
        relation["citation"]["anchor"]
        for relation in meeting["relations"]
        if relation["node_type"] == "transcript_segment"
    ]
    assert anchors
    assert all(
        anchor["kind"] == "transcript_segment" and "start_seconds" in anchor for anchor in anchors
    )


def test_shared_search_never_returns_a_private_citation(timed_archive):
    items = memory(timed_archive["data_dir"]).search("canary rollout", limit=30)
    payload = json.dumps(items)
    assert timed_archive["private_key"] not in payload
    assert '"privacy": "private"' not in payload
    assert all(
        item["citation"] is None or item["citation"]["privacy"] == "shared" for item in items
    )


def test_private_search_cites_the_private_source_only_when_asked(timed_archive):
    items = memory(timed_archive["data_dir"]).search(
        "confidential", node_types=["decision"], include_private=True
    )
    [decision] = items
    assert decision["citation"]["privacy"] == "private"
    assert decision["citation"]["source_path"] == timed_archive["private_key"]


def test_the_cli_prints_the_citation(timed_archive, tmp_path, capsys):
    config = tmp_path / "config.toml"
    config.write_text(f'data_dir = "{timed_archive["data_dir"]}"\n')
    assert (
        main(["--config", str(config), "memory-search", "--query=canary", "--type=decision"]) == 0
    )
    [item] = json.loads(capsys.readouterr().out)["items"]
    assert item["citation"] == citation_for(timed_archive["key"], timed_archive["id"])


def test_the_mcp_tool_returns_the_same_citation_shape(timed_archive):
    async def run():
        env = os.environ.copy()
        env["MEETING_WIKI_DATA_DIR"] = str(timed_archive["data_dir"])
        params = StdioServerParameters(
            command=os.sys.executable,
            args=["-m", "meeting_wiki.mcp_server"],
            env=env,
            cwd=Path(__file__).parents[1],
        )
        async with (
            stdio_client(params) as (read_stream, write_stream),
            ClientSession(read_stream, write_stream) as session,
        ):
            await session.initialize()
            result = await session.call_tool(
                "meeting_wiki_memory_search", {"query": "canary", "node_type": "decision"}
            )
            [item] = result.structured_content["items"]
            assert item["citation"] == citation_for(timed_archive["key"], timed_archive["id"])
            page = await session.call_tool(
                "meeting_wiki_read_page", {"path": item["citation"]["source_path"]}
            )
            assert "Platform sync" in page.structured_content["content"]
            for private_path in (timed_archive["private_key"], "wiki/private/meetings/x.md"):
                refused = await session.call_tool("meeting_wiki_read_page", {"path": private_path})
                assert "error" in refused.structured_content
                assert "content" not in refused.structured_content

    asyncio.run(run())


def test_a_transcript_line_indexed_before_citations_existed_still_cites_without_an_index(
    timed_archive,
):
    db = timed_archive["data_dir"] / "memory.db"
    with sqlite3.connect(db) as connection:
        for node_id, metadata in connection.execute(
            "SELECT node_id, metadata FROM memory_nodes WHERE node_type='transcript_segment'"
        ).fetchall():
            data = json.loads(metadata)
            data.pop("index", None)
            connection.execute(
                "UPDATE memory_nodes SET metadata=? WHERE node_id=?", (json.dumps(data), node_id)
            )
    lines = memory(timed_archive["data_dir"]).search(
        "canary rollout starts", node_types=["transcript_segment"]
    )
    [line] = [item for item in lines if item["privacy"] == "shared"]
    assert line["citation"]["anchor"] == {
        "kind": "transcript_segment",
        "start_seconds": 65.0,
        "end_seconds": 71.5,
    }


def decision_archive(tmp_path) -> dict[str, object]:
    """Polling (day 1), webhooks supersedes it (day 8), a private one also names it (day 9)."""
    data_dir = tmp_path / "decisions"
    keys: dict[str, str] = {}

    def add(label, day, decisions, private=False):
        meeting = make_meeting(label, day, private=private)
        analysis = MeetingAnalysis(
            title=label,
            summary=[f"{label} summary."],
            decisions=decisions,
            private=private,
        )
        keys[label] = store_meeting(data_dir, meeting, analysis, make_transcript(("Alex", "Hi.")))

    add("Design review", 1, [Decision(title="Use polling", decision="Poll every 5 minutes.")])
    polling_id = stable_id(Path(keys["Design review"]).stem, "Use polling")
    add(
        "Follow up",
        8,
        [
            Decision(
                title="Use webhooks",
                decision="Push events instead.",
                rationale="Polling was too slow.",
                owner="Sam",
                supersedes=polling_id,
            ),
            Decision(title="Drop retries", decision="No retries.", status="reversed"),
        ],
    )
    add(
        "Career chat",
        9,
        [Decision(title="Leave the team", decision="Private.", supersedes=polling_id)],
        private=True,
    )
    reindex_memory(data_dir)
    return {"data_dir": data_dir, "keys": keys, "polling_id": polling_id}


def history_titles(items):
    return [item["title"] for item in items]


def test_decision_history_is_chronological_shared_only_and_cited(tmp_path):
    archive = decision_archive(tmp_path)
    items = memory(archive["data_dir"]).decision_history()
    assert history_titles(items) == ["Use polling", "Use webhooks", "Drop retries"]
    assert [item["occurred_at"][:10] for item in items] == [
        "2026-09-01",
        "2026-09-08",
        "2026-09-08",
    ]
    assert items[1]["citation"]["meeting_title"] == "Follow up"
    assert items[1]["citation"]["source_path"] == archive["keys"]["Follow up"]
    assert items[1]["owner"] == "Sam"
    assert "Polling was too slow." in items[1]["detail"]
    assert "Leave the team" not in json.dumps(items)


def test_a_later_decision_supersedes_an_earlier_one_by_exact_decision_id(tmp_path):
    archive = decision_archive(tmp_path)
    polling, webhooks, retries = memory(archive["data_dir"]).decision_history()
    assert polling["decision_id"] == archive["polling_id"]
    assert polling["status"] == "accepted"
    assert polling["effective_status"] == "superseded"
    assert polling["superseded_by"]["title"] == "Use webhooks"
    assert polling["superseded_by"]["node_id"] == webhooks["node_id"]
    assert polling["supersedes"] is None
    assert webhooks["supersedes"]["title"] == "Use polling"
    assert webhooks["supersedes"]["node_id"] == polling["node_id"]
    assert webhooks["effective_status"] == "accepted"
    assert webhooks["superseded_by"] is None
    assert retries["status"] == "reversed"
    assert retries["effective_status"] == "reversed"


def test_a_wiki_decision_path_reference_resolves_to_the_same_decision(tmp_path):
    archive = decision_archive(tmp_path)
    db = archive["data_dir"] / "memory.db"
    path = f"wiki/decisions/2026-09-01-use-polling-{archive['polling_id']}.md"
    with sqlite3.connect(db) as connection:
        [(node_id, metadata)] = connection.execute(
            "SELECT node_id, metadata FROM memory_nodes WHERE label='Use webhooks'"
        ).fetchall()
        connection.execute(
            "UPDATE memory_nodes SET metadata=? WHERE node_id=?",
            (json.dumps({**json.loads(metadata), "supersedes": path}), node_id),
        )
    polling = memory(archive["data_dir"]).decision_history()[0]
    assert polling["superseded_by"]["title"] == "Use webhooks"


@pytest.mark.parametrize(
    "reference",
    [
        "Use polling",
        "0000000000000000",
        "wiki/decisions/../../private/x-0123456789abcdef.md",
        "private/decisions/2026-09-01-use-polling-{polling_id}.md",
    ],
)
def test_only_an_exact_reference_supersedes(tmp_path, reference):
    archive = decision_archive(tmp_path)
    db = archive["data_dir"] / "memory.db"
    reference = reference.format(polling_id=archive["polling_id"])
    with sqlite3.connect(db) as connection:
        [(node_id, metadata)] = connection.execute(
            "SELECT node_id, metadata FROM memory_nodes WHERE label='Use webhooks'"
        ).fetchall()
        connection.execute(
            "UPDATE memory_nodes SET metadata=? WHERE node_id=?",
            (json.dumps({**json.loads(metadata), "supersedes": reference}), node_id),
        )
    items = memory(archive["data_dir"]).decision_history()
    assert [item["effective_status"] for item in items][:2] == ["accepted", "accepted"]
    assert all(item["superseded_by"] is None and item["supersedes"] is None for item in items)


def test_a_private_decision_never_supersedes_a_shared_one_or_appears_by_default(tmp_path):
    archive = decision_archive(tmp_path)
    store = memory(archive["data_dir"])
    shared_only = {item["title"]: item for item in store.decision_history()}
    assert shared_only["Use polling"]["superseded_by"]["title"] == "Use webhooks"
    everything = store.decision_history(include_private=True)
    assert history_titles(everything) == [
        "Use polling",
        "Use webhooks",
        "Drop retries",
        "Leave the team",
    ]
    leave = everything[-1]
    assert leave["privacy"] == "private"
    assert leave["supersedes"] is None
    assert everything[0]["superseded_by"]["title"] == "Use webhooks"


def test_decision_history_limit_keeps_the_latest_and_stays_chronological(tmp_path):
    archive = decision_archive(tmp_path)
    store = memory(archive["data_dir"])
    assert history_titles(store.decision_history(limit=2)) == ["Use webhooks", "Drop retries"]
    for bad in (0, 201):
        with pytest.raises(ValueError):
            store.decision_history(limit=bad)


def test_decisions_indexed_before_supersedes_was_stored_still_list(tmp_path):
    archive = decision_archive(tmp_path)
    db = archive["data_dir"] / "memory.db"
    with sqlite3.connect(db) as connection:
        for node_id, metadata in connection.execute(
            "SELECT node_id, metadata FROM memory_nodes WHERE node_type='decision'"
        ).fetchall():
            legacy = {k: v for k, v in json.loads(metadata).items() if k != "supersedes"}
            connection.execute(
                "UPDATE memory_nodes SET metadata=? WHERE node_id=?",
                (json.dumps(legacy), node_id),
            )
    items = memory(archive["data_dir"]).decision_history()
    assert history_titles(items) == ["Use polling", "Use webhooks", "Drop retries"]
    assert all(item["superseded_by"] is None for item in items)


def test_cli_decision_history_is_shared_only_unless_private_is_requested(tmp_path, capsys):
    archive = decision_archive(tmp_path)
    config = str(write_config(tmp_path, archive["data_dir"]))
    assert main(["--config", config, "memory-decisions"]) == 0
    shared = json.loads(capsys.readouterr().out)
    assert shared["count"] == 3
    assert "Leave the team" not in json.dumps(shared)
    assert main(["--config", config, "memory-decisions", "--include-private", "--limit=10"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 4
    assert main(["--config", config, "memory-decisions", "--limit=0"]) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "invalid_decision_query"


def test_the_mcp_decision_history_tool_never_returns_private_decisions(tmp_path):
    archive = decision_archive(tmp_path)

    async def run():
        env = os.environ.copy()
        env["MEETING_WIKI_DATA_DIR"] = str(archive["data_dir"])
        params = StdioServerParameters(
            command=os.sys.executable,
            args=["-m", "meeting_wiki.mcp_server"],
            env=env,
            cwd=Path(__file__).parents[1],
        )
        async with (
            stdio_client(params) as (read_stream, write_stream),
            ClientSession(read_stream, write_stream) as session,
        ):
            await session.initialize()
            result = await session.call_tool("meeting_wiki_decision_history", {})
            assert history_titles(result.structured_content["items"]) == [
                "Use polling",
                "Use webhooks",
                "Drop retries",
            ]
            assert "Leave the team" not in json.dumps(result.structured_content)

    asyncio.run(run())


def point_webhooks_at(archive, reference):
    with sqlite3.connect(archive["data_dir"] / "memory.db") as connection:
        [(node_id, metadata)] = connection.execute(
            "SELECT node_id, metadata FROM memory_nodes WHERE label='Use webhooks'"
        ).fetchall()
        connection.execute(
            "UPDATE memory_nodes SET metadata=? WHERE node_id=?",
            (json.dumps({**json.loads(metadata), "supersedes": reference}), node_id),
        )


@pytest.mark.parametrize(
    "reference",
    [
        " {polling_id} ",
        "/wiki/decisions/2026-09-01-use-polling-{polling_id}.md",
        "wiki\\decisions\\2026-09-01-use-polling-{polling_id}.md",
    ],
)
def test_a_reference_is_normalized_the_same_way_the_wiki_resolves_it(tmp_path, reference):
    archive = decision_archive(tmp_path)
    point_webhooks_at(archive, reference.format(polling_id=archive["polling_id"]))
    assert memory(archive["data_dir"]).decision_history()[0]["superseded_by"]["title"] == (
        "Use webhooks"
    )


def test_only_an_earlier_decision_can_be_superseded(tmp_path):
    archive = decision_archive(tmp_path)
    store = memory(archive["data_dir"])
    webhooks_id = store.decision_history()[1]["decision_id"]
    point_webhooks_at(archive, webhooks_id)
    with sqlite3.connect(archive["data_dir"] / "memory.db") as connection:
        [(node_id, metadata)] = connection.execute(
            "SELECT node_id, metadata FROM memory_nodes WHERE label='Use polling'"
        ).fetchall()
        connection.execute(
            "UPDATE memory_nodes SET metadata=? WHERE node_id=?",
            (json.dumps({**json.loads(metadata), "supersedes": webhooks_id}), node_id),
        )
    # Webhooks naming itself or polling naming a later decision is ignored; no cycle forms.
    items = store.decision_history()
    assert [item["effective_status"] for item in items][:2] == ["accepted", "accepted"]
    assert all(item["superseded_by"] is None for item in items)


def test_the_latest_of_two_superseding_decisions_is_the_replacement(tmp_path):
    archive = decision_archive(tmp_path)
    meeting = make_meeting("Third review", 20)
    analysis = MeetingAnalysis(
        title="Third review",
        summary=["Third review summary."],
        decisions=[
            Decision(title="Use queues", decision="Queue it.", supersedes=archive["polling_id"])
        ],
    )
    store_meeting(archive["data_dir"], meeting, analysis, make_transcript(("Alex", "Hi.")))
    reindex_memory(archive["data_dir"])
    polling = memory(archive["data_dir"]).decision_history()[0]
    assert polling["superseded_by"]["title"] == "Use queues"


def test_a_decision_id_matches_the_one_the_wiki_page_records(tmp_path):
    archive = decision_archive(tmp_path)
    storage = LocalFileStorage(archive["data_dir"])
    pages = {
        key: storage.read_text(key)
        for key in storage.list_keys("wiki/decisions/")
        if "index" not in key
    }
    polling = memory(archive["data_dir"]).decision_history()[0]
    [page] = [text for key, text in pages.items() if key.endswith(f"-{polling['decision_id']}.md")]
    fields, _ = parse_frontmatter(page)
    assert fields["decision_id"] == polling["decision_id"]
    assert fields["status"] == "superseded"
