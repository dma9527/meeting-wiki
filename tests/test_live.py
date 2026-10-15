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


def test_ollama_live_language_provider_uses_chinese_target(monkeypatch):
    from meeting_wiki.providers.live import OllamaLiveLanguageProvider

    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"message": {"content": "中文翻译"}}

    def fake_post(url, json, timeout):
        captured.update({"url": url, "json": json, "timeout": timeout})
        return Response()

    monkeypatch.setattr("meeting_wiki.providers.live.httpx.post", fake_post)
    provider = OllamaLiveLanguageProvider("http://127.0.0.1:11434", "qwen3:8b", 30)
    assert provider.translate("Hello", "zh") == "中文翻译"
    assert "Chinese" in captured["json"]["messages"][0]["content"]
