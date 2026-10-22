from __future__ import annotations

import hashlib
import json

import pytest
from data_fixtures import populate

from meeting_wiki import cli
from meeting_wiki.deletion import DeletionPreviewError, preview_meeting_deletion
from meeting_wiki.providers.local_storage import LocalFileStorage


@pytest.fixture
def populated(tmp_path, meeting, transcript, analysis):
    return populate(tmp_path, meeting, transcript, analysis)


def tree_digest(root):
    """Digest of every file except SQLite's shared-memory index, which readers may touch."""
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.name.endswith("-shm"):
            digest.update(str(path.relative_to(root)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def preview(populated, key, **kwargs):
    storage = LocalFileStorage(populated.data_dir)
    return preview_meeting_deletion(populated.data_dir, storage, key, **kwargs)


def test_shared_preview_enumerates_every_artifact_and_changes_nothing(populated):
    before = tree_digest(populated.data_dir)
    result = preview(populated, populated.shared_key)
    assert tree_digest(populated.data_dir) == before
    assert result["deleted"] is False
    kinds = {}
    for artifact in result["artifacts"]:
        kinds.setdefault(artifact["kind"], []).append(artifact)
    for kind in ("meeting_page", "transcript_text", "transcript_data", "analysis", "decision"):
        assert kinds[kind][0]["effect"] == "delete"
        assert kinds[kind][0]["exists"] is True
    assert {item["key"] for item in kinds["person_timeline"]} == {
        "wiki/people/alex.md",
        "wiki/people/sam.md",
    }
    assert kinds["action_item_rows"][0]["effect"] == "edit"
    assert kinds["audio"] == [
        {
            "kind": "audio",
            "key": "audio/meeting.wav",
            "location": "local",
            "effect": "delete",
            "exists": True,
        }
    ]
    assert {item["effect"] for item in kinds["index"]} == {"rebuild"}
    assert result["jobs"][0]["state"] == "done"
    assert result["memory"]["nodes"]["meeting"] == 1
    assert result["memory"]["resources"][0]["host"] == "https://docs.example"
    task = result["tasks"][0]
    assert task["external_host"] == "https://tasks.example"
    assert task["external_effect"] == "retain_external"
    assert len(task["ref"]) == 12
    assert result["events"]["rows"] >= 1
    assert "external_tasks_must_be_removed_in_the_task_system" in result["notes"]


def test_shared_preview_never_exposes_private_artifacts_or_full_urls(populated):
    text = json.dumps(preview(populated, populated.shared_key))
    assert "private/" not in text
    assert "/proposal" not in text
    assert "id=0000" not in text
    assert "Write the migration plan" not in text


def test_private_preview_requires_explicit_opt_in(populated):
    with pytest.raises(DeletionPreviewError, match="private_meeting_requires_allow_private"):
        preview(populated, populated.private_key)
    result = preview(populated, populated.private_key, allow_private=True)
    assert result["privacy"] == "private"
    assert result["tasks"] == []
    audio = [item for item in result["artifacts"] if item["kind"] == "audio"]
    assert len(audio) == 1 and audio[0]["key"].startswith("private/audio/")
    assert all(not item["key"].startswith("wiki/") for item in result["artifacts"])


def test_plan_digest_is_stable_for_unchanged_data(populated):
    first = preview(populated, populated.shared_key)
    second = preview(populated, populated.shared_key)
    assert first["plan_digest"] == second["plan_digest"]


@pytest.mark.parametrize(
    "key",
    [
        "../etc/passwd.md",
        "wiki/meetings/index.md",
        "wiki/people/alex.md",
        "transcripts/x.txt",
        "wiki/meetings/missing.md",
    ],
)
def test_invalid_or_missing_keys_are_refused(populated, key):
    with pytest.raises(DeletionPreviewError):
        preview(populated, key)


def test_shared_tree_page_claiming_private_is_refused(populated):
    page = populated.data_dir / populated.shared_key
    page.write_text(page.read_text().replace('privacy: "shared"', 'privacy: "private"'))
    with pytest.raises(DeletionPreviewError, match="privacy_mismatch"):
        preview(populated, populated.shared_key)


def test_cli_delete_preview_reports_preview_only(populated, capsys):
    code = cli.main(
        [
            "--config",
            str(populated.config_path),
            "delete-preview",
            "--meeting",
            populated.private_key,
        ]
    )
    assert code == 1
    assert json.loads(capsys.readouterr().out)["error"] == (
        "private_meeting_requires_allow_private"
    )
    code = cli.main(
        [
            "--config",
            str(populated.config_path),
            "delete-preview",
            "--meeting",
            populated.shared_key,
        ]
    )
    assert code == 0
    assert json.loads(capsys.readouterr().out)["deleted"] is False
