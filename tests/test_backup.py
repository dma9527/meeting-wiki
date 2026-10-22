from __future__ import annotations

import io
import json
import sqlite3

import pytest
from data_fixtures import FAKE_SECRET, populate

from meeting_wiki import cli
from meeting_wiki.backup import (
    MAGIC,
    BackupError,
    collect_members,
    create_backup,
    restore_backup,
    verify_backup,
)

PASSPHRASE = "correct horse battery staple"
FAST_N = 2**10


@pytest.fixture
def populated(tmp_path, meeting, transcript, analysis):
    return populate(tmp_path, meeting, transcript, analysis)


def make_backup(populated, tmp_path, passphrase=PASSPHRASE):
    return create_backup(
        populated.data_dir,
        populated.config_path,
        tmp_path / "out" / "backup.mwbackup",
        passphrase,
        scrypt_n=FAST_N,
    )


def test_backup_round_trip_restores_every_category_and_verifies(populated, tmp_path):
    report = make_backup(populated, tmp_path)
    assert set(report.categories) == {
        "analysis", "audio", "config", "databases", "integration_state", "transcripts", "wiki"
    }
    assert report.skipped["secret_store"] == 1
    assert report.skipped["secret_like_file"] == 1
    assert report.skipped["logs"] == 1
    assert report.skipped["temporary"] == 1
    assert report.skipped["transient_integration_events"] == 1
    assert report.archive.stat().st_mode & 0o777 == 0o600

    verified = verify_backup(report.archive, PASSPHRASE)
    assert verified.members == report.members
    assert verified.memory["resources"] == 1

    target = tmp_path / "restored"
    restored = restore_backup(report.archive, target, PASSPHRASE)
    assert restored.databases == {
        "events.db": "ok", "jobs.db": "ok", "memory.db": "ok", "outbox.db": "ok"
    }
    assert (target / populated.shared_key).read_bytes() == (
        populated.data_dir / populated.shared_key
    ).read_bytes()
    assert (target / populated.private_key).is_file()
    assert (target / "audio" / "meeting.wav").read_bytes() == b"RIFF-shared-audio"
    assert len(list((target / "private" / "audio").glob("*.wav"))) == 1
    assert (target / "config.toml").read_text() == populated.config_path.read_text()
    assert (target / "integrations" / "google-meet" / "manifest.json").is_file()
    assert not (target / "secrets.json").exists()
    assert not (target / ".env").exists()
    assert not (target / "logs").exists()
    assert not (target / "tmp").exists()
    with sqlite3.connect(target / "memory.db") as connection:
        assert connection.execute("SELECT COUNT(*) FROM memory_resources").fetchone()[0] == 1


def test_archive_never_contains_plaintext_or_secrets(populated, tmp_path):
    report = make_backup(populated, tmp_path)
    raw = report.archive.read_bytes()
    assert raw.startswith(MAGIC)
    for needle in (FAKE_SECRET, PASSPHRASE, "RIFF-shared-audio", "Architecture", "option B"):
        assert needle.encode() not in raw


def test_wrong_passphrase_is_rejected_with_fixed_code(populated, tmp_path):
    report = make_backup(populated, tmp_path)
    with pytest.raises(BackupError) as error:
        verify_backup(report.archive, "wrong passphrase value")
    assert error.value.code == "wrong_passphrase_or_corrupt"
    assert PASSPHRASE not in str(error.value)


