"""Command-line entrypoint."""

from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path

from .config import DEFAULT_CONFIG_PATH, load_config
from .jobs import JobQueue
from .models import JobState, MeetingInput
from .providers.registry import build_providers
from .worker import Worker, enqueue_meeting

# Config, transcripts, SQLite journals and logs may contain meeting data.
os.umask(0o077)

_DEFAULT_CONFIG = resources.files("meeting_wiki").joinpath("default_config.toml").read_text()


def parse_time(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def init_command(path: Path) -> int:
    path = path.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        print(f"Config already exists: {path}")
        return 0
    path.write_text(_DEFAULT_CONFIG, encoding="utf-8")
    os.chmod(path, 0o600)
    print(f"Created {path}")
    print("Next: install Ollama + model, then run `meeting-wiki doctor`.")
    return 0


def meeting_from_args(args) -> MeetingInput:
    attendees = [item.strip() for item in (args.attendees or "").split(",") if item.strip()]
    return MeetingInput(
        audio_path=Path(args.audio) if args.audio else None,
        transcript_path=Path(args.transcript) if args.transcript else None,
        title=args.title or "Untitled meeting",
        attendees=attendees,
        private=args.private,
        occurred_at=parse_time(args.occurred_at),
        notes=args.notes or "",
    )


def doctor(config_path: Path) -> int:
    config = load_config(config_path)
    try:
        providers = build_providers(config)
    except Exception as error:
        print(f"Provider configuration error: {error}")
        return 1
    checks = {
        "transcription": providers.transcription.health(),
        "llm": providers.llm.health(),
        "storage": (True, f"{providers.storage.name}: {config.data_dir}"),
        "calendar": (True, providers.calendar.name),
        "notification": (True, providers.notification.name),
        "task": (True, providers.task.name),
    }
    failed = False
    for name, (ok, detail) in checks.items():
        print(f"{'OK' if ok else 'FAIL'} {name}: {detail}")
        failed = failed or not ok
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="meeting-wiki")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="Create a local config file")
    ingest = sub.add_parser("ingest", help="Queue an audio or transcript file")
    source = ingest.add_mutually_exclusive_group(required=True)
    source.add_argument("--audio")
    source.add_argument("--transcript")
    ingest.add_argument("--title")
    ingest.add_argument("--attendees", help="Comma-separated display names")
    ingest.add_argument("--private", action="store_true")
    ingest.add_argument("--occurred-at", help="ISO 8601 timestamp")
    ingest.add_argument("--notes")
    ingest.add_argument("--now", action="store_true", help="Process immediately")

    worker = sub.add_parser("worker", help="Run durable jobs")
    worker.add_argument("--once", action="store_true")
    status = sub.add_parser("status", help="List jobs (payloads redacted by default)")
    status.add_argument("--state", choices=[state.value for state in JobState])
    status.add_argument("--verbose", action="store_true", help="Include full job payloads/errors")
    sub.add_parser("doctor", help="Validate configured providers")
    sub.add_parser("mcp", help="Run read-only MCP server over stdio")

    args = parser.parse_args(argv)
    if args.command == "init":
        return init_command(args.config)
    if args.command == "mcp":
        from .mcp_server import main as mcp_main

        mcp_main()
        return 0

    config = load_config(args.config)
    if args.command == "doctor":
        return doctor(args.config)
    if args.command == "ingest":
        meeting = meeting_from_args(args)
        job_id = enqueue_meeting(config, meeting)
        print(json.dumps({"job_id": job_id, "queued": True}))
        if args.now:
            Worker(config).run_once()
        return 0
    if args.command == "worker":
        process = Worker(config)
        if args.once:
            process.run_once()
        else:
            process.run_forever()
        return 0
    if args.command == "status":
        queue = JobQueue(
            config.data_dir / "jobs.db",
            max_attempts=config.jobs.max_attempts,
            backoff_base_seconds=config.jobs.backoff_base_seconds,
            visibility_timeout_seconds=config.jobs.visibility_timeout_seconds,
        )
        state = JobState(args.state) if args.state else None
        jobs = queue.list(state)
        if args.verbose:
            output = [job.model_dump(mode="json") for job in jobs]
        else:
            output = [
                {
                    "id": job.id,
                    "job_type": job.job_type.value,
                    "state": job.state.value,
                    "attempts": job.attempts,
                    "max_attempts": job.max_attempts,
                    "error_type": job.last_error.split(":", 1)[0] if job.last_error else None,
                }
                for job in jobs
            ]
        print(json.dumps(output, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
