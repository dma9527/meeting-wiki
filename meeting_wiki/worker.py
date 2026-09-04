"""Durable worker loop."""

from __future__ import annotations

import json
import time

from .config import AppConfig
from .engine import MeetingEngine
from .jobs import JobQueue
from .models import JobType, MeetingInput
from .providers.registry import build_providers


class Worker:
    def __init__(self, config: AppConfig):
        self.config = config
        self.queue = JobQueue(
            config.data_dir / "jobs.db",
            max_attempts=config.jobs.max_attempts,
            backoff_base_seconds=config.jobs.backoff_base_seconds,
            visibility_timeout_seconds=config.jobs.visibility_timeout_seconds,
        )
        self.providers = build_providers(config)
        self.engine = MeetingEngine(config, self.providers)

    def run_once(self) -> bool:
        self.queue.reclaim_stale()
        job = self.queue.claim()
        if job is None:
            return False
        try:
            if job.job_type is not JobType.INGEST:
                raise ValueError(f"Unsupported job type: {job.job_type}")
            meeting = MeetingInput.model_validate(job.payload)
            result = self.engine.ingest(meeting)
            self.queue.complete(job.id)
            output = {"job_id": job.id, "state": "done"}
            if result.analysis.private:
                output["private"] = True
            else:
                output.update(
                    meeting_key=result.render.meeting_key,
                    written=result.render.written_keys,
                )
            print(json.dumps(output))
        except Exception as error:
            state = self.queue.fail(job.id, f"{type(error).__name__}: {error}")
            # Detailed error remains in the mode-0600 SQLite job row. Stdout is
            # redirected to a general worker log and must not contain private
            # titles, paths, transcript fragments, or provider response text.
            print(
                json.dumps(
                    {"job_id": job.id, "state": state.value, "error_type": type(error).__name__}
                )
            )
        return True

    def run_forever(self, idle_seconds: float = 1.0) -> None:
        self.queue.reclaim_stale()
        while True:
            if not self.run_once():
                time.sleep(idle_seconds)


def enqueue_meeting(config: AppConfig, meeting: MeetingInput) -> int:
    queue = JobQueue(
        config.data_dir / "jobs.db",
        max_attempts=config.jobs.max_attempts,
        backoff_base_seconds=config.jobs.backoff_base_seconds,
        visibility_timeout_seconds=config.jobs.visibility_timeout_seconds,
    )
    source = str(meeting.audio_path or meeting.transcript_path or meeting.title)
    dedupe = f"ingest:{meeting.occurred_at.isoformat()}:{source}"
    return queue.enqueue(
        JobType.INGEST,
        meeting.model_dump(mode="json"),
        dedupe,
    )
