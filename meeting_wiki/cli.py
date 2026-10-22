"""Command-line entrypoint."""

from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path

from .config import DEFAULT_CONFIG_PATH, load_config
from .corrections import apply_correction, build_inbox, plan_correction
from .diagnostics import decode_diagnostic, safe_identifier
from .events import open_journal
from .jobs import JobQueue
from .memory import NODE_TYPES
from .models import JobState, MeetingInput
from .providers.registry import build_providers
from .resources import RESOURCE_RELATIONS
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


def parse_speaker_corrections(values: list[str] | None) -> dict[str, str]:
    corrections: dict[str, str] = {}
    for value in values or []:
        raw, separator, corrected = value.partition("=")
        if not separator or not raw.strip() or not corrected.strip():
            raise ValueError("Speaker corrections must use OLD=NEW")
        corrections[raw.strip()] = corrected.strip()
    return corrections


def meeting_from_args(args) -> MeetingInput:
    attendees = [item.strip() for item in (args.attendees or "").split(",") if item.strip()]
    return MeetingInput(
        audio_path=Path(args.audio) if args.audio else None,
        mic_audio_path=Path(args.mic_audio) if args.mic_audio else None,
        system_audio_path=Path(args.system_audio) if args.system_audio else None,
        transcript_path=Path(args.transcript) if args.transcript else None,
        title=args.title or "Untitled meeting",
        title_explicit=bool(args.title) and not args.title_auto,
        attendees=attendees,
        private=args.private,
        occurred_at=parse_time(args.occurred_at),
        occurred_at_explicit=bool(args.occurred_at),
        speaker_corrections=parse_speaker_corrections(args.speaker),
        notes=args.notes or "",
    )


def _build_storage(config):
    """Build storage only, without constructing secret-dependent providers."""
    from .providers.local_storage import LocalFileStorage

    if config.providers.storage == "local":
        return LocalFileStorage(config.data_dir)
    from .providers.s3_storage import S3Storage

    return S3Storage(config.s3.bucket, config.s3.prefix, config.s3.region, config.s3.profile)


def _build_calendar(config):
    """Build the calendar provider only. Both options read a local file, no secrets."""
    from .providers.calendar import ICSCalendarProvider, NoneCalendarProvider

    if config.providers.calendar == "ics":
        return ICSCalendarProvider(config.ics.path)
    return NoneCalendarProvider()


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


def redacted_job_record(job) -> dict[str, object]:
    """Return a UI-safe job record without payloads or raw provider error text."""
    diagnostic = decode_diagnostic(job.last_error)
    error_type = None
    if diagnostic:
        value = diagnostic.get("error_type")
        error_type = value if isinstance(value, str) else None
    elif job.last_error:
        error_type = safe_identifier(job.last_error.split(":", 1)[0])
    record: dict[str, object] = {
        "id": job.id,
        "job_type": job.job_type.value,
        "state": job.state.value,
        "stage": job.stage.value,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "error_type": error_type,
    }
    if diagnostic:
        record["diagnostic"] = diagnostic
    return record


def live_command(config, mic_audio: Path, private: bool) -> int:
    """Run one live session. The token arrives via environment, never argv."""
    import asyncio

    from .live import TOKEN_ENV, run_live_session

    token = os.environ.pop(TOKEN_ENV, "")
    if len(token) < 32:
        print(json.dumps({"type": "error", "error": "live_token_required"}))
        return 2
    return asyncio.run(
        run_live_session(
            config,
            mic_audio.expanduser(),
            private,
            token,
            lambda line: print(line, flush=True),
        )
    )


def reindex_memory_command(config) -> int:
    """Rebuild memory from local artifacts. S3 shared artifacts are not local, so refuse."""
    from .memory_reindex import reindex_memory

    if config.providers.storage != "local":
        print(json.dumps({"error": "reindex_requires_local_storage"}))
        return 1
    print(json.dumps(reindex_memory(config.data_dir).to_dict(), indent=2))
    return 0


