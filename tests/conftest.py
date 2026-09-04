from __future__ import annotations

from datetime import UTC, datetime

import pytest

from meeting_wiki.models import (
    ActionItem,
    Decision,
    MeetingAnalysis,
    MeetingInput,
    MeetingType,
    Participant,
    TopicInsight,
    TranscriptResult,
    TranscriptSegment,
)


@pytest.fixture
def meeting() -> MeetingInput:
    return MeetingInput(
        title="Architecture Design Review",
        attendees=["Alex", "Sam"],
        meeting_type=MeetingType.DESIGN_REVIEW,
        occurred_at=datetime(2026, 9, 4, 15, 0, tzinfo=UTC),
        transcript_path=None,
        audio_path=None,
    )


@pytest.fixture
def transcript() -> TranscriptResult:
    return TranscriptResult(
        text="Alex: We chose option B. Sam: I will write the migration plan.",
        segments=[
            TranscriptSegment(speaker="Alex", text="We chose option B."),
            TranscriptSegment(speaker="Sam", text="I will write the migration plan."),
        ],
        language="en",
        provider="fake",
        model="fake",
        diarized=True,
    )


@pytest.fixture
def analysis() -> MeetingAnalysis:
    return MeetingAnalysis(
        title="Architecture Design Review",
        meeting_type=MeetingType.DESIGN_REVIEW,
        summary=["The team selected option B."],
        participants=[Participant(name="Alex"), Participant(name="Sam")],
        blockers=["Migration compatibility"],
        decisions=[
            Decision(
                title="Choose option B",
                decision="Adopt option B",
                rationale="Lower migration risk",
                owner="Alex",
            )
        ],
        action_items=[ActionItem(owner="Sam", action="Write migration plan")],
        topics=[TopicInsight(topic="Architecture", insight="Option B was selected")],
        open_questions=["When should migration start?"],
        risks=["Compatibility risk"],
    )
