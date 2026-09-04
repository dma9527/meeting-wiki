from __future__ import annotations

import json

import httpx
import pytest

from meeting_wiki.config import PrivacyConfig
from meeting_wiki.models import MeetingType
from meeting_wiki.providers.llm import OllamaProvider, OpenAICompatibleProvider


def analysis_payload(private=False):
    return {
        "title": "Review",
        "meeting_type": "generic",
        "summary": ["Selected option B."],
        "participants": [],
        "blockers": [],
        "decisions": [],
        "action_items": [],
        "topics": [],
        "open_questions": [],
        "risks": [],
        "private": private,
    }


class Response:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self.body = body
        self.request = httpx.Request("POST", "http://test")

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=self.request, response=self)


def test_ollama_uses_json_schema_and_classifier_overrides_model(monkeypatch, meeting, transcript):
    requests = []

    def fake_post(url, json, timeout):
        requests.append(json)
        return Response(200, {"message": {"content": __import__("json").dumps(analysis_payload())}})

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = OllamaProvider("http://localhost:11434", "model", 10, 8192, PrivacyConfig())
    result = provider.analyze(meeting, transcript)
    assert result.meeting_type is MeetingType.DESIGN_REVIEW
    assert result.private is False
    assert requests[0]["format"]["properties"]["summary"]
    assert requests[0]["options"]["temperature"] == 0


def test_private_classification_cannot_be_overridden_by_model(monkeypatch, meeting, transcript):
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *args, **kwargs: Response(
            200, {"message": {"content": json.dumps(analysis_payload(private=False))}}
        ),
    )
    private = meeting.model_copy(update={"private": True, "meeting_type": MeetingType.ONE_ON_ONE})
    provider = OllamaProvider("http://localhost:11434", "model", 10, 8192, PrivacyConfig())
    result = provider.analyze(private, transcript)
    assert result.private is True
    assert result.meeting_type is MeetingType.ONE_ON_ONE


def test_openai_compatible_falls_back_to_json_object(monkeypatch, meeting, transcript):
    requests = []

    def fake_post(url, headers, json, timeout):
        requests.append(json)
        if len(requests) == 1:
            return Response(400, {"error": "json_schema unsupported"})
        return Response(
            200,
            {"choices": [{"message": {"content": __import__("json").dumps(analysis_payload())}}]},
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = OpenAICompatibleProvider(
        "https://models.example/v1", "model", "token", 10, PrivacyConfig()
    )
    result = provider.analyze(meeting, transcript)
    assert result.meeting_type is MeetingType.DESIGN_REVIEW
    assert requests[0]["response_format"]["type"] == "json_schema"
    assert requests[1]["response_format"] == {"type": "json_object"}


def test_invalid_model_json_fails_closed(monkeypatch, meeting, transcript):
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *args, **kwargs: Response(200, {"message": {"content": "not-json"}}),
    )
    provider = OllamaProvider("http://localhost:11434", "model", 10, 8192, PrivacyConfig())
    with pytest.raises(RuntimeError, match="non-JSON"):
        provider.analyze(meeting, transcript)


def test_model_people_and_due_dates_are_grounded(monkeypatch, meeting, transcript):
    payload = analysis_payload()
    payload["participants"] = [{"name": "Alex"}, {"name": "Invented Person"}]
    payload["action_items"] = [
        {
            "owner": "Invented Person",
            "action": "Write migration plan",
            "due": "2099-01-01",
            "done": False,
        }
    ]
    payload["decisions"] = [
        {
            "title": "Choose B",
            "decision": "Use B",
            "owner": "Invented Person",
        }
    ]
    grounded_transcript = transcript.model_copy(
        update={"text": transcript.text + " Sam will finish by Friday."}
    )
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *args, **kwargs: Response(200, {"message": {"content": json.dumps(payload)}}),
    )
    provider = OllamaProvider("http://localhost:11434", "model", 10, 8192, PrivacyConfig())
    result = provider.analyze(meeting, grounded_transcript)
    assert [participant.name for participant in result.participants] == ["Alex"]
    assert result.action_items[0].owner == "Unassigned"
    assert result.action_items[0].due == "Friday"
    assert result.decisions[0].owner is None


def test_unknown_attendees_keep_only_names_spoken_in_transcript(monkeypatch, meeting, transcript):
    payload = analysis_payload()
    payload["participants"] = [{"name": "Alex"}, {"name": "Invented Person"}]
    payload["action_items"] = [
        {"owner": "Invented Person", "action": "Fake task", "done": False},
        {"owner": "Alex", "action": "Real task", "done": False},
    ]
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *args, **kwargs: Response(200, {"message": {"content": json.dumps(payload)}}),
    )
    no_calendar = meeting.model_copy(update={"attendees": []})
    provider = OllamaProvider("http://localhost:11434", "model", 10, 8192, PrivacyConfig())
    result = provider.analyze(no_calendar, transcript)
    assert [participant.name for participant in result.participants] == ["Alex"]
    assert [item.owner for item in result.action_items] == ["Unassigned", "Alex"]


def test_whitespace_only_summary_is_rejected():
    import pytest

    from meeting_wiki.models import MeetingAnalysis

    with pytest.raises(ValueError, match="non-empty"):
        MeetingAnalysis(title="x", summary=["  ", "\n"])
