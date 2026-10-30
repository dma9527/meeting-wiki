from __future__ import annotations

import hashlib
import json

import pytest

from meeting_wiki.config import AppConfig
from meeting_wiki.engine import MeetingEngine
from meeting_wiki.providers.base import TranscriptionCapabilities, storage_revision
from meeting_wiki.providers.local_storage import LocalFileStorage
from meeting_wiki.providers.registry import ProviderBundle
from meeting_wiki.providers.s3_storage import (
    BLOB_PREFIX,
    MANIFEST_KEY,
    S3Storage,
    StorageRevisionConflict,
)

PREFIX = "team-wiki/"


class FakeClientError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeNoSuchKey(FakeClientError):
    def __init__(self):
        super().__init__("NoSuchKey")


class FakeBody:
    def __init__(self, data: bytes):
        self.data = data

    def read(self) -> bytes:
        return self.data


class FakeExceptions:
    NoSuchKey = FakeNoSuchKey


class FakePaginator:
    def __init__(self, client: FakeS3Client):
        self.client = client

    def paginate(self, Bucket: str, Prefix: str):
        keys = sorted(key for key in self.client.objects if key.startswith(Prefix))
        yield {"Contents": [{"Key": key} for key in keys]}


class FakeS3Client:
    """In-memory S3 with ETags and If-Match / If-None-Match on PutObject."""

    exceptions = FakeExceptions

    def __init__(self):
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.versions = 0
        self.before_manifest_put = None
        self.manifest_puts: list[dict[str, object]] = []

    def get_object(self, Bucket: str, Key: str, IfNoneMatch: str | None = None):
        if Key not in self.objects:
            raise FakeNoSuchKey()
        data, etag = self.objects[Key]
        if IfNoneMatch is not None and IfNoneMatch == etag:
            raise FakeClientError("304")
        return {"Body": FakeBody(data), "ETag": etag}

    def put_object(
        self,
        Bucket: str,
        Key: str,
        Body: bytes,
        IfMatch: str | None = None,
        IfNoneMatch: str | None = None,
        **_kwargs: object,
    ):
        if Key.endswith(MANIFEST_KEY) and self.before_manifest_put is not None:
            hook, self.before_manifest_put = self.before_manifest_put, None
            hook()
        current = self.objects.get(Key)
        if IfNoneMatch == "*" and current is not None:
            raise FakeClientError("PreconditionFailed")
        if IfMatch is not None and (current is None or current[1] != IfMatch):
            raise FakeClientError("PreconditionFailed")
        self.versions += 1
        etag = f'"{hashlib.md5(Body).hexdigest()}-{self.versions}"'
        self.objects[Key] = (Body, etag)
        if Key.endswith(MANIFEST_KEY):
            self.manifest_puts.append(json.loads(Body))
        return {"ETag": etag}

    def head_object(self, Bucket: str, Key: str):
        if Key not in self.objects:
            raise FakeClientError("404")
        return {"ETag": self.objects[Key][1]}

    def get_paginator(self, name: str):
        assert name == "list_objects_v2"
        return FakePaginator(self)


def make_storage(client: FakeS3Client) -> S3Storage:
    return S3Storage("test-bucket", PREFIX, "us-east-1", "", client=client)


def test_revision_is_invisible_to_readers_until_commit():
    client = FakeS3Client()
    writer, reader = make_storage(client), make_storage(client)
    with writer.revision():
        writer.write_text("wiki/meetings/one.md", "meeting")
        writer.write_text("wiki/index.md", "index")
        assert reader.read_text("wiki/meetings/one.md") is None
        assert reader.list_keys("wiki/") == []
    assert reader.read_text("wiki/meetings/one.md") == "meeting"
    assert reader.list_keys("wiki/") == ["wiki/index.md", "wiki/meetings/one.md"]
    assert [put["revision"] for put in client.manifest_puts] == [1]


