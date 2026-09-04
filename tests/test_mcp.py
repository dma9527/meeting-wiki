from __future__ import annotations

import asyncio
import os
from pathlib import Path

from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


def test_stdio_mcp_search_read_recent_and_private_exclusion(tmp_path):
    data_dir = tmp_path / "data"
    meetings = data_dir / "wiki" / "meetings"
    meetings.mkdir(parents=True)
    (meetings / "2026-09-04-design.md").write_text(
        """---
type: meeting
title: Design Review
description: Selected option B.
timestamp: 2026-09-04T12:00:00Z
meeting_type: design-review
---
# Design Review
Option B was selected.
"""
    )
    private = data_dir / "private" / "meetings"
    private.mkdir(parents=True)
    (private / "secret.md").write_text("secret career discussion")
    actions = data_dir / "wiki" / "action-items"
    actions.mkdir(parents=True)
    (actions / "active.md").write_text(
        "| Owner | Action | Source | Due | Status |\n"
        "|---|---|---|---|---|\n"
        "| Alex | Write plan | meeting | | open |\n"
    )

    async def run():
        env = os.environ.copy()
        env["MEETING_WIKI_DATA_DIR"] = str(data_dir)
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
            tools = await session.list_tools()
            assert {tool.name for tool in tools.tools} == {
                "meeting_wiki_search",
                "meeting_wiki_read_page",
                "meeting_wiki_list_recent",
                "meeting_wiki_action_items",
            }
            assert all(tool.annotations.read_only_hint for tool in tools.tools)
            search = await session.call_tool(
                "meeting_wiki_search", {"query": "option B", "limit": 5}
            )
            assert search.structured_content["count"] == 1
            assert "private" not in str(search.structured_content).lower()
            page = await session.call_tool(
                "meeting_wiki_read_page",
                {"path": "meetings/2026-09-04-design.md", "limit_chars": 500},
            )
            assert "Option B" in page.structured_content["content"]
            traversal = await session.call_tool(
                "meeting_wiki_read_page", {"path": "../../private/meetings/secret.md"}
            )
            assert "error" in traversal.structured_content
            recent = await session.call_tool("meeting_wiki_list_recent", {"limit": 1})
            assert recent.structured_content["items"][0]["meeting_type"] == "design-review"
            action_items = await session.call_tool("meeting_wiki_action_items", {"owner": "Alex"})
            assert action_items.structured_content["count"] == 1

    asyncio.run(run())


def test_mcp_initializes_with_s3_config_without_credentials(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text(
        """[providers]
storage = "s3"
transcription = "text"
llm = "ollama"
calendar = "none"
notification = "none"
task = "none"
[s3]
bucket = "test-bucket"
profile = "profile-that-does-not-exist"
"""
    )

    async def run():
        env = os.environ.copy()
        env["MEETING_WIKI_CONFIG"] = str(config)
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
            tools = await session.list_tools()
            assert len(tools.tools) == 4

    asyncio.run(run())
