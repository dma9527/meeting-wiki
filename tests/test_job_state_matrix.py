"""The recovery state matrix in docs/reference/job-states.md must match what the queue does."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

from meeting_wiki.config import JobConfig
from meeting_wiki.jobs import JobQueue
from meeting_wiki.models import JobState, JobType

DOC = Path(__file__).resolve().parents[1] / "docs" / "reference" / "job-states.md"
ACTIONS = ("retry", "dismiss", "restore")
STATES = [state.value for state in JobState]


def make_job(directory: Path, state: str, max_attempts: int = 3) -> tuple[JobQueue, int]:
    """Create one job in the requested state using only the public queue operations."""
    queue = JobQueue(directory / "jobs.db", max_attempts=max_attempts)
    job_id = queue.enqueue(JobType.INGEST, {"title": "t"}, "key")
    if state == "pending":
        return queue, job_id
    job = queue.claim()
    assert job is not None and job.id == job_id
    if state == "running":
        return queue, job_id
    if state == "done":
        queue.complete(job_id, claim_token=job.claim_token)
        return queue, job_id
    outcome = queue.fail(job_id, "RuntimeError: x", claim_token=job.claim_token)
    if state == "dead":
        # Failing again until the attempts are used up is the only way a job becomes dead.
        while outcome is JobState.FAILED:
            _make_claimable(queue, job_id)
            job = queue.claim()
            outcome = queue.fail(job_id, "RuntimeError: x", claim_token=job.claim_token)
    if state == "dismissed":
        while outcome is JobState.FAILED:
            _make_claimable(queue, job_id)
            job = queue.claim()
            outcome = queue.fail(job_id, "RuntimeError: x", claim_token=job.claim_token)
        queue.dismiss(job_id)
    return queue, job_id


def _make_claimable(queue: JobQueue, job_id: int) -> None:
    with sqlite3.connect(queue.path) as connection:
        connection.execute("UPDATE jobs SET not_before=0 WHERE id=?", (job_id,))


def user_action(queue: JobQueue, job_id: int, action: str) -> str:
    try:
        getattr(queue, action)(job_id)
    except ValueError:
        return "no"
    return "yes"


def automatic_handling(queue: JobQueue, job_id: int) -> str:
    """Which mechanism the worker applies to the job on its next loop, observed not assumed."""
    with sqlite3.connect(queue.path) as connection:
        connection.execute("UPDATE jobs SET not_before=0, lease_expires_at=1 WHERE id=?", (job_id,))
    if queue.reclaim_stale():
        return "reclaim"
    return "claim" if queue.claim() else "none"


def parse_matrix() -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    for line in DOC.read_text().splitlines():
        match = re.match(r"\|\s*`(\w+)`\s*\|(.*)\|\s*$", line)
        if not match:
            continue
        cells = [cell.strip() for cell in match.group(2).split("|")]
        if len(cells) != 5:
            continue
        meaning, automatic, retry, dismiss, restore = cells
        rows[match.group(1)] = {
            "meaning": meaning,
            "automatic": automatic.strip("`"),
            "retry": retry,
            "dismiss": dismiss,
            "restore": restore,
        }
    return rows


def test_the_document_lists_every_job_state_exactly_once():
    rows = parse_matrix()
    assert set(rows) == set(STATES)
    assert all(row["meaning"] for row in rows.values())


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("state", STATES)
def test_the_allowed_user_actions_match_the_queue(tmp_path, state, action):
    queue, job_id = make_job(tmp_path, state)
    assert queue.get(job_id).state.value == state, "the helper must reach the requested state"
    assert parse_matrix()[state][action] == user_action(queue, job_id, action)


@pytest.mark.parametrize("state", STATES)
def test_the_automatic_handling_matches_the_queue(tmp_path, state):
    queue, job_id = make_job(tmp_path, state)
    assert parse_matrix()[state]["automatic"] == automatic_handling(queue, job_id)


def test_an_expired_lease_returns_the_job_to_pending_or_marks_it_dead(tmp_path):
    spare = tmp_path / "spare"
    spare.mkdir()
    queue, job_id = make_job(tmp_path, "running", max_attempts=3)
    with sqlite3.connect(queue.path) as connection:
        connection.execute("UPDATE jobs SET lease_expires_at=1 WHERE id=?", (job_id,))
    assert queue.reclaim_stale() == 1
    assert queue.get(job_id).state is JobState.PENDING

    queue, job_id = make_job(spare, "running", max_attempts=1)
    with sqlite3.connect(queue.path) as connection:
        connection.execute("UPDATE jobs SET lease_expires_at=1 WHERE id=?", (job_id,))
    assert queue.reclaim_stale() == 1
    assert queue.get(job_id).state is JobState.DEAD


def test_the_document_names_the_stalled_cases_and_the_user_action_for_each():
    text = DOC.read_text()
    for heading in (
        "## Stalled work",
        "### Jobs wait and nothing runs",
        "### A job is running for a long time",
        "### A job is dead",
    ):
        assert heading in text, heading
    for command in (
        "meeting-wiki status --state dead",
        "meeting-wiki retry",
        "meeting-wiki dismiss",
    ):
        assert command in text, command


def test_the_documented_defaults_match_the_configuration():
    text = DOC.read_text()
    defaults = JobConfig()
    assert f"`max_attempts` is {defaults.max_attempts}" in text
    assert f"`backoff_base_seconds` is {defaults.backoff_base_seconds}" in text
    assert f"`visibility_timeout_seconds` is {defaults.visibility_timeout_seconds}" in text


def test_the_backoff_doubles_from_the_configured_base(tmp_path):
    queue = JobQueue(tmp_path / "jobs.db", max_attempts=5, backoff_base_seconds=2)
    job_id = queue.enqueue(JobType.INGEST, {"title": "t"}, "key")
    waits = []
    for _ in range(4):
        _make_claimable(queue, job_id)
        job = queue.claim()
        queue.fail(job_id, "RuntimeError: x", claim_token=job.claim_token)
        with sqlite3.connect(queue.path) as connection:
            not_before, updated_at = connection.execute(
                "SELECT not_before, updated_at FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
        waits.append(round(not_before - updated_at))
    assert waits == [2, 4, 8, 16]
    assert "the waits are 2, 4, 8, and 16 seconds" in DOC.read_text()
