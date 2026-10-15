from __future__ import annotations

import pytest

from meeting_wiki.models import TranscriptSegment


def test_deduplicate_segments_keeps_ordered_new_final_text():
    from meeting_wiki.live import deduplicate_segments

    existing = [TranscriptSegment(start_seconds=0, end_seconds=1, text="Hello world")]
    incoming = [
        TranscriptSegment(start_seconds=0, end_seconds=1, text=" hello   world "),
        TranscriptSegment(start_seconds=1, end_seconds=2, text="Next point"),
    ]

    assert deduplicate_segments(existing, incoming) == [incoming[1]]


def test_session_rejects_missing_or_invalid_token():
    from meeting_wiki.live import validate_session_message

    with pytest.raises(PermissionError):
        validate_session_message({"type": "ready"}, "test-token")
    with pytest.raises(PermissionError):
        validate_session_message({"type": "ready", "token": "wrong"}, "test-token")
    valid_message = {"type": "ready", "token": "test-token"}
    assert validate_session_message(valid_message, "test-token") == "ready"


def test_loopback_bridge_uses_an_ephemeral_local_port():
    import asyncio

    from meeting_wiki.live import LoopbackBridge

    async def run() -> int:
        bridge = LoopbackBridge("test-token")
        port = await bridge.start()
        await bridge.close()
        return port

    assert asyncio.run(run()) > 0
