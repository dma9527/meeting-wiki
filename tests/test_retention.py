from __future__ import annotations

import os
import sqlite3
import time

import pytest
from data_fixtures import populate
from test_deletion import tree_digest

from meeting_wiki.config import RetentionConfig
from meeting_wiki.retention import plan_retention

DAY = 86400


@pytest.fixture
def populated(tmp_path, meeting, transcript, analysis):
    return populate(tmp_path, meeting, transcript, analysis)


def age(path, seconds):
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def test_default_plan_keeps_everything_but_reports_stale_live_chunks(populated):
    age(populated.data_dir / "tmp" / "live-old", 2 * DAY)
    plan = plan_retention(populated.data_dir, RetentionConfig())
    assert plan["deleted"] is False
    assert plan["rules"]["audio"]["enabled"] is False
    assert plan["rules"]["backups"]["enabled"] is False
    assert plan["rules"]["live_tmp"]["eligible_directories"] == 1


def test_audio_plan_only_targets_traceable_finished_audio_and_deletes_nothing(populated):
    for path in [populated.shared_audio, *(populated.data_dir / "private" / "audio").iterdir()]:
        age(path, 200 * DAY)
    untraced = populated.data_dir / "audio" / "orphan.wav"
    untraced.write_bytes(b"x")
    age(untraced, 200 * DAY)
    before = tree_digest(populated.data_dir)
    plan = plan_retention(populated.data_dir, RetentionConfig(audio_days=90))
    assert tree_digest(populated.data_dir) == before
    audio = plan["rules"]["audio"]
    assert audio["eligible_files"] == 2
    assert audio["retained_untraceable"] == 1
    assert audio["protected_unfinished_jobs"] == 0


def test_audio_for_unfinished_jobs_is_protected(populated):
    age(populated.shared_audio, 200 * DAY)
    with sqlite3.connect(populated.data_dir / "jobs.db") as connection:
        connection.execute("UPDATE jobs SET state='dead'")
    plan = plan_retention(populated.data_dir, RetentionConfig(audio_days=90))
    assert plan["rules"]["audio"]["protected_unfinished_jobs"] == 1


def test_backup_and_dismissed_job_plans(populated):
    backups = populated.data_dir / "backups"
    backups.mkdir()
    for index in range(3):
        archive = backups / f"meeting-wiki-{index}.mwbackup"
        archive.write_bytes(b"x" * 10)
        age(archive, (3 - index) * DAY)
    with sqlite3.connect(populated.data_dir / "jobs.db") as connection:
        connection.execute("UPDATE jobs SET state='dismissed', updated_at=0")
    plan = plan_retention(
        populated.data_dir, RetentionConfig(backups_keep=1, dismissed_jobs_days=30)
    )
    assert plan["rules"]["backups"]["eligible_archives"] == 2
    assert plan["rules"]["backups"]["eligible_bytes"] == 20
    assert plan["rules"]["dismissed_jobs"]["eligible_rows"] == 1
    assert len(list(backups.iterdir())) == 3