def test_failed_revision_publishes_nothing():
    client = FakeS3Client()
    writer = make_storage(client)
    with pytest.raises(RuntimeError, match="boom"), writer.revision():
        writer.write_text("wiki/meetings/one.md", "meeting")
        raise RuntimeError("boom")
    assert client.objects == {}
    assert make_storage(client).read_text("wiki/meetings/one.md") is None


def test_revision_reads_and_lists_its_own_staged_writes():
    client = FakeS3Client()
    writer = make_storage(client)
    writer.write_text("wiki/people/alex.md", "v1")
    with writer.revision():
        writer.write_text("wiki/people/alex.md", "v2")
        writer.write_text("wiki/people/sam.md", "sam")
        assert writer.read_text("wiki/people/alex.md") == "v2"
        assert writer.exists("wiki/people/sam.md")
        assert writer.list_keys("wiki/people/") == ["wiki/people/alex.md", "wiki/people/sam.md"]
    assert make_storage(client).read_text("wiki/people/alex.md") == "v2"


def test_concurrent_change_to_read_key_raises_conflict_and_keeps_winner():
    client = FakeS3Client()
    first, second = make_storage(client), make_storage(client)
    first.write_text("wiki/action-items/active.md", "base")
    client.before_manifest_put = lambda: second.write_text("wiki/action-items/active.md", "winner")
    with pytest.raises(StorageRevisionConflict), first.revision():
        existing = first.read_text("wiki/action-items/active.md")
        first.write_text("wiki/action-items/active.md", f"{existing} + loser")
    assert make_storage(client).read_text("wiki/action-items/active.md") == "winner"


def test_concurrent_unrelated_revision_rebases_without_losing_either_write():
    client = FakeS3Client()
    first, second = make_storage(client), make_storage(client)
    client.before_manifest_put = lambda: second.write_text("wiki/people/sam.md", "sam")
    first.write_text("wiki/people/alex.md", "alex")
    reader = make_storage(client)
    assert reader.read_text("wiki/people/alex.md") == "alex"
    assert reader.read_text("wiki/people/sam.md") == "sam"
    assert client.manifest_puts[-1]["revision"] == 2


def test_concurrent_new_key_under_listed_prefix_raises_conflict():
    client = FakeS3Client()
    first, second = make_storage(client), make_storage(client)
    client.before_manifest_put = lambda: second.write_text("wiki/meetings/new.md", "new")
    with pytest.raises(StorageRevisionConflict), first.revision():
        listed = first.list_keys("wiki/meetings/")
        first.write_text("wiki/meetings/index.md", "\n".join(listed))


def test_private_and_reserved_keys_never_reach_s3():
    client = FakeS3Client()
    storage = make_storage(client)
    with pytest.raises(PermissionError):
        storage.write_text("private/meetings/secret.md", "secret", private=True)
    with pytest.raises(PermissionError):
        storage.write_text("wiki/private/secret.md", "secret")
    with pytest.raises(PermissionError):
        storage.read_text("private/transcripts/secret.txt")
    with pytest.raises(ValueError):
        storage.write_text(MANIFEST_KEY, "{}")
    assert client.objects == {}


def test_manifest_with_private_key_is_rejected():
    client = FakeS3Client()
    manifest = {"format": 1, "revision": 1, "objects": {"private/x.md": {"sha256": "0"}}}
    client.objects[PREFIX + MANIFEST_KEY] = (json.dumps(manifest).encode(), '"tampered"')
    with pytest.raises(PermissionError):
        make_storage(client).read_text("wiki/index.md")


def test_legacy_objects_stay_readable_until_superseded():
    client = FakeS3Client()
    client.objects[PREFIX + "wiki/index.md"] = (b"legacy index", '"legacy"')
    storage = make_storage(client)
    assert storage.read_text("wiki/index.md") == "legacy index"
    assert storage.list_keys("wiki/") == ["wiki/index.md"]
    storage.write_text("wiki/index.md", "new index")
    assert make_storage(client).read_text("wiki/index.md") == "new index"
    assert make_storage(client).list_keys("") == ["wiki/index.md"]


