from __future__ import annotations

import json
import sqlite3

import httpx
import pytest
from test_engine import bundle

from meeting_wiki.config import AppConfig
from meeting_wiki.diagnostics import SafeProviderError, decode_diagnostic
from meeting_wiki.events import EventJournal
from meeting_wiki.models import ActionItem, JobState, MeetingType
from meeting_wiki.outbox import DeliveryState, TaskOutbox, action_key, journal_ref
from meeting_wiki.providers.integrations import WebhookTaskProvider

SOURCE = "0000000000000000"
MEETING_KEY = "wiki/meetings/2026-09-04-test-meeting.md"
REQUEST = httpx.Request("POST", "https://tasks.example/hook")


class IdempotentReceiver:
    """Fake task service that dedupes on the idempotency key, like a compliant receiver."""

    name = "fake"

    def __init__(self, faults=None):
        self.faults = list(faults or [])
        self.calls: list[str | None] = []
        self.created: dict[str, str] = {}
        self.observed_states: list[str] = []
        self.outbox: TaskOutbox | None = None

    def propose(self, item, meeting_key, *, action_key=None):
        self.calls.append(action_key)
        if self.outbox is not None and action_key:
            self.observed_states.append(str(self.outbox.get(action_key)["state"]))
        fault = self.faults.pop(0) if self.faults else None
        if fault == "reject_before_accept":
            raise httpx.ConnectError("refused", request=REQUEST)
        url = self.created.setdefault(
            action_key, f"https://tasks.example/t/{len(self.created) + 1}"
        )
        if fault == "timeout_after_accept":
            raise httpx.ReadTimeout("lost response", request=REQUEST)
        if isinstance(fault, int):
            raise httpx.HTTPStatusError(
                "status", request=REQUEST, response=httpx.Response(fault, request=REQUEST)
            )
        return url


def items() -> list[ActionItem]:
    return [
        ActionItem(owner="Sam", action="Write the migration plan", due="Friday"),
        ActionItem(owner="Alex", action="Review option B"),
    ]


def test_action_key_is_stable_across_whitespace_case_and_done_flag():
    first = ActionItem(owner="Sam", action="Write the migration plan", due="Friday")
    second = ActionItem(owner=" sam ", action="write  the\nmigration PLAN", due="friday", done=True)
    assert action_key(SOURCE, first) == action_key(SOURCE, second)
    assert action_key(SOURCE, first) != action_key("1111111111111111", first)
    other = first.model_copy(update={"owner": "Alex"})
    assert action_key(SOURCE, first) != action_key(SOURCE, other)


def test_outbox_row_is_committed_as_sending_before_the_request(tmp_path):
    outbox = TaskOutbox(tmp_path / "outbox.db")
    receiver = IdempotentReceiver()
    receiver.outbox = outbox
    keys = outbox.plan(SOURCE, "fake", MEETING_KEY, items(), job_id=1)
    assert {outbox.get(key)["state"] for key in keys} == {"planned"}
    report = outbox.deliver(keys, receiver, job_id=1)
    assert receiver.observed_states == ["sending", "sending"]
    assert report.delivered == 2
    assert {outbox.get(key)["state"] for key in keys} == {"delivered"}
    assert report.delivered_urls == [outbox.get(key)["external_url"] for key in keys]


def test_timeout_after_accepted_creation_does_not_duplicate(tmp_path):
    outbox = TaskOutbox(tmp_path / "outbox.db")
    receiver = IdempotentReceiver(faults=["timeout_after_accept", None])
    keys = outbox.plan(SOURCE, "fake", MEETING_KEY, items()[:1], job_id=1)
    with pytest.raises(SafeProviderError):
        outbox.deliver(keys, receiver, job_id=1)
    row = outbox.get(keys[0])
    assert row["state"] == DeliveryState.FAILED.value
    assert row["outcome"] == "timeout"
    report = outbox.deliver(keys, receiver, job_id=1)
    assert receiver.calls == [keys[0], keys[0]]
    assert len(receiver.created) == 1
    assert report.delivered_urls == ["https://tasks.example/t/1"]
    assert outbox.get(keys[0])["attempts"] == 2


