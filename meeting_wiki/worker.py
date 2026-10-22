"""Durable worker loop."""

from __future__ import annotations

import json
import threading
import time

from .config import AppConfig
from .diagnostics import encode_diagnostic, safe_job_diagnostic
from .engine import MeetingEngine
from .events import Component, EventCode, open_journal
from .jobs import ClaimLost, JobQueue
from .models import JobStage, JobType, MeetingInput
from .providers.registry import build_providers


class _JobAnalysisSnapshot:
    """Binds the engine's analysis snapshot to one job claim."""

    def __init__(self, queue: JobQueue, job_id: int, claim_token: str | None):
        self.queue = queue
        self.job_id = job_id
        self.claim_token = claim_token

    def load(self) -> str | None:
        return self.queue.load_analysis_snapshot(self.job_id)

    def save(self, snapshot: str) -> None:
        self.queue.save_analysis_snapshot(self.job_id, snapshot, claim_token=self.claim_token)


class _LeaseHeartbeat:
    def __init__(
        self,
        queue: JobQueue,
        job_id: int,
        interval_seconds: float,
        claim_token: str | None = None,
    ):
        self.queue = queue
        self.job_id = job_id
        self.claim_token = claim_token
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=self.interval_seconds + 1)

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            if not self.queue.heartbeat(self.job_id, claim_token=self.claim_token):
                return


class Worker:
    def __init__(self, config: AppConfig):
        self.config = config
        self.journal = open_journal(config.data_dir)
        self.queue = JobQueue(
            config.data_dir / "jobs.db",
            max_attempts=config.jobs.max_attempts,
            backoff_base_seconds=config.jobs.backoff_base_seconds,
            visibility_timeout_seconds=config.jobs.visibility_timeout_seconds,
            journal=self.journal,
        )
        self.providers = build_providers(config)
        self.engine = MeetingEngine(config, self.providers, self.journal)

    def run_once(self) -> bool:
        self.queue.reclaim_stale()
        job = self.queue.claim()
        if job is None:
            return False
        heartbeat_interval = max(
            1.0,
            min(30.0, self.config.jobs.visibility_timeout_seconds / 3),
        )
        token = job.claim_token
        heartbeat = _LeaseHeartbeat(self.queue, job.id, heartbeat_interval, token)
        heartbeat.start()
        current_stage = job.stage
        try:
            if job.job_type is not JobType.INGEST:
                raise ValueError(f"Unsupported job type: {job.job_type}")
            meeting = MeetingInput.model_validate(job.payload)
            if not meeting.classification_frozen:
                meeting = self.engine.resolve(meeting)
                self.queue.freeze_payload(
                    job.id, meeting.model_dump(mode="json"), claim_token=token
                )
            def progress(stage: JobStage) -> None:
                nonlocal current_stage
                current_stage = stage
                self.queue.set_stage(job.id, stage, claim_token=token)
                self.queue.heartbeat(job.id, claim_token=token)

            result = self.engine.ingest(
                meeting,
                progress,
                job_id=job.id,
                analysis_snapshot=_JobAnalysisSnapshot(self.queue, job.id, token),
            )
            heartbeat.stop()
            self.queue.complete(job.id, claim_token=token)
            output = {"job_id": job.id, "state": "done"}
            if result.analysis.private:
                output["private"] = True
            else:
                output.update(
                    meeting_key=result.render.meeting_key,
                    written=result.render.written_keys,
                )
            print(json.dumps(output))
        except ClaimLost:
            heartbeat.stop()
            self._claim_lost(job.id, job.attempts)
        except Exception as error:
            heartbeat.stop()
            provider = None
            if current_stage is JobStage.TRANSCRIBING:
                provider = self.providers.transcription.name
            elif current_stage is JobStage.ANALYZING:
                provider = self.providers.llm.name
            elif current_stage is JobStage.INTEGRATING:
                provider = self.providers.task.name
            diagnostic = safe_job_diagnostic(
                error,
                stage=current_stage.value,
                attempt=job.attempts,
                max_attempts=job.max_attempts,
                provider=provider,
            )
            try:
                state = self.queue.fail(job.id, encode_diagnostic(diagnostic), claim_token=token)
            except ClaimLost:
                self._claim_lost(job.id, job.attempts)
                return True
            # Worker output is redirected to a general log. Emit only the
            # allowlisted diagnostic record, never exception text or a traceback.
            print(json.dumps({"job_id": job.id, "state": state.value, "diagnostic": diagnostic}))
        return True

    def _claim_lost(self, job_id: int, attempt: int) -> None:
        # A newer claim owns the job; this worker leaves its state untouched.
        if self.journal is not None:
            self.journal.record(
                EventCode.JOB_CLAIM_LOST,
                Component.WORKER,
                job_id=job_id,
                attempt=attempt,
                outcome="abandoned",
            )
        print(json.dumps({"job_id": job_id, "state": "claim_lost"}))

    def run_forever(self, idle_seconds: float = 1.0) -> None:
        self.queue.reclaim_stale()
        while True:
            try:
                worked = self.run_once()
            except Exception as error:
                # One bad iteration must not stop the daemon; emit the type only.
                print(json.dumps({"state": "worker_error", "error_type": type(error).__name__}))
                worked = False
            if not worked:
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
