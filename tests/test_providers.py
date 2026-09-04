from __future__ import annotations

import socket

import pytest

from meeting_wiki.providers.integrations import validate_webhook_url
from meeting_wiki.providers.s3_storage import S3Storage
from meeting_wiki.providers.transcription import TextImportTranscriber


def test_text_import_detects_speaker_labels(tmp_path):
    path = tmp_path / "meeting.txt"
    path.write_text("Alex: hello\nSam: hi")
    result = TextImportTranscriber().transcribe(path, "en")
    assert result.diarized is True
    assert result.language == "en"
    assert result.text.startswith("Alex")


def test_webhook_requires_https():
    with pytest.raises(ValueError, match="https"):
        validate_webhook_url("http://example.com/hook")
    with pytest.raises(ValueError, match="https"):
        validate_webhook_url("file:///etc/passwd")


def test_webhook_rejects_private_resolution(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))],
    )
    with pytest.raises(ValueError, match="private/reserved"):
        validate_webhook_url("https://internal.example/hook")
    validate_webhook_url("https://internal.example/hook", allow_private_networks=True)


def test_s3_provider_hard_blocks_private_prefix_without_network():
    provider = object.__new__(S3Storage)
    provider.prefix = "meeting-wiki/"
    with pytest.raises(PermissionError, match="Private"):
        provider._key("private/meetings/secret.md")
    with pytest.raises(PermissionError, match="Private"):
        provider.write_text("private/meetings/secret.md", "secret", private=True)


def test_webhook_rejects_ipv4_mapped_private_address(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::ffff:169.254.169.254", 443, 0, 0))
        ],
    )
    with pytest.raises(ValueError, match="private/reserved"):
        validate_webhook_url("https://rebind.example/hook")