def test_delivered_actions_are_never_resent(tmp_path):
    outbox = TaskOutbox(tmp_path / "outbox.db")
    receiver = IdempotentReceiver()
    keys = outbox.plan(SOURCE, "fake", MEETING_KEY, items(), job_id=1)
    outbox.deliver(keys, receiver, job_id=1)
    again = outbox.plan(SOURCE, "fake", MEETING_KEY, items(), job_id=2)
    report = outbox.deliver(again, receiver, job_id=2)
    assert len(receiver.calls) == 2
    assert report.skipped == 2
    assert report.delivered_urls == ["https://tasks.example/t/1", "https://tasks.example/t/2"]


def test_crash_after_send_before_outcome_resends_same_key_after_lease(tmp_path):
    path = tmp_path / "outbox.db"
    receiver = IdempotentReceiver()
    crashed = TaskOutbox(path, lease_seconds=60)
    keys = crashed.plan(SOURCE, "fake", MEETING_KEY, items()[:1], job_id=1)
    acquired = crashed._acquire(keys[0])
    assert not isinstance(acquired, str)
    receiver.propose(items()[0], MEETING_KEY, action_key=keys[0])  # accepted, then process died

    live_lease = TaskOutbox(path, lease_seconds=60)
    with pytest.raises(SafeProviderError):
        live_lease.deliver(keys, receiver, job_id=1)
    assert len(receiver.calls) == 1  # in-flight lease blocks a concurrent resend

    expired = TaskOutbox(path, lease_seconds=60)
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE task_outbox SET lease_expires_at=0")
    report = expired.deliver(keys, receiver, job_id=1)
    assert receiver.calls == [keys[0], keys[0]]
    assert len(receiver.created) == 1
    assert report.delivered == 1


def test_retried_job_reuses_committed_plan_despite_new_analysis(tmp_path):
    outbox = TaskOutbox(tmp_path / "outbox.db")
    first = outbox.plan(SOURCE, "fake", MEETING_KEY, items()[:1], job_id=7)
    reworded = [ActionItem(owner="Sam", action="Draft a migration document")]
    assert outbox.plan(SOURCE, "fake", MEETING_KEY, reworded, job_id=7) == first
    assert outbox.plan(SOURCE, "fake", MEETING_KEY, reworded, job_id=8) != first


def test_non_retryable_rejection_is_terminal_and_retryable_status_raises(tmp_path):
    outbox = TaskOutbox(tmp_path / "outbox.db")
    rejected_keys = outbox.plan(SOURCE, "fake", MEETING_KEY, items()[:1], job_id=1)
    rejecting = IdempotentReceiver(faults=[422])
    report = outbox.deliver(rejected_keys, rejecting, job_id=1)
    assert report.rejected == 1
    assert outbox.get(rejected_keys[0])["http_status"] == 422
    outbox.deliver(rejected_keys, rejecting, job_id=1)
    assert len(rejecting.calls) == 1

    retry_keys = outbox.plan(SOURCE, "fake", MEETING_KEY, items()[1:], job_id=2)
    with pytest.raises(SafeProviderError) as raised:
        outbox.deliver(retry_keys, IdempotentReceiver(faults=[503]), job_id=2)
    assert raised.value.metadata["http_status"] == 503
    assert outbox.get(retry_keys[0])["state"] == "failed"


def test_unsafe_external_url_is_not_stored(tmp_path):
    class ScriptUrl(IdempotentReceiver):
        def propose(self, item, meeting_key, *, action_key=None):
            return "javascript:alert(1)"

    outbox = TaskOutbox(tmp_path / "outbox.db")
    keys = outbox.plan(SOURCE, "fake", MEETING_KEY, items()[:1], job_id=1)
    report = outbox.deliver(keys, ScriptUrl(), job_id=1)
    assert report.delivered_urls == []
    row = outbox.get(keys[0])
    assert row["external_url"] is None
    assert row["outcome"] == "accepted"


def test_webhook_sends_stable_idempotency_key(monkeypatch):
    sent = []

    def fake_post(url, headers, json, timeout):
        sent.append((headers, json))
        return httpx.Response(201, json={"url": "https://tasks.example/t/9"}, request=REQUEST)

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = WebhookTaskProvider("https://tasks.example/hook", "", allow_private_networks=True)
    key = action_key(SOURCE, items()[0])
    assert provider.propose(items()[0], MEETING_KEY, action_key=key) == "https://tasks.example/t/9"
    provider.propose(items()[0], MEETING_KEY, action_key=key)
    assert [headers["Idempotency-Key"] for headers, _ in sent] == [key, key]
    assert sent[0][1]["action_id"] == key