@pytest.mark.parametrize("damage", ["flip_late_byte", "truncate"])
def test_tampered_or_truncated_archive_fails_verification(populated, tmp_path, damage):
    report = make_backup(populated, tmp_path)
    data = bytearray(report.archive.read_bytes())
    if damage == "flip_late_byte":
        data[-40] ^= 0x01
    else:
        data = data[: len(data) // 2]
    report.archive.write_bytes(bytes(data))
    with pytest.raises(BackupError) as error:
        verify_backup(report.archive, PASSPHRASE)
    # A small archive is one frame, where tampering and a wrong key are indistinguishable.
    assert error.value.code in {
        "archive_corrupt", "archive_truncated", "wrong_passphrase_or_corrupt"
    }


def test_restore_refuses_nonempty_target_and_leaves_it_untouched(populated, tmp_path):
    report = make_backup(populated, tmp_path)
    target = tmp_path / "existing"
    target.mkdir()
    (target / "keep.txt").write_text("mine")
    with pytest.raises(BackupError) as error:
        restore_backup(report.archive, target, PASSPHRASE)
    assert error.value.code == "restore_target_not_empty"
    assert [path.name for path in target.iterdir()] == ["keep.txt"]


def test_failed_restore_leaves_no_partial_target(populated, tmp_path):
    report = make_backup(populated, tmp_path)
    target = tmp_path / "restored"
    with pytest.raises(BackupError):
        restore_backup(report.archive, target, "wrong passphrase value")
    assert not target.exists()
    assert [path.name for path in tmp_path.iterdir() if ".restore-" in path.name] == []


def test_backup_refuses_to_overwrite_and_short_passphrase(populated, tmp_path):
    report = make_backup(populated, tmp_path)
    before = report.archive.read_bytes()
    with pytest.raises(BackupError) as error:
        make_backup(populated, tmp_path)
    assert error.value.code == "archive_exists"
    assert report.archive.read_bytes() == before
    with pytest.raises(BackupError) as error:
        make_backup(populated, tmp_path / "other", passphrase="short")
    assert error.value.code == "passphrase_too_short"


def test_config_with_inline_credential_is_excluded(populated):
    populated.config_path.write_text('[webhook]\nurl = "https://tasks.example/hook?token=0000"\n')
    members, skipped = collect_members(populated.data_dir, populated.config_path)
    assert skipped["config_contains_credential"] == 1
    assert all(member.name != "config/config.toml" for member in members)


def test_snapshot_includes_uncheckpointed_wal_rows(populated, tmp_path):
    connection = sqlite3.connect(populated.data_dir / "jobs.db")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute(
        "INSERT INTO jobs (job_type, payload, max_attempts, dedupe_key, created_at, updated_at) "
        "VALUES ('ingest', '{}', 1, 'wal-only', 0, 0)"
    )
    connection.commit()
    report = make_backup(populated, tmp_path)
    connection.close()
    target = tmp_path / "restored"
    restore_backup(report.archive, target, PASSPHRASE)
    with sqlite3.connect(target / "jobs.db") as restored:
        rows = restored.execute("SELECT COUNT(*) FROM jobs WHERE dedupe_key='wal-only'")
        assert rows.fetchone()[0] == 1


def test_cli_reads_passphrase_from_stdin_and_never_prints_it(
    populated, tmp_path, monkeypatch, capsys
):
    archive = tmp_path / "cli.mwbackup"
    monkeypatch.setattr("sys.stdin", io.StringIO(PASSPHRASE + "\n"))
    code = cli.main(
        [
            "--config", str(populated.config_path),
            "backup-create", "--output", str(archive), "--passphrase-stdin",
        ]
    )
    output = capsys.readouterr().out
    assert code == 0
    assert json.loads(output)["secrets_included"] is False
    assert PASSPHRASE not in output

    monkeypatch.setattr("sys.stdin", io.StringIO("wrong passphrase value\n"))
    code = cli.main(["backup-verify", "--archive", str(archive), "--passphrase-stdin"])
    output = capsys.readouterr().out
    assert code == 1
    assert json.loads(output) == {"error": "wrong_passphrase_or_corrupt"}

    monkeypatch.setattr("sys.stdin", io.StringIO(PASSPHRASE + "\n"))
    target = tmp_path / "cli-restore"
    code = cli.main(
        ["backup-restore", "--archive", str(archive), "--target", str(target),
         "--passphrase-stdin"]
    )
    result = json.loads(capsys.readouterr().out)
    assert code == 0
    assert result["restored"] is True
    assert result["secrets_restored"] is False


def test_cli_refuses_passphrase_without_tty_or_stdin_flag(populated, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    code = cli.main(["--config", str(populated.config_path), "backup-create"])
    assert code == 1
    assert json.loads(capsys.readouterr().out) == {"error": "passphrase_requires_tty_or_stdin"}


def test_multi_frame_tamper_after_first_frame_is_reported_as_corrupt(populated, tmp_path):
    (populated.data_dir / "audio" / "long.wav").write_bytes(b"\x01" * (3 * 1024 * 1024))
    report = make_backup(populated, tmp_path)
    data = bytearray(report.archive.read_bytes())
    data[len(data) // 2] ^= 0x01
    report.archive.write_bytes(bytes(data))
    with pytest.raises(BackupError) as error:
        verify_backup(report.archive, PASSPHRASE)
    assert error.value.code == "archive_corrupt"