def test_tampered_blob_fails_integrity_check():
    client = FakeS3Client()
    storage = make_storage(client)
    storage.write_text("wiki/index.md", "index")
    digest = hashlib.sha256(b"index").hexdigest()
    client.objects[PREFIX + BLOB_PREFIX + digest] = (b"tampered", '"x"')
    with pytest.raises(RuntimeError, match="integrity"):
        make_storage(client).read_text("wiki/index.md")


def test_local_storage_revision_keeps_immediate_writes(tmp_path):
    storage = LocalFileStorage(tmp_path)
    with storage_revision(storage):
        storage.write_text("wiki/index.md", "index")
        assert (tmp_path / "wiki" / "index.md").read_text() == "index"


class RecordingLLM:
    name = "fake"

    def __init__(self, result, on_analyze):
        self.result = result
        self.on_analyze = on_analyze

    def analyze(self, meeting, transcript):
        self.on_analyze()
        return self.result


class StaticTranscriber:
    name = "fake"
    capabilities = TranscriptionCapabilities()

    def __init__(self, result):
        self.result = result

    def transcribe(self, audio_path, language=None, context=None):
        return self.result


class NoCalendar:
    name = "none"

    def upcoming(self, within_minutes):
        return []

    def match(self, occurred_at, tolerance_minutes=15):
        return None


class SilentNotification:
    name = "fake"

    def notify(self, title, body, level="info"):
        return None


class NoTask:
    name = "none"


def s3_bundle(tmp_path, client, transcript, llm):
    return ProviderBundle(
        transcription=StaticTranscriber(transcript),
        llm=llm,
        storage=make_storage(client),
        private_storage=LocalFileStorage(tmp_path),
        calendar=NoCalendar(),
        notification=SilentNotification(),
        task=NoTask(),
    )


def test_ingest_publishes_transcript_then_meeting_as_atomic_revisions(
    tmp_path, meeting, transcript, analysis
):
    client = FakeS3Client()
    reader = make_storage(client)
    seen_during_analysis: list[list[str]] = []
    llm = RecordingLLM(analysis, lambda: seen_during_analysis.append(reader.list_keys("")))
    source = tmp_path / "meeting.txt"
    source.write_text("Alex: hello")
    meeting = meeting.model_copy(update={"transcript_path": source})

    result = MeetingEngine(
        AppConfig(data_dir=tmp_path), s3_bundle(tmp_path, client, transcript, llm)
    ).ingest(meeting)

    assert seen_during_analysis == [sorted([result.transcript_key, result.transcript_data_key])]
    transcript_revision, meeting_revision = client.manifest_puts
    assert set(transcript_revision["objects"]) == {
        result.transcript_key,
        result.transcript_data_key,
    }
    published = set(meeting_revision["objects"])
    assert {result.analysis_key, result.render.meeting_key, "wiki/index.md"} <= published
    assert all(
        entry["revision"] == 2
        for key, entry in meeting_revision["objects"].items()
        if key not in transcript_revision["objects"]
    )
    assert reader.read_text(result.render.meeting_key)


def test_failed_render_leaves_only_reusable_transcript_revision(
    tmp_path, meeting, transcript, analysis, monkeypatch
):
    client = FakeS3Client()
    source = tmp_path / "meeting.txt"
    source.write_text("Alex: hello")
    meeting = meeting.model_copy(update={"transcript_path": source})

    def explode(*_args, **_kwargs):
        raise RuntimeError("render failed")

    monkeypatch.setattr("meeting_wiki.engine.WikiRenderer.apply", explode)
    llm = RecordingLLM(analysis, lambda: None)
    with pytest.raises(RuntimeError, match="render failed"):
        MeetingEngine(
            AppConfig(data_dir=tmp_path), s3_bundle(tmp_path, client, transcript, llm)
        ).ingest(meeting)

    keys = make_storage(client).list_keys("")
    assert len(client.manifest_puts) == 1
    assert all(key.startswith(("transcripts/", "transcript-data/")) for key in keys)