def memory_search_command(config, args) -> int:
    from .memory import MemoryStore

    if not 2 <= len(args.query) <= 300 or not 1 <= args.limit <= 30:
        print(json.dumps({"error": "invalid_memory_query", "items": []}))
        return 1
    try:
        items = MemoryStore(config.data_dir / "memory.db").search(
            args.query,
            node_types=args.node_types,
            limit=args.limit,
            include_private=args.include_private,
        )
    except ValueError:
        print(json.dumps({"error": "invalid_memory_query", "items": []}))
        return 1
    print(json.dumps({"count": len(items), "items": items}, ensure_ascii=False))
    return 0


def memory_add_resource_command(config, args) -> int:
    """Store a user-described URL on a meeting. The URL is validated, never fetched."""
    from .memory import MemoryStore, ResourceError
    from .resources import (
        MAX_SUMMARY_LENGTH,
        MAX_TITLE_LENGTH,
        ResourceValidationError,
        validate_relation,
        validate_text,
        validate_url,
    )

    try:
        url = validate_url(args.url, allow_loopback=args.allow_loopback)
        title = validate_text(args.title, field="title", maximum=MAX_TITLE_LENGTH, required=True)
        summary = validate_text(
            args.summary, field="summary", maximum=MAX_SUMMARY_LENGTH, required=False
        )
        relation = validate_relation(args.relation)
        resource = MemoryStore(config.data_dir / "memory.db").add_resource(
            meeting_node_id=args.meeting,
            url=url,
            title=title,
            summary=summary,
            relation=relation,
            created_at=datetime.now(UTC).isoformat(timespec="seconds"),
            allow_private=args.allow_private,
        )
    except (ResourceValidationError, ResourceError) as error:
        print(json.dumps({"error": str(error)}))
        return 1
    print(json.dumps({"added": True, "resource": resource}, ensure_ascii=False))
    return 0


