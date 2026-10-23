from __future__ import annotations

import json

from meeting_wiki.config import PrivacyConfig
from meeting_wiki.models import MeetingAnalysis, MeetingType
from meeting_wiki.providers.llm import (
    OpenAICompatibleProvider,
    _validate,
    analysis_messages,
    openai_strict_schema,
)


def valid_analysis_payload() -> dict[str, object]:
    return {
        "title": "Architecture Design Review",
        "meeting_type": "design-review",
        "summary": ["The team selected option B."],
        "participants": [],
        "blockers": [],
        "decisions": [],
        "action_items": [],
        "topics": [],
        "open_questions": [],
        "risks": [],
        "private": False,
    }


def test_openai_strict_schema_requires_every_object_property_without_defaults():
    strict_schema = openai_strict_schema(MeetingAnalysis.model_json_schema())

    def assert_strict_objects(schema: object) -> None:
        if isinstance(schema, dict):
            properties = schema.get("properties")
            if isinstance(properties, dict):
                assert schema["required"] == list(properties)
                assert schema["additionalProperties"] is False
            assert "default" not in schema
            assert "minLength" not in schema
            assert "maxLength" not in schema
            for value in schema.values():
                assert_strict_objects(value)
        elif isinstance(schema, list):
            for value in schema:
                assert_strict_objects(value)

    assert_strict_objects(strict_schema)


def test_openai_fallback_supplies_output_schema_and_wraps_input(monkeypatch, meeting, transcript):
    calls: list[dict[str, object]] = []

    class Response:
        def __init__(self, status_code: int, payload: dict[str, object]):
            self.status_code = status_code
            self._payload = payload

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise RuntimeError("HTTP failure")

        def json(self) -> dict[str, object]:
            return self._payload

    def fake_post(url: str, *, headers: dict[str, str], json: dict[str, object], timeout: float):
        calls.append(json)
        if len(calls) == 1:
            return Response(400, {"error": {"message": "strict schema rejected"}})
        return Response(
            200,
            {"choices": [{"message": {"content": json_module.dumps(valid_analysis_payload())}}]},
        )

    json_module = json
    monkeypatch.setattr("meeting_wiki.providers.llm.httpx.post", fake_post)
    provider = OpenAICompatibleProvider(
        "https://provider.example.test/v1", "test-model", "test-key", 30, PrivacyConfig()
    )

    result = provider.analyze(meeting, transcript)

    assert result.summary == ["The team selected option B."]
    assert len(calls) == 2
    fallback_messages = calls[1]["messages"]
    assert isinstance(fallback_messages, list)
    assert "output schema" in fallback_messages[0]["content"].lower()
    fallback_input = json.loads(fallback_messages[1]["content"])
    assert set(fallback_input) == {"input"}
    assert "attendees" in fallback_input["input"]


def test_analysis_prompt_applies_memory_language_only_to_user_visible_text(meeting, transcript):
    system, _, _ = analysis_messages(meeting, transcript, PrivacyConfig(), "zh-CN")

    assert "Write summaries, blocker descriptions, decision details" in system
    assert "Keep the meeting title, topic names, decision titles" in system


def test_analysis_prompt_keeps_source_language_without_translation(meeting, transcript):
    system, _, _ = analysis_messages(meeting, transcript, PrivacyConfig(), "source")

    assert "in the language the speakers used. Do not translate." in system
    assert "Simplified Chinese" not in system
    assert "Keep the meeting title, topic names, decision titles" in system


def test_validation_keeps_explicit_meeting_title_across_output_languages(meeting, transcript):
    payload = valid_analysis_payload()
    payload["title"] = "架构评审"
    explicit = meeting.model_copy(update={"title": "Architecture Review", "title_explicit": True})
    automatic = meeting.model_copy(update={"title": "Meeting 2026", "title_explicit": False})

    assert (
        _validate(payload, explicit, MeetingType.DESIGN_REVIEW, transcript).title
        == "Architecture Review"
    )
    assert _validate(payload, automatic, MeetingType.DESIGN_REVIEW, transcript).title == "架构评审"
