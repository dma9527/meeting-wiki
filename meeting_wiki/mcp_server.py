"""Read-only MCP tools over the rendered wiki."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from .config import load_config
from .providers.local_storage import LocalFileStorage
from .providers.s3_storage import S3Storage

READ_ONLY = ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False
)

config = load_config(Path(os.environ.get("MEETING_WIKI_CONFIG", "~/.meeting-wiki/config.toml")))
_storage_instance = None


def get_storage():
    """Construct storage on first tool call, not at MCP import/startup."""
    global _storage_instance
    if _storage_instance is None:
        _storage_instance = (
            LocalFileStorage(config.data_dir)
            if config.providers.storage == "local"
            else S3Storage(
                config.s3.bucket,
                config.s3.prefix,
                config.s3.region,
                config.s3.profile,
            )
        )
    return _storage_instance


server = MCPServer(
    "meeting_wiki_mcp",
    description="Read-only tools over an evolving local-first Markdown meeting wiki.",
)


def _frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return {}
    result = {}
    for line in lines[1:]:
        if line == "---":
            break
        if ":" in line:
            key, value = line.split(":", 1)
            raw = value.strip()
            try:
                parsed = json.loads(raw)
                result[key.strip()] = str(parsed) if not isinstance(parsed, list) else raw
            except json.JSONDecodeError:
                result[key.strip()] = raw.strip('"')
    return result


def _page(items: list, offset: int, limit: int) -> dict[str, object]:
    selected = items[offset : offset + limit]
    next_offset = offset + len(selected) if offset + len(selected) < len(items) else None
    return {
        "total": len(items),
        "count": len(selected),
        "offset": offset,
        "items": selected,
        "has_more": next_offset is not None,
        "next_offset": next_offset,
    }


def _safe_page(path: str) -> str:
    normalized = path.replace("\\", "/").lstrip("/")
    if normalized.startswith("wiki/"):
        normalized = normalized[5:]
    if ".." in normalized.split("/") or "\x00" in normalized:
        raise ValueError("Invalid page path")
    if not normalized.endswith(".md"):
        normalized += ".md"
    if not re.fullmatch(r"[A-Za-z0-9_./-]+\.md", normalized):
        raise ValueError("Invalid page path")
    return "wiki/" + normalized.lower()


@server.tool(name="meeting_wiki_search", annotations=READ_ONLY, structured_output=True)
def search(
    query: Annotated[str, Field(min_length=2, max_length=300)],
    limit: Annotated[int, Field(ge=1, le=30)] = 8,
    offset: Annotated[int, Field(ge=0)] = 0,
) -> dict[str, object]:
    """Search wiki pages by words/phrase and return ranked paths with snippets."""
    terms = [term.lower() for term in re.findall(r"[\w.-]+", query) if len(term) > 1]
    results = []
    for key in get_storage().list_keys("wiki/"):
        if not key.endswith(".md") or key.startswith("private/"):
            continue
        text = get_storage().read_text(key) or ""
        meta = _frontmatter(text)
        title = meta.get("title", key.rsplit("/", 1)[-1].removesuffix(".md"))
        lowered = text.lower()
        matches = sum(term in lowered for term in terms)
        if not matches:
            continue
        score = matches * 10 + sum(8 for term in terms if term in title.lower())
        snippets = []
        for number, line in enumerate(text.splitlines(), 1):
            if any(term in line.lower() for term in terms):
                snippets.append({"line": number, "text": line[:400]})
                if len(snippets) == 3:
                    break
        results.append(
            {
                "path": key.removeprefix("wiki/"),
                "title": title,
                "description": meta.get("description", ""),
                "score": score,
                "snippets": snippets,
            }
        )
    results.sort(key=lambda item: (-item["score"], item["path"]))
    return _page(results, offset, limit)


@server.tool(name="meeting_wiki_read_page", annotations=READ_ONLY, structured_output=True)
def read_page(
    path: Annotated[str, Field(min_length=3, max_length=300)],
    offset: Annotated[int, Field(ge=0)] = 0,
    limit_chars: Annotated[int, Field(ge=500, le=40_000)] = 12_000,
) -> dict[str, object]:
    """Read one exact wiki page with character pagination."""
    try:
        key = _safe_page(path)
    except ValueError as error:
        return {"error": str(error), "suggestion": "Use meeting_wiki_search first."}
    text = get_storage().read_text(key)
    if text is None:
        return {"error": f"Page not found: {key}", "suggestion": "Use meeting_wiki_search first."}
    content = text[offset : offset + limit_chars]
    next_offset = offset + len(content) if offset + len(content) < len(text) else None
    return {
        "path": key.removeprefix("wiki/"),
        "total_chars": len(text),
        "offset": offset,
        "content": content,
        "has_more": next_offset is not None,
        "next_offset": next_offset,
    }


@server.tool(name="meeting_wiki_list_recent", annotations=READ_ONLY, structured_output=True)
def list_recent(
    limit: Annotated[int, Field(ge=1, le=50)] = 10,
    offset: Annotated[int, Field(ge=0)] = 0,
) -> dict[str, object]:
    """List recent meeting pages from frontmatter timestamps."""
    meetings = []
    for key in get_storage().list_keys("wiki/meetings/"):
        if not key.endswith(".md") or key.endswith("index.md"):
            continue
        text = get_storage().read_text(key) or ""
        meta = _frontmatter(text)
        meetings.append(
            {
                "path": key.removeprefix("wiki/"),
                "title": meta.get("title", key),
                "timestamp": meta.get("timestamp", ""),
                "meeting_type": meta.get("meeting_type", "generic"),
                "description": meta.get("description", ""),
            }
        )
    meetings.sort(key=lambda item: (item["timestamp"], item["path"]), reverse=True)
    return _page(meetings, offset, limit)


@server.tool(name="meeting_wiki_action_items", annotations=READ_ONLY, structured_output=True)
def action_items(
    owner: str | None = None,
    query: str | None = None,
    limit: Annotated[int, Field(ge=1, le=100)] = 30,
    offset: Annotated[int, Field(ge=0)] = 0,
) -> dict[str, object]:
    """List open action-item rows, optionally filtered by owner or text."""
    text = get_storage().read_text("wiki/action-items/active.md") or ""
    owner_term = (owner or "").lower()
    query_term = (query or "").lower()
    rows = []
    for line in text.splitlines():
        lowered = line.lower()
        if not line.startswith("|") or line.startswith("|---") or "| owner |" in lowered:
            continue
        if owner_term and owner_term not in lowered:
            continue
        if query_term and query_term not in lowered:
            continue
        if "| done |" in lowered:
            continue
        rows.append(line)
    return _page(rows, offset, limit)


def main() -> None:
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
