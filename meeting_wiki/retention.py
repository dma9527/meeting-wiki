"""Read-only retention planning. Reports counts and sizes; never deletes."""

from __future__ import annotations

import json
import re
import time
from contextlib import closing
from pathlib import Path

from .backup import ARCHIVE_SUFFIX, connect_read_only
from .config import RetentionConfig

_PRIVATE_AUDIO = re.compile(r"(\d{4}-\d{2}-\d{2}-[0-9a-f]{16})-(?:merged|mic|system)\.[a-z0-9]+")
_DAY = 86400.0


def _regular_files(directory: Path) -> list[Path]:
    if directory.is_symlink() or not directory.is_dir():
        return []
    return sorted(path for path in directory.iterdir() if path.is_file() and not path.is_symlink())


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def _job_audio_states(data_dir: Path) -> dict[Path, set[str]]:
    states: dict[Path, set[str]] = {}
    path = data_dir / "jobs.db"
    if not path.is_file():
        return states
    connection = connect_read_only(path)
    with closing(connection):
        for state, payload in connection.execute("SELECT state, payload FROM jobs"):
            try:
                data = json.loads(payload)
            except (TypeError, json.JSONDecodeError):
                continue
            for field in ("audio_path", "mic_audio_path", "system_audio_path"):
                value = data.get(field)
                if isinstance(value, str) and value:
                    states.setdefault(Path(value).resolve(), set()).add(str(state))
    return states


def _rule(enabled: bool, threshold: object, **counts: int) -> dict[str, object]:
    return {"enabled": enabled, "threshold": threshold, **counts}


def plan_retention(
    data_dir: Path, retention: RetentionConfig, now: float | None = None
) -> dict[str, object]:
    root = data_dir.expanduser().resolve()
    current = time.time() if now is None else now
    rules: dict[str, object] = {}

    if retention.audio_days is None:
        rules["audio"] = _rule(False, None)
    else:
        cutoff = current - retention.audio_days * _DAY
        job_states = _job_audio_states(root)
        eligible = protected = unlinked = eligible_bytes = 0
        for path in _regular_files(root / "audio"):
            if path.stat().st_mtime >= cutoff:
                continue
            states = job_states.get(path.resolve())
            if not states:
                unlinked += 1
            elif states == {"done"}:
                eligible += 1
                eligible_bytes += path.stat().st_size
            else:
                protected += 1
        for path in _regular_files(root / "private" / "audio"):
            if path.stat().st_mtime >= cutoff:
                continue
            match = _PRIVATE_AUDIO.fullmatch(path.name)
            if match and (root / "private" / "transcripts" / f"{match.group(1)}.txt").is_file():
                eligible += 1
                eligible_bytes += path.stat().st_size
            else:
                unlinked += 1
        rules["audio"] = _rule(
            True,
            {"days": retention.audio_days},
            eligible_files=eligible,
            eligible_bytes=eligible_bytes,
            protected_unfinished_jobs=protected,
            retained_untraceable=unlinked,
        )

    if retention.dismissed_jobs_days is None:
        rules["dismissed_jobs"] = _rule(False, None)
    else:
        count = 0
        path = root / "jobs.db"
        if path.is_file():
            connection = connect_read_only(path)
            with closing(connection):
                count = int(
                    connection.execute(
                        "SELECT COUNT(*) FROM jobs WHERE state='dismissed' AND updated_at < ?",
                        (current - retention.dismissed_jobs_days * _DAY,),
                    ).fetchone()[0]
                )
        rules["dismissed_jobs"] = _rule(
            True,
            {"days": retention.dismissed_jobs_days},
            eligible_rows=count,
            apply_with="cleanup-dismissed",
        )

    if retention.live_tmp_hours is None:
        rules["live_tmp"] = _rule(False, None)
    else:
        cutoff = current - retention.live_tmp_hours * 3600
        directory = root / "tmp"
        stale = [
            path
            for path in (sorted(directory.glob("live-*")) if directory.is_dir() else [])
            if path.is_dir() and not path.is_symlink() and path.stat().st_mtime < cutoff
        ]
        rules["live_tmp"] = _rule(
            True,
            {"hours": retention.live_tmp_hours},
            eligible_directories=len(stale),
            eligible_bytes=sum(_size(path) for path in stale),
        )

    if retention.backups_keep is None:
        rules["backups"] = _rule(False, None)
    else:
        archives = sorted(
            (
                path
                for path in _regular_files(root / "backups")
                if path.name.endswith(ARCHIVE_SUFFIX)
            ),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        excess = archives[retention.backups_keep :]
        rules["backups"] = _rule(
            True,
            {"keep": retention.backups_keep},
            archives=len(archives),
            eligible_archives=len(excess),
            eligible_bytes=sum(path.stat().st_size for path in excess),
        )

    return {"rules": rules, "deleted": False, "automatic_deletion": False}
