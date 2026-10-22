"""Builds a realistic fake data directory with shared and private meetings."""

from __future__ import annotations

import gc
import json
from dataclasses import dataclass
from pathlib import Path

from test_engine import bundle

from meeting_wiki.config import AppConfig
from meeting_wiki.engine import MeetingEngine
from meeting_wiki.events import EventJournal
from meeting_wiki.jobs import JobQueue
from meeting_wiki.memory import MemoryStore
from meeting_wiki.models import MeetingInput, MeetingType
from meeting_wiki.wiki import stable_id
from meeting_wiki.worker import enqueue_meeting

FAKE_SECRET = "fake-secret-value-0000"


@dataclass
class Populated:
    data_dir: Path
    config_path: Path
    config: AppConfig
    shared_key: str
    private_key: str
    shared_audio: Path


def populate(tmp_path: Path, meeting, transcript, analysis) -> Populated:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    config_path = data_dir / "config.toml"
    config_path.write_text(
        f'data_dir = "{data_dir}"\nuser_name = "Test User"\n'
        '[webhook]\nurl = "https://tasks.example/hook"\n'
    )
    config = AppConfig(data_dir=data_dir)
    providers, _notifications, _tasks = bundle(data_dir, transcript, analysis)
    engine = MeetingEngine(config, providers)

    audio = data_dir / "audio" / "meeting.wav"
    audio.parent.mkdir()
    audio.write_bytes(b"RIFF-shared-audio")
    shared_meeting = meeting.model_copy(update={"audio_path": audio})
    queue = JobQueue(data_dir / "jobs.db", journal=EventJournal(data_dir / "events.db"))
    enqueue_meeting(config, shared_meeting)
    job = queue.claim()
    shared = engine.ingest(shared_meeting, job_id=job.id)
    queue.complete(job.id)

    private_audio = data_dir / "audio" / "private.wav"
    private_audio.write_bytes(b"RIFF-private-audio")
    private_meeting = MeetingInput(
        title="Alex / Sam 1:1",
        attendees=["Alex", "Sam"],
        occurred_at=meeting.occurred_at,
        audio_path=private_audio,
        private=True,
        meeting_type=MeetingType.ONE_ON_ONE,
    )
    private = engine.ingest(private_meeting)

    MemoryStore(data_dir / "memory.db").add_resource(
        meeting_node_id=f"meeting:{stable_id(shared_meeting.ingest_id)}",
        url="https://docs.example/design?id=0000",
        title="Design doc",
        summary="",
        relation="reference",
        created_at="2026-09-04T15:00:00+00:00",
        allow_private=False,
    )

    (data_dir / "secrets.json").write_text(json.dumps({"KEY": FAKE_SECRET}))
    (data_dir / ".env").write_text(f"KEY={FAKE_SECRET}\n")
    (data_dir / "logs").mkdir()
    (data_dir / "logs" / "worker.log").write_text("log line\n")
    (data_dir / "tmp" / "live-old").mkdir(parents=True)
    (data_dir / "tmp" / "live-old" / "chunk.wav").write_bytes(b"chunk")
    (data_dir / "desktop-settings.json").write_text('{"max_duration_minutes": 60}\n')
    meet = data_dir / "integrations" / "google-meet"
    (meet / "events").mkdir(parents=True)
    (meet / "manifest.json").write_text('{"name": "host"}\n')
    (meet / "events" / "join.json").write_text("{}\n")
    # Close lingering sqlite connections now so a later GC checkpoint cannot alter the tree.
    gc.collect()
    return Populated(
        data_dir=data_dir,
        config_path=config_path,
        config=config,
        shared_key=shared.render.meeting_key,
        private_key=private.render.meeting_key,
        shared_audio=audio,
    )
