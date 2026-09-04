"""Meeting-type classification and privacy policy."""

from __future__ import annotations

import re

from .config import PrivacyConfig
from .models import MeetingInput, MeetingType

_EXPLICIT_ONE_ON_ONE = re.compile(
    r"(?:^|\s)(?:1\s*[:/-]\s*1|1\s*on\s*1|one[- ]on[- ]one)(?:\s|$)",
    re.IGNORECASE,
)
_STANDUP = ("standup", "stand-up", "daily scrum", "daily sync")
_DESIGN = (
    "design review",
    "design doc",
    "architecture review",
    "technical review",
    "deep dive",
    "deep-dive",
    "walkthrough",
    "6-pager",
    "six pager",
)
_CUSTOMER = (
    "customer",
    "client",
    "qbr",
    "ebr",
    "customer discovery",
    "user research",
    "partner meeting",
)


def classify(meeting: MeetingInput, policy: PrivacyConfig) -> MeetingType:
    if meeting.private:
        return MeetingType.ONE_ON_ONE
    if meeting.meeting_type is not None:
        return meeting.meeting_type
    title = " ".join(meeting.title.lower().split())
    attendee_count = len(meeting.attendees)
    if _EXPLICIT_ONE_ON_ONE.search(title):
        return MeetingType.ONE_ON_ONE
    if attendee_count <= policy.max_private_attendees and any(
        term.lower() in title for term in policy.private_terms
    ):
        return MeetingType.ONE_ON_ONE
    if any(term in title for term in _STANDUP):
        return MeetingType.STANDUP
    if any(term in title for term in _DESIGN):
        return MeetingType.DESIGN_REVIEW
    if any(term in title for term in _CUSTOMER):
        return MeetingType.CUSTOMER
    return MeetingType.GENERIC
