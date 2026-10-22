from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Iterable, Sequence
from contextlib import closing
from pathlib import Path

from .models import MeetingAnalysis, MeetingInput, TranscriptResult
from .wiki import canonical, stable_id

# (meeting, analysis, transcript, meeting_key) as accepted by index_meeting.
MemoryEntry = tuple[MeetingInput, MeetingAnalysis, TranscriptResult, str]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_nodes (
    node_id TEXT PRIMARY KEY,
    node_type TEXT NOT NULL,
    label TEXT NOT NULL,
    content TEXT NOT NULL,
    source_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    privacy TEXT NOT NULL CHECK(privacy IN ('shared', 'private')),
    metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_edges (
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY(source_node_id, target_node_id, relation, source_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_node_id, relation);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_source ON memory_nodes(source_id);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    node_id UNINDEXED,
    label,
    content,
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS memory_resources (
    resource_id TEXT PRIMARY KEY,
    meeting_node_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_resources_meeting ON memory_resources(meeting_node_id);
"""

NODE_TYPES = frozenset(
    {"meeting", "person", "transcript_segment", "topic", "decision", "action_item", "resource"}
)
_RELATION_LIMIT = 12
_MEETING_NODE_ID = re.compile(r"meeting:[0-9a-f]{16}")


class ResourceError(ValueError):
    """Fixed, input-free reason for a refused resource operation."""


class MemoryStore:
    """Local canonical memory and full-text retrieval over meeting facts."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(_SCHEMA)
        os.chmod(self.path, 0o600)

    @staticmethod
    def _node_id(node_type: str, *parts: str) -> str:
        return f"{node_type}:{stable_id(*parts)}"

    @classmethod
    def _entity_node_id(
        cls,
        node_type: str,
        label: str,
        privacy: str,
        source_id: str,
    ) -> str:
        scope = "" if privacy == "shared" else source_id
        return cls._node_id(node_type, privacy, scope, canonical(label))

    @staticmethod
    def _metadata(**values: object) -> str:
        return json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def _upsert_node(
        self,
        connection: sqlite3.Connection,
        *,
        node_id: str,
        node_type: str,
        label: str,
        content: str,
        source_id: str,
        occurred_at: str,
        privacy: str,
        metadata: str,
    ) -> None:
        connection.execute(
            """INSERT INTO memory_nodes
               (node_id, node_type, label, content, source_id, occurred_at, privacy, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(node_id) DO UPDATE SET
                 node_type=excluded.node_type, label=excluded.label, content=excluded.content,
                 source_id=excluded.source_id, occurred_at=excluded.occurred_at,
                 privacy=excluded.privacy, metadata=excluded.metadata""",
            (node_id, node_type, label, content, source_id, occurred_at, privacy, metadata),
        )
        connection.execute("DELETE FROM memory_fts WHERE node_id=?", (node_id,))
        connection.execute(
            "INSERT INTO memory_fts (node_id, label, content) VALUES (?, ?, ?)",
            (node_id, label, content),
        )

    @staticmethod
    def _link(
        connection: sqlite3.Connection,
        source_node_id: str,
        target_node_id: str,
        relation: str,
        source_id: str,
    ) -> None:
        connection.execute(
            """INSERT OR IGNORE INTO memory_edges
               (source_node_id, target_node_id, relation, source_id) VALUES (?, ?, ?, ?)""",
            (source_node_id, target_node_id, relation, source_id),
        )

    def index_meeting(
        self,
        meeting: MeetingInput,
        analysis: MeetingAnalysis,
        transcript: TranscriptResult,
        meeting_key: str,
    ) -> None:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                self._index_meeting(connection, meeting, analysis, transcript, meeting_key)
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def rebuild(self, entries: Iterable[MemoryEntry]) -> int:
        """Replace all memory with ``entries`` in one transaction; readers never see a gap."""
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("DELETE FROM memory_fts")
                connection.execute("DELETE FROM memory_edges")
                connection.execute("DELETE FROM memory_nodes")
                count = 0
                for entry in entries:
                    self._index_meeting(connection, *entry)
                    count += 1
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return count

    def _index_meeting(
        self,
        connection: sqlite3.Connection,
        meeting: MeetingInput,
        analysis: MeetingAnalysis,
        transcript: TranscriptResult,
        meeting_key: str,
    ) -> None:
        source_id = meeting.ingest_id
        occurred_at = meeting.occurred_at.isoformat()
        privacy = "private" if analysis.private else "shared"
        entity_source = source_id if privacy == "private" else ""
        meeting_node_id = self._node_id("meeting", source_id)
        summary = "\n".join(analysis.summary)
        # Private people/topics are meeting-scoped; legacy rows had no source, so
        # they are found through this meeting's edges. Shared entities stay global.
        stale_nodes = connection.execute(
            """SELECT node_id FROM memory_nodes WHERE source_id=?
               UNION
               SELECT nodes.node_id FROM memory_nodes AS nodes
               JOIN memory_edges AS edges
                 ON nodes.node_id IN (edges.source_node_id, edges.target_node_id)
               WHERE edges.source_id=? AND nodes.source_id='' AND nodes.privacy='private'
                 AND nodes.node_type IN ('person', 'topic')""",
            (source_id, source_id),
        ).fetchall()
        for row in stale_nodes:
            connection.execute("DELETE FROM memory_fts WHERE node_id=?", (row["node_id"],))
            connection.execute("DELETE FROM memory_nodes WHERE node_id=?", (row["node_id"],))
        connection.execute("DELETE FROM memory_edges WHERE source_id=?", (source_id,))
        self._upsert_node(
            connection,
            node_id=meeting_node_id,
            node_type="meeting",
            label=analysis.title,
            content=summary,
            source_id=source_id,
            occurred_at=occurred_at,
            privacy=privacy,
            metadata=self._metadata(
                meeting_key=meeting_key,
                meeting_type=analysis.meeting_type,
            ),
        )
        people = {
            participant.name
            for participant in analysis.participants
            if participant.name.strip()
        }
        people.update(segment.speaker for segment in transcript.segments if segment.speaker)
        for name in sorted(people):
            person_id = self._entity_node_id("person", name, privacy, source_id)
            self._upsert_node(
                connection,
                node_id=person_id,
                node_type="person",
                label=name,
                content="",
                source_id=entity_source,
                occurred_at="",
                privacy=privacy,
                metadata=self._metadata(canonical_name=canonical(name)),
            )
            self._link(connection, person_id, meeting_node_id, "mentioned_in", source_id)
        for index, segment in enumerate(transcript.segments):
            segment_id = self._node_id("segment", source_id, str(index))
            self._upsert_node(
                connection,
                node_id=segment_id,
                node_type="transcript_segment",
                label=segment.speaker or "Unknown speaker",
                content=segment.text,
                source_id=source_id,
                occurred_at=occurred_at,
                privacy=privacy,
                metadata=self._metadata(
                    start_seconds=segment.start_seconds,
                    end_seconds=segment.end_seconds,
                    speaker=segment.speaker,
                ),
            )
            self._link(connection, segment_id, meeting_node_id, "part_of", source_id)
            if segment.speaker:
                person_id = self._entity_node_id(
                    "person", segment.speaker, privacy, source_id
                )
                self._link(connection, segment_id, person_id, "attributed_to", source_id)
        for topic in analysis.topics:
            topic_id = self._entity_node_id("topic", topic.topic, privacy, source_id)
            self._upsert_node(
                connection,
                node_id=topic_id,
                node_type="topic",
                label=topic.topic,
                content=topic.insight,
                source_id=entity_source,
                occurred_at="",
                privacy=privacy,
                metadata=self._metadata(canonical_topic=canonical(topic.topic)),
            )
            self._link(connection, meeting_node_id, topic_id, "discussed_in", source_id)
        for decision in analysis.decisions:
            decision_id = self._node_id("decision", source_id, decision.title)
            self._upsert_node(
                connection,
                node_id=decision_id,
                node_type="decision",
                label=decision.title,
                content=f"{decision.decision}\n{decision.rationale or ''}".strip(),
                source_id=source_id,
                occurred_at=occurred_at,
                privacy=privacy,
                metadata=self._metadata(status=decision.status, owner=decision.owner),
            )
            self._link(connection, decision_id, meeting_node_id, "decided_in", source_id)
            if decision.owner:
                owner_id = self._entity_node_id(
                    "person", decision.owner, privacy, source_id
                )
                self._link(connection, decision_id, owner_id, "owned_by", source_id)
        for index, action in enumerate(analysis.action_items):
            action_id = self._node_id("action", source_id, str(index), action.action)
            self._upsert_node(
                connection,
                node_id=action_id,
                node_type="action_item",
                label=action.action,
                content=action.action,
                source_id=source_id,
                occurred_at=occurred_at,
                privacy=privacy,
                metadata=self._metadata(
                    owner=action.owner,
                    due=action.due,
                    done=action.done,
                ),
            )
            self._link(connection, action_id, meeting_node_id, "assigned_in", source_id)
            if action.owner and action.owner != "Unassigned":
                owner_id = self._entity_node_id("person", action.owner, privacy, source_id)
                self._link(connection, action_id, owner_id, "assigned_to", source_id)
        self._project_resources(connection, meeting_node_id)

    def _project_resources(self, connection: sqlite3.Connection, meeting_node_id: str) -> None:
        """Project user resources onto their meeting; they inherit its privacy and source."""
        meeting = connection.execute(
            "SELECT source_id, occurred_at, privacy FROM memory_nodes "
            "WHERE node_id=? AND node_type='meeting'",
            (meeting_node_id,),
        ).fetchone()
        if meeting is None:
            return
        rows = connection.execute(
            "SELECT * FROM memory_resources WHERE meeting_node_id=? "
            "ORDER BY created_at, resource_id",
            (meeting_node_id,),
        ).fetchall()
        for row in rows:
            self._upsert_node(
                connection,
                node_id=row["resource_id"],
                node_type="resource",
                label=row["title"],
                content=f"{row['summary']}\n{row['url']}".strip(),
                source_id=meeting["source_id"],
                occurred_at=meeting["occurred_at"],
                privacy=meeting["privacy"],
                metadata=self._metadata(url=row["url"], relation=row["relation"]),
            )
            self._link(
                connection, row["resource_id"], meeting_node_id, row["relation"],
                meeting["source_id"],
            )

    def add_resource(
        self,
        *,
        meeting_node_id: str,
        url: str,
        title: str,
        summary: str,
        relation: str,
        created_at: str,
        allow_private: bool = False,
    ) -> dict[str, object]:
        """Attach validated resource fields to a canonical meeting. Nothing is fetched."""
        if not isinstance(meeting_node_id, str) or not _MEETING_NODE_ID.fullmatch(
            meeting_node_id
        ):
            raise ResourceError("meeting_unavailable")
        resource_id = self._node_id("resource", meeting_node_id, url)
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                meeting = connection.execute(
                    "SELECT privacy FROM memory_nodes WHERE node_id=? AND node_type='meeting'",
                    (meeting_node_id,),
                ).fetchone()
                # Missing and private-without-opt-in look identical to the caller.
                hidden = meeting is not None and meeting["privacy"] != "shared"
                if meeting is None or (hidden and allow_private is not True):
                    raise ResourceError("meeting_unavailable")
                exists = connection.execute(
                    "SELECT 1 FROM memory_resources WHERE resource_id=?", (resource_id,)
                ).fetchone()
                if exists:
                    raise ResourceError("resource_exists")
                connection.execute(
                    """INSERT INTO memory_resources
                       (resource_id, meeting_node_id, url, title, summary, relation, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (resource_id, meeting_node_id, url, title, summary, relation, created_at),
                )
                self._project_resources(connection, meeting_node_id)
                privacy = meeting["privacy"]
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return {
            "resource_id": resource_id,
            "meeting_node_id": meeting_node_id,
            "url": url,
            "title": title,
            "relation": relation,
            "privacy": privacy,
        }

    def list_resources(
        self,
        *,
        meeting_node_id: str | None = None,
        include_private: bool = False,
        limit: int = 50,
    ) -> list[dict[str, object]]:
        """List resources; a resource whose meeting is gone or private needs include_private."""
        if not 1 <= limit <= 200:
            raise ValueError("Resource limit must be from 1 to 200")
        clauses: list[str] = []
        params: list[object] = []
        if meeting_node_id is not None:
            if not _MEETING_NODE_ID.fullmatch(meeting_node_id):
                raise ValueError("Invalid meeting node id")
            clauses.append("resources.meeting_node_id=?")
            params.append(meeting_node_id)
        if include_private is not True:
            clauses.append("meetings.privacy='shared'")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        statement = f"""
            SELECT resources.*, meetings.label AS meeting_title, meetings.privacy AS privacy
            FROM memory_resources AS resources
            LEFT JOIN memory_nodes AS meetings
              ON meetings.node_id=resources.meeting_node_id AND meetings.node_type='meeting'
            {where}
            ORDER BY resources.created_at DESC, resources.resource_id
            LIMIT ?
        """
        with closing(self._connect()) as connection:
            rows = connection.execute(statement, params).fetchall()
        return [
            {
                "resource_id": row["resource_id"],
                "meeting_node_id": row["meeting_node_id"],
                "meeting_title": row["meeting_title"] or "",
                "url": row["url"],
                "title": row["title"],
                "summary": row["summary"],
                "relation": row["relation"],
                "created_at": row["created_at"],
                # Orphaned resources fail closed as private.
                "privacy": "shared" if row["privacy"] == "shared" else "private",
                "orphaned": row["privacy"] is None,
            }
            for row in rows
        ]

    @staticmethod
    def _fts_query(query: str) -> str:
        terms = [term for term in re.findall(r"[\w.-]+", query, flags=re.UNICODE) if len(term) > 1]
        if not terms:
            raise ValueError("Search query must include at least two characters")
        return " AND ".join(f'"{term.replace(chr(34), "")}"' for term in terms[:20])

    @staticmethod
    def _node_types(node_type: str | None, node_types: Sequence[str] | None) -> list[str]:
        selected = sorted({*(node_types or ()), *([node_type] if node_type else [])})
        unknown = [value for value in selected if value not in NODE_TYPES]
        if unknown:
            raise ValueError(f"Unknown memory node type: {unknown[0][:40]}")
        return selected

    def search(
        self,
        query: str,
        *,
        node_type: str | None = None,
        node_types: Sequence[str] | None = None,
        limit: int = 20,
        include_private: bool = False,
    ) -> list[dict[str, object]]:
        """Full-text search; private nodes, relations, and sources need include_private."""
        if not 1 <= limit <= 100:
            raise ValueError("Search limit must be from 1 to 100")
        clauses = ["memory_fts MATCH ?"]
        params: list[object] = [self._fts_query(query)]
        if include_private is not True:
            clauses.append("nodes.privacy='shared'")
        selected = self._node_types(node_type, node_types)
        if selected:
            clauses.append(f"nodes.node_type IN ({', '.join('?' for _ in selected)})")
            params.extend(selected)
        params.append(limit)
        where = " AND ".join(clauses)
        statement = f"""
            SELECT nodes.node_id, nodes.node_type, nodes.label, nodes.content,
                   nodes.source_id, nodes.occurred_at, nodes.privacy, nodes.metadata,
                   bm25(memory_fts, 4.0, 1.0) AS rank
            FROM memory_fts JOIN memory_nodes AS nodes ON nodes.node_id=memory_fts.node_id
            WHERE {where}
            ORDER BY rank, nodes.occurred_at DESC, nodes.node_id
            LIMIT ?
        """
        visible = "" if include_private is True else "AND nodes.privacy='shared'"
        relation_statement = f"""
            SELECT * FROM (
                SELECT edges.relation, 'out' AS direction, nodes.node_id, nodes.node_type,
                       nodes.label, edges.source_id
                FROM memory_edges AS edges
                JOIN memory_nodes AS nodes ON nodes.node_id=edges.target_node_id
                WHERE edges.source_node_id=? {visible}
                UNION ALL
                SELECT edges.relation, 'in' AS direction, nodes.node_id, nodes.node_type,
                       nodes.label, edges.source_id
                FROM memory_edges AS edges
                JOIN memory_nodes AS nodes ON nodes.node_id=edges.source_node_id
                WHERE edges.target_node_id=? {visible}
            )
            ORDER BY node_type='transcript_segment', direction DESC, relation, label, node_id
            LIMIT {_RELATION_LIMIT}
        """
        source_statement = f"""
            SELECT nodes.label, nodes.occurred_at, nodes.privacy, nodes.metadata
            FROM memory_nodes AS nodes WHERE nodes.node_id=? {visible}
        """
        with closing(self._connect()) as connection:
            rows = connection.execute(statement, params).fetchall()
            sources: dict[str, dict[str, object] | None] = {}

            def source_for(source_id: str) -> dict[str, object] | None:
                if not source_id:
                    return None
                if source_id not in sources:
                    found = connection.execute(
                        source_statement, (self._node_id("meeting", source_id),)
                    ).fetchone()
                    sources[source_id] = (
                        {
                            "source_id": source_id,
                            "title": found["label"],
                            "occurred_at": found["occurred_at"],
                            "privacy": found["privacy"],
                            "meeting_key": json.loads(found["metadata"]).get("meeting_key", ""),
                        }
                        if found
                        else None
                    )
                return sources[source_id]

            result: list[dict[str, object]] = []
            for row in rows:
                relations = connection.execute(
                    relation_statement, (row["node_id"], row["node_id"])
                ).fetchall()
                result.append(
                    {
                        "node_id": row["node_id"],
                        "node_type": row["node_type"],
                        "label": row["label"],
                        "content": row["content"][:800],
                        "source_id": row["source_id"],
                        "occurred_at": row["occurred_at"],
                        "privacy": row["privacy"],
                        "metadata": json.loads(row["metadata"]),
                        "source": source_for(row["source_id"]),
                        "relations": [
                            {
                                "relation": relation["relation"],
                                "direction": relation["direction"],
                                "node_id": relation["node_id"],
                                "node_type": relation["node_type"],
                                "label": relation["label"][:200],
                                "source": source_for(relation["source_id"]),
                            }
                            for relation in relations
                        ],
                    }
                )
            return result
