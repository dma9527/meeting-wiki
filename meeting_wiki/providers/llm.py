"""LLM providers that return schema-validated meeting analysis, never Markdown pages."""

from __future__ import annotations

import copy
import json

import httpx
from pydantic import ValidationError

from ..config import PrivacyConfig
from ..models import MeetingAnalysis, MeetingInput, TranscriptResult
from ..privacy import classify

_MAX_TRANSCRIPT_CHARS = 120_000


def _transcript_window(text: str, limit: int = _MAX_TRANSCRIPT_CHARS) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + "\n\n[... middle omitted ...]\n\n" + text[-half:]


def openai_strict_schema(schema: dict[str, object]) -> dict[str, object]:
    """Normalize Pydantic JSON Schema for OpenAI strict structured outputs."""
    strict = copy.deepcopy(schema)

    def normalize(node: object) -> None:
        if isinstance(node, list):
            for item in node:
                normalize(item)
            return
        if not isinstance(node, dict):
            return
        for key in ("default", "minLength", "maxLength", "minItems", "maxItems"):
            node.pop(key, None)
        properties = node.get("properties")
        if isinstance(properties, dict):
            node["required"] = list(properties)
            node["additionalProperties"] = False
        for value in node.values():
            normalize(value)

    normalize(strict)
    return strict


def analysis_messages(
    meeting: MeetingInput,
    transcript: TranscriptResult,
    policy: PrivacyConfig,
    output_language: str = "en",
    max_transcript_chars: int = _MAX_TRANSCRIPT_CHARS,
):
    meeting_type = classify(meeting, policy)
    system = """You extract structured facts from a meeting transcript.
Return only data matching the supplied JSON schema. Never invent speakers,
decisions, owners, dates, commitments, or customer promises. Distinguish a
proposal from an accepted decision. Keep summaries concise. The renderer owns
Markdown; do not return Markdown pages."""
    fields = (
        "summaries, blocker descriptions, decision details and rationale, action descriptions, "
        "topic insights, open questions, risks, and participant roles"
    )
    if output_language == "source":
        system += (
            f" Write {fields} in the language the speakers used. Do not translate. When speakers "
            "switch languages, keep each item in the language it was discussed in. "
        )
    else:
        language = "Simplified Chinese" if output_language == "zh-CN" else "English"
        system += f" Write {fields} in {language}. "
    system += (
        "Keep the meeting title, topic names, decision titles, participant and owner names, due "
        "values, quotes, JSON keys, enum values, identifiers, dates, and URLs unchanged."
    )
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
            "transcript": _transcript_window(transcript.text, max_transcript_chars),
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
            "title": meeting.title if meeting.title_explicit else analysis.title or meeting.title,
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
        output_language: str = "en",
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout_seconds
        self.num_ctx = num_ctx
        self.privacy = privacy
        self.output_language = output_language

    def analyze(self, meeting: MeetingInput, transcript: TranscriptResult) -> MeetingAnalysis:
        system, user, meeting_type = analysis_messages(
            meeting, transcript, self.privacy, self.output_language
        )
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
        output_language: str = "en",
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout_seconds
        self.privacy = privacy
        self.output_language = output_language

    def analyze(self, meeting: MeetingInput, transcript: TranscriptResult) -> MeetingAnalysis:
        system, user, meeting_type = analysis_messages(
            meeting, transcript, self.privacy, self.output_language
        )
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        schema = openai_strict_schema(MeetingAnalysis.model_json_schema())
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
            fallback_system = (
                f"{system}\n\nReturn exactly one JSON object matching this output schema: "
                f"{json.dumps(schema, ensure_ascii=False)}\n"
                "The user payload is wrapped in an input object. Analyze its transcript, "
                "do not return input fields, and do not add any fields outside the output schema."
            )
            fallback_input = json.dumps({"input": json.loads(user)}, ensure_ascii=False)
            fallback_payload = {
                **payload,
                "messages": [
                    {"role": "system", "content": fallback_system},
                    {"role": "user", "content": fallback_input},
                ],
                "response_format": {"type": "json_object"},
            }
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