def _journal_text(path) -> str:
    with sqlite3.connect(path) as connection:
        return json.dumps(connection.execute("SELECT * FROM events").fetchall())


def test_worker_retry_after_integration_timeout_creates_one_task_per_action(
    tmp_path, meeting, transcript, analysis, monkeypatch
):
    import meeting_wiki.worker as worker_module
    from meeting_wiki.worker import Worker, enqueue_meeting

    audio = tmp_path / "audio" / "meeting.wav"
    audio.parent.mkdir()
    audio.write_bytes(b"fake")
    config = AppConfig(data_dir=tmp_path)
    config.jobs.backoff_base_seconds = 0
    providers, _, _ = bundle(tmp_path, transcript, analysis)
    receiver = IdempotentReceiver(faults=["timeout_after_accept"])
    providers.task = receiver
    monkeypatch.setattr(worker_module, "build_providers", lambda _: providers)
    enqueue_meeting(config, meeting.model_copy(update={"audio_path": audio}))
    worker = Worker(config)

    assert worker.run_once() is True
    failed = worker.queue.get(1)
    assert failed.state is JobState.FAILED
    diagnostic = decode_diagnostic(failed.last_error)
    assert diagnostic["stage"] == "integrating"
    assert diagnostic["provider"] == "fake"
    assert diagnostic["operation"] == "task_delivery"

    assert worker.run_once() is True
    assert worker.queue.get(1).state is JobState.DONE
    assert len(receiver.created) == len(analysis.action_items)
    assert len(receiver.calls) == 2 * len(analysis.action_items)

    events = worker.journal.recent()
    codes = [event["code"] for event in events]
    for expected in (
        "job.claimed",
        "job.stage",
        "task.planned",
        "task.sending",
        "task.failed",
        "job.failed",
        "task.delivered",
        "job.completed",
    ):
        assert expected in codes
    stage_pairs = [
        (event.get("stage_from"), event.get("stage_to"))
        for event in events
        if event["code"] == "job.stage"
    ]
    assert ("rendering", "integrating") in stage_pairs
    stored = _journal_text(tmp_path / "events.db")
    assert all(event["component_version"] for event in events)
    with sqlite3.connect(tmp_path / "outbox.db") as connection:
        keys = [row[0] for row in connection.execute("SELECT action_key FROM task_outbox")]
    assert keys and not any(key in stored for key in keys)
    for forbidden in (
        meeting.title,
        analysis.action_items[0].action,
        "wiki/meetings",
        str(tmp_path),
        "tasks.example",
        "lost response",
    ):
        assert forbidden not in stored


def test_private_meeting_never_touches_outbox(tmp_path, meeting, transcript, analysis):
    from meeting_wiki.engine import MeetingEngine

    providers, _, tasks = bundle(tmp_path, transcript, analysis)
    private = meeting.model_copy(update={"private": True, "meeting_type": MeetingType.ONE_ON_ONE})
    audio = tmp_path / "private.wav"
    audio.write_bytes(b"fake")
    MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(
        private.model_copy(update={"audio_path": audio}), job_id=1
    )
    assert tasks.calls == []
    assert not (tmp_path / "outbox.db").exists()


def test_none_task_provider_keeps_ingest_local_only(tmp_path, meeting, transcript, analysis):
    from meeting_wiki.engine import MeetingEngine
    from meeting_wiki.providers.integrations import NoneTaskProvider

    providers, _, _ = bundle(tmp_path, transcript, analysis)
    providers.task = NoneTaskProvider()
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"fake")
    result = MeetingEngine(AppConfig(data_dir=tmp_path), providers).ingest(
        meeting.model_copy(update={"audio_path": audio})
    )
    assert result.task_urls == []
    assert not (tmp_path / "outbox.db").exists()


def test_outbox_events_reference_only_a_digest(tmp_path):
    journal = EventJournal(tmp_path / "events.db")
    outbox = TaskOutbox(tmp_path / "outbox.db", journal)
    keys = outbox.plan(SOURCE, "fake", MEETING_KEY, items()[:1], job_id=1)
    outbox.deliver(keys, IdempotentReceiver(), job_id=1)
    refs = {event.get("ref") for event in journal.recent()}
    assert refs == {journal_ref(keys[0])}
    assert keys[0] not in _journal_text(tmp_path / "events.db")