def memory_resources_command(config, args) -> int:
    from .memory import MemoryStore

    try:
        items = MemoryStore(config.data_dir / "memory.db").list_resources(
            meeting_node_id=args.meeting,
            include_private=args.include_private,
            limit=args.limit,
        )
    except ValueError:
        print(json.dumps({"error": "invalid_resource_query", "items": []}))
        return 1
    print(json.dumps({"count": len(items), "items": items}, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="meeting-wiki")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="Create a local config file")
    ingest = sub.add_parser("ingest", help="Queue an audio or transcript file")
    source = ingest.add_mutually_exclusive_group(required=True)
    source.add_argument("--audio")
    source.add_argument("--transcript")
    ingest.add_argument("--mic-audio", help="Preserved microphone WAV aligned to --audio")
    ingest.add_argument("--system-audio", help="Preserved system-audio WAV aligned to --audio")
    ingest.add_argument(
        "--speaker",
        action="append",
        help="Exact speaker correction in OLD=NEW form; repeat as needed",
    )
    ingest.add_argument("--title")
    ingest.add_argument("--title-auto", action="store_true", help=argparse.SUPPRESS)
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
    status.add_argument("--summary", action="store_true", help="Return privacy-safe state counts")
    retry = sub.add_parser("retry", help="Retry a failed or dead job")
    retry.add_argument("job_id", type=int)
    dismiss = sub.add_parser("dismiss", help="Dismiss a dead job without deleting meeting data")
    dismiss.add_argument("job_id", type=int)
    restore = sub.add_parser("restore", help="Return a dismissed job to the dead-letter list")
    restore.add_argument("job_id", type=int)
    cleanup = sub.add_parser(
        "cleanup-dismissed",
        help="Delete only dismissed queue history older than the retention period",
    )
    cleanup.add_argument("--older-than-days", type=float, required=True)
    sub.add_parser("doctor", help="Validate configured providers")
    sub.add_parser(
        "self-check",
        help="Print a capability report with fixed status codes only (for the desktop app)",
    )
    sub.add_parser("mcp", help="Run read-only MCP server over stdio")
    live = sub.add_parser(
        "live",
        help="Run a display-only live session for the desktop app (token via environment)",
    )
    live.add_argument("--mic-audio", required=True, help="Growing 16 kHz mono microphone WAV")
    live.add_argument("--private", action="store_true")

    brief = sub.add_parser("brief", help="Generate pre-meeting briefs for upcoming calendar events")
    brief.add_argument(
        "--within", type=int, default=120, help="Look-ahead window in minutes (default 120)"
    )

    sub.add_parser(
        "reindex-memory",
        help="Rebuild local memory.db from stored shared and private meeting artifacts",
    )
    memory_search = sub.add_parser(
        "memory-search", help="Search local canonical memory (shared only by default)"
    )
    memory_search.add_argument("--query", required=True)
    memory_search.add_argument(
        "--type", action="append", choices=sorted(NODE_TYPES), dest="node_types"
    )
    memory_search.add_argument("--limit", type=int, default=12)
    memory_search.add_argument(
        "--include-private",
        action="store_true",
        help="Also return private local memory; never used by MCP",
    )
    add_resource = sub.add_parser(
        "memory-add-resource",
        help="Attach a URL with your own title/summary to a meeting (stored only, never fetched)",
    )
    add_resource.add_argument("--meeting", required=True, help="Meeting node id (meeting:<hex>)")
    add_resource.add_argument("--url", required=True, help="https URL without credentials")
    add_resource.add_argument("--title", required=True)
    add_resource.add_argument("--summary", default="")
    add_resource.add_argument(
        "--relation", choices=sorted(RESOURCE_RELATIONS), default="reference"
    )
    add_resource.add_argument(
        "--allow-private", action="store_true", help="Allow attaching to a private meeting"
    )
    add_resource.add_argument(
        "--allow-loopback", action="store_true", help="Allow http(s) loopback URLs"
    )
    resources_list = sub.add_parser(
        "memory-resources", help="List stored URL resources (shared only by default)"
    )
    resources_list.add_argument("--meeting", help="Only resources on this meeting node id")
    resources_list.add_argument("--limit", type=int, default=50)
    resources_list.add_argument("--include-private", action="store_true")

    sub.add_parser("correct-inbox", help="List shared meetings with ambiguous speaker labels")
    correct = sub.add_parser("correct", help="Plan or reprocess a speaker-label correction")
    correct.add_argument("--meeting", required=True, help="Shared meeting key (wiki/meetings/*.md)")
    correct.add_argument(
        "--speaker", action="append", required=True, help="Exact OLD=NEW mapping; repeat as needed"
    )
    correct.add_argument(
        "--reprocess",
        action="store_true",
        help="Enqueue reprocessing after reviewing the plan",
    )
    events = sub.add_parser(
        "events",
        help="Print the privacy-safe local event journal (codes and timestamps only)",
    )
    events.add_argument("--limit", type=int, default=100)

    args = parser.parse_args(argv)
    if args.command == "init":
        return init_command(args.config)
    if args.command == "mcp":
        from .mcp_server import main as mcp_main

        mcp_main()
        return 0
    if args.command == "self-check":
        from .self_check import run_self_check

        report = run_self_check(args.config)
        print(json.dumps(report))
        ready = report["config"] == "ok" and all(
            status == "ready" for status in report["capabilities"].values()
        )
        return 0 if ready else 1

    config = load_config(args.config)
    if args.command == "live":
        return live_command(config, Path(args.mic_audio), args.private)
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
    if args.command == "brief":
        from .briefs import generate_upcoming_briefs
        from .providers.local_storage import LocalFileStorage

        shared_storage = _build_storage(config)
        # Private briefs never touch S3; they stay in the local private tree.
        private_storage = (
            shared_storage
            if config.providers.storage == "local"
            else LocalFileStorage(config.data_dir)
        )
        summary = generate_upcoming_briefs(
            shared_storage, private_storage, _build_calendar(config), config, args.within
        )
        print(json.dumps(summary, indent=2))
        return 0
    if args.command == "reindex-memory":
        return reindex_memory_command(config)
    if args.command == "memory-search":
        return memory_search_command(config, args)
    if args.command == "memory-add-resource":
        return memory_add_resource_command(config, args)
    if args.command == "memory-resources":
        return memory_resources_command(config, args)
    if args.command == "correct-inbox":
        print(json.dumps(build_inbox(_build_storage(config)), indent=2))
        return 0
    if args.command == "correct":
        storage = _build_storage(config)
        try:
            mapping = parse_speaker_corrections(args.speaker)
        except ValueError as error:
            print(json.dumps({"error": "invalid_mapping", "message": str(error)}))
            return 1
        if not args.reprocess:
            try:
                plan = plan_correction(storage, args.meeting, mapping)
            except ValueError as error:
                print(json.dumps({"error": "invalid_correction", "message": str(error)}))
                return 1
            print(json.dumps(plan.to_dict(), indent=2))
            return 0
        queue = JobQueue(
            config.data_dir / "jobs.db",
            max_attempts=config.jobs.max_attempts,
            backoff_base_seconds=config.jobs.backoff_base_seconds,
            visibility_timeout_seconds=config.jobs.visibility_timeout_seconds,
        )
        try:
            result = apply_correction(storage, queue, args.meeting, mapping)
        except ValueError as error:
            print(json.dumps({"error": "invalid_correction", "message": str(error)}))
            return 1
        print(json.dumps(result, indent=2))
        return 0 if "job_id" in result else 1
    if args.command == "events":
        journal = open_journal(config.data_dir)
        print(json.dumps({"events": journal.recent(args.limit) if journal else []}, indent=2))
        return 0
    if args.command in {"status", "retry", "dismiss", "restore", "cleanup-dismissed"}:
        queue = JobQueue(
            config.data_dir / "jobs.db",
            max_attempts=config.jobs.max_attempts,
            backoff_base_seconds=config.jobs.backoff_base_seconds,
            visibility_timeout_seconds=config.jobs.visibility_timeout_seconds,
            journal=open_journal(config.data_dir) if args.command != "status" else None,
        )
        if args.command == "cleanup-dismissed":
            try:
                deleted = queue.cleanup_dismissed(args.older_than_days * 24 * 60 * 60)
            except ValueError as error:
                print(json.dumps({"error": "invalid_retention", "message": str(error)}))
                return 1
            print(
                json.dumps(
                    {
                        "dismissed_rows_deleted": deleted,
                        "older_than_days": args.older_than_days,
                        "meeting_artifacts_deleted": False,
                    }
                )
            )
            return 0
        if args.command in {"retry", "dismiss", "restore"}:
            action = args.command
            action_error = {
                "retry": "job_not_retryable",
                "dismiss": "job_not_dismissible",
                "restore": "job_not_restorable",
            }[action]
            try:
                job = getattr(queue, action)(args.job_id)
            except KeyError:
                print(json.dumps({"error": "job_not_found", "job_id": args.job_id}))
                return 1
            except ValueError as error:
                print(
                    json.dumps(
                        {
                            "error": action_error,
                            "job_id": args.job_id,
                            "message": str(error),
                        }
                    )
                )
                return 1
            action_result = {
                "retry": "retried",
                "dismiss": "dismissed",
                "restore": "restored",
            }[action]
            print(
                json.dumps(
                    {
                        "job_id": job.id,
                        "state": job.state.value,
                        action_result: True,
                    }
                )
            )
            return 0
        if args.summary:
            print(json.dumps(queue.summary(), indent=2))
            return 0
        state = JobState(args.state) if args.state else None
        jobs = queue.list(state)
        output = (
            [job.model_dump(mode="json") for job in jobs]
            if args.verbose
            else [redacted_job_record(job) for job in jobs]
        )
        print(json.dumps(output, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
