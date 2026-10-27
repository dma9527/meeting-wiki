"""The citation reference in docs/reference/citations.md must match build_citation."""

from __future__ import annotations

import json
import re
from pathlib import Path

from meeting_wiki.memory import CITATION_VERSION, MemoryStore, build_citation

DOC = Path(__file__).resolve().parents[1] / "docs" / "reference" / "citations.md"
SOURCE = {
    "source_id": "0123456789abcdef",
    "title": "Rollout sync",
    "occurred_at": "2026-09-01T15:00:00+00:00",
    "privacy": "shared",
    "meeting_key": "wiki/meetings/2026-09-01-rollout-sync.md",
}


def documented_example() -> dict[str, object]:
    block = re.search(r"```json\n(\{.*?\})\n```", DOC.read_text(), re.S)
    assert block is not None
    return json.loads(block.group(1))


def test_documented_example_is_what_the_code_builds() -> None:
    assert documented_example() == build_citation(SOURCE, "meeting", {})
    assert documented_example()["meeting_id"] == MemoryStore._node_id("meeting", "0123456789abcdef")
    assert documented_example()["version"] == CITATION_VERSION


def test_documented_fields_match_code_fields() -> None:
    table_fields = set(re.findall(r"^\| `(\w+)` \|", DOC.read_text(), re.M))
    assert table_fields == set(build_citation(SOURCE, "meeting", {}))


def test_documented_transcript_anchor_keys() -> None:
    metadata = {"start_seconds": 12.5, "end_seconds": 20.0, "index": 3}
    anchor = build_citation(SOURCE, "transcript_segment", metadata)["anchor"]
    text = DOC.read_text()
    assert all(f'"{key}"' in text for key in ("kind", *metadata))
    assert set(anchor) == {"kind", *metadata}
