"""LLM providers that return schema-validated meeting analysis, never Markdown pages."""

from __future__ import annotations

import json

import httpx
from pydantic import ValidationError

from ..config import PrivacyConfig
from ..models import MeetingAnalysis, MeetingInput, TranscriptResult
from ..privacy import classify

_MAX_TRANSCRIPT_CHARS = 120_000


def _transcript_window(text: str) -> str:
    if len(text) <= _MAX_TRANSCRIPT_CHARS:
        return text
    half = _MAX_TRANSCRIPT_CHARS // 2
    return text[:half] + "\n\n[... middle omitted ...]\n\n" + text[-half:]


def analysis_messages(meeting: MeetingInput, transcript: TranscriptResult, policy: PrivacyConfig):
    meeting_type = classify(meeting, policy)
    system = """You extract structured facts from a meeting transcript.
Return only data matching the supplied JSON schema. Never invent speakers,
decisions, owners, dates, commitments, or customer promises. Distinguish a
proposal from an accepted decision. Keep summaries concise. The renderer owns
Markdown; do not return Markdown pages."""
    if meeting_type.value == "standup":
        system += " Focus on status by person, blockers, coordination and actions."
    elif meeting_type.value == "design-review":
        system += " Preserve alternatives, trade-offs, accepted decisions and open questions."
    elif meeting_type.value == "customer":
        system += " Separate requests from commitments and do not infer delivery dates."
    elif meeting_type.value == "one-on-one":
        system += " This is private. Set private=true and include only owner-private follow-ups."
    user = json.dumps(
        {
            "title": meeting.title,
            "meeting_type": meeting_type.value,
            "attendees": meeting.attendees,
            "occurred_at": meeting.occurred_at.isoformat(),
            "notes": meeting.notes,
            "transcript": _transcript_window(transcript.text),
        },
        ensure_ascii=False,
    )
    return system, user, meeting_type


def _validate(
    data: dict,
    meeting: MeetingInput,
    meeting_type,
    transcript: TranscriptResult,
) -> MeetingAnalysis:
    try:
        analysis = MeetingAnalysis.model_validate(data)
    except ValidationError as error:
        raise RuntimeError(f"Model returned invalid MeetingAnalysis: {error}") from error

    attendee_map = {name.lower(): name for name in meeting.attendees}
    transcript_lower = transcript.text.lower()

    def known_person(name: str) -> bool:
        return name.lower() in attendee_map if attendee_map else name.lower() in transcript_lower

    participants = [
        participant for participant in analysis.participants if known_person(participant.name)
    ]
    relative_dates = [
        token
        for token in (
            "today",
            "tomorrow",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
            "next week",
        )
        if token in transcript.text.lower()
    ]
    actions = []
    for item in analysis.action_items:
        owner = item.owner
        if owner != "Unassigned" and not known_person(owner):
            owner = "Unassigned"
        due = item.due
        if due and due.lower() not in transcript.text.lower():
            due = relative_dates[0].title() if relative_dates else None
        actions.append(item.model_copy(update={"owner": owner, "due": due}))
    decisions = []
    for decision in analysis.decisions:
        owner = decision.owner
        if owner and not known_person(owner):
            owner = None
        decisions.append(decision.model_copy(update={"owner": owner}))

    # Privacy/type come from deterministic classifier, never model judgment.
    return analysis.model_copy(
        update={
            "meeting_type": meeting_type,
            "private": meeting.private or meeting_type.value == "one-on-one",
            "title": analysis.title or meeting.title,
            "participants": participants,
            "action_items": actions,
            "decisions": decisions,
        }
    )


class OllamaProvider:
    name = "ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout_seconds: float,
        num_ctx: int,
        privacy: PrivacyConfig,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout_seconds
        self.num_ctx = num_ctx
        self.privacy = privacy

    def analyze(self, meeting: MeetingInput, transcript: TranscriptResult) -> MeetingAnalysis:
        system, user, meeting_type = analysis_messages(meeting, transcript, self.privacy)
        response = httpx.post(
            f"{self.base_url}/api/chat",
            json={
                "model": self.model,
                "stream": False,
                "format": MeetingAnalysis.model_json_schema(),
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "options": {"temperature": 0, "num_ctx": self.num_ctx, "seed": 0},
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        content = response.json().get("message", {}).get("content", "")
        try:
            data = json.loads(content)
        except json.JSONDecodeError as error:
            raise RuntimeError("Ollama returned non-JSON analysis") from error
        return _validate(data, meeting, meeting_type, transcript)

    def health(self) -> tuple[bool, str]:
        try:
            response = httpx.get(f"{self.base_url}/api/tags", timeout=3)
            response.raise_for_status()
            models = [item.get("name", "") for item in response.json().get("models", [])]
            available = self.model in models or any(
                name.startswith(self.model + ":") for name in models
            )
            return available, "model ready" if available else f"model '{self.model}' not pulled"
        except httpx.HTTPError as error:
            return False, type(error).__name__


class OpenAICompatibleProvider:
    name = "openai_compatible"

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str,
        timeout_seconds: float,
        privacy: PrivacyConfig,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout_seconds
        self.privacy = privacy

    def analyze(self, meeting: MeetingInput, transcript: TranscriptResult) -> MeetingAnalysis:
        system, user, meeting_type = analysis_messages(meeting, transcript, self.privacy)
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        schema = MeetingAnalysis.model_json_schema()
        payload = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "meeting_analysis", "strict": True, "schema": schema},
            },
        }
        response = httpx.post(
            f"{self.base_url}/chat/completions",
            headers=headers,
            json=payload,
            timeout=self.timeout,
        )
        if response.status_code == 400:
            fallback_payload = {**payload, "response_format": {"type": "json_object"}}
            response = httpx.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=fallback_payload,
                timeout=self.timeout,
            )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        try:
            data = json.loads(content)
        except json.JSONDecodeError as error:
            raise RuntimeError("OpenAI-compatible endpoint returned non-JSON analysis") from error
        return _validate(data, meeting, meeting_type, transcript)

    def health(self) -> tuple[bool, str]:
        try:
            response = httpx.get(f"{self.base_url}/models", timeout=3)
            return response.status_code < 500, f"endpoint returned {response.status_code}"
        except httpx.HTTPError as error:
            return False, type(error).__name__
