from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path

from .models import MeetingAnalysis, MeetingInput, TranscriptResult
from .wiki import canonical, stable_id

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
"""


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
        source_id = meeting.ingest_id
        occurred_at = meeting.occurred_at.isoformat()
        privacy = "private" if analysis.private else "shared"
        meeting_node_id = self._node_id("meeting", source_id)
        summary = "\n".join(analysis.summary)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                stale_nodes = connection.execute(
                    "SELECT node_id FROM memory_nodes WHERE source_id=?", (source_id,)
                ).fetchall()
                for row in stale_nodes:
                    connection.execute("DELETE FROM memory_fts WHERE node_id=?", (row["node_id"],))
                connection.execute("DELETE FROM memory_nodes WHERE source_id=?", (source_id,))
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
                        source_id="",
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
                        source_id="",
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
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    @staticmethod
    def _fts_query(query: str) -> str:
        terms = [term for term in re.findall(r"[\w.-]+", query, flags=re.UNICODE) if len(term) > 1]
        if not terms:
            raise ValueError("Search query must include at least two characters")
        return " AND ".join(f'"{term.replace(chr(34), "")}"' for term in terms[:20])

    def search(
        self,
        query: str,
        *,
        node_type: str | None = None,
        limit: int = 20,
        include_private: bool = False,
    ) -> list[dict[str, object]]:
        if not 1 <= limit <= 100:
            raise ValueError("Search limit must be from 1 to 100")
        clauses = ["memory_fts MATCH ?"]
        params: list[object] = [self._fts_query(query)]
        if not include_private:
            clauses.append("nodes.privacy='shared'")
        if node_type:
            clauses.append("nodes.node_type=?")
            params.append(node_type)
        params.append(limit)
        where = " AND ".join(clauses)
        statement = f"""
            SELECT nodes.node_id, nodes.node_type, nodes.label, nodes.content,
                   nodes.source_id, nodes.occurred_at, nodes.metadata,
                   bm25(memory_fts, 4.0, 1.0) AS rank
            FROM memory_fts JOIN memory_nodes AS nodes ON nodes.node_id=memory_fts.node_id
            WHERE {where}
            ORDER BY rank, nodes.occurred_at DESC, nodes.node_id
            LIMIT ?
        """
        with self._connect() as connection:
            rows = connection.execute(statement, params).fetchall()
            result: list[dict[str, object]] = []
            for row in rows:
                relations = connection.execute(
                    """SELECT relation, target_node_id FROM memory_edges
                       WHERE source_node_id=? ORDER BY relation, target_node_id LIMIT 12""",
                    (row["node_id"],),
                ).fetchall()
                result.append(
                    {
                        "node_id": row["node_id"],
                        "node_type": row["node_type"],
                        "label": row["label"],
                        "content": row["content"][:800],
                        "source_id": row["source_id"],
                        "occurred_at": row["occurred_at"],
                        "metadata": json.loads(row["metadata"]),
                        "relations": [dict(relation) for relation in relations],
                    }
                )
            return result
