from __future__ import annotations

import json
import socket
import urllib.request

import pytest
from test_memory import (
    archive,  # noqa: F401
    make_analysis,
    make_meeting,
    make_transcript,
    memory,
    store_meeting,
    write_config,
)

from meeting_wiki.cli import main
from meeting_wiki.memory import MemoryStore, ResourceError
from meeting_wiki.memory_reindex import reindex_memory
from meeting_wiki.resources import (
    ResourceValidationError,
    validate_relation,
    validate_text,
    validate_url,
)


def meeting_id(ingest_id: str) -> str:
    return MemoryStore._node_id("meeting", ingest_id)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("resources must never touch the network")

    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    monkeypatch.setattr(urllib.request, "urlopen", refuse)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://example.com", "https://example.com/"),
        ("https://Docs.Example.com/a/b?x=1", "https://docs.example.com/a/b?x=1"),
        ("https://example.com:8443/p", "https://example.com:8443/p"),
        ("https://8.8.8.8/x", "https://8.8.8.8/x"),
        ("https://xn--bcher-kva.example/", "https://xn--bcher-kva.example/"),
    ],
)
def test_validate_url_accepts_public_https(raw, expected):
    assert validate_url(raw) == expected


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        ("http://example.com/", "https_required"),
        ("ftp://example.com/", "unsupported_scheme"),
        ("javascript:alert(1)", "unsupported_scheme"),
        ("file:///etc/passwd", "unsupported_scheme"),
        ("https://user:pass@example.com/", "credentials_not_allowed"),
        ("https://user@example.com/", "credentials_not_allowed"),
        ("https://example.com/?access_token=abc", "credentials_not_allowed"),
        ("https://example.com/?X-Amz-Signature=abc", "credentials_not_allowed"),
        ("https://example.com/#section", "fragment_not_allowed"),
        ("https://example.com/#", "fragment_not_allowed"),
        ("https://10.0.0.1/", "private_or_reserved_host"),
        ("https://172.16.0.1/", "private_or_reserved_host"),
        ("https://192.168.1.10/", "private_or_reserved_host"),
        ("https://169.254.169.254/latest", "private_or_reserved_host"),
        ("https://100.64.0.1/", "private_or_reserved_host"),
        ("https://0.0.0.0/", "private_or_reserved_host"),
        ("https://224.0.0.1/", "private_or_reserved_host"),
        ("https://[fe80::1]/", "private_or_reserved_host"),
        ("https://[fc00::1]/", "private_or_reserved_host"),
        ("https://[::ffff:10.0.0.1]/", "private_or_reserved_host"),
        ("https://localhost/", "private_or_reserved_host"),
        ("https://127.0.0.1/", "private_or_reserved_host"),
        ("https://printer.local/", "private_or_reserved_host"),
        ("https://wiki.internal/", "private_or_reserved_host"),
        ("https://router.home.arpa/", "private_or_reserved_host"),
        ("https://intranet/", "invalid_host"),
        ("https://2130706433/", "invalid_host"),
        ("https://0x7f.1/", "invalid_host"),
        ("https://0177.0.0.1/", "invalid_host"),
        ("https://example.com./", "invalid_host"),
        ("https:///path", "invalid_host"),
        ("https://exa mple.com/", "invalid_url"),
        ("https://exämple.com/", "invalid_url"),
        ("https://example.com\\@evil.com/", "invalid_url"),
        (" https://example.com/", "invalid_url"),
        ("https://example.com/\n", "invalid_url"),
        ("https://example.com:0/", "invalid_url"),
        ("https://example.com:99999/", "invalid_url"),
        ("https://example.com/" + "a" * 2048, "invalid_url"),
        ("", "invalid_url"),
        (42, "invalid_url"),
    ],
)
def test_validate_url_rejects_unsafe_targets(raw, reason):
    with pytest.raises(ResourceValidationError) as error:
        validate_url(raw)
    assert str(error.value) == reason
    assert str(raw) not in str(error.value) or not raw


def test_validate_url_allows_loopback_only_on_explicit_opt_in():
    for raw in ("http://localhost:8080/x", "http://127.0.0.1/", "http://[::1]/", "https://[::1]/"):
        with pytest.raises(ResourceValidationError):
            validate_url(raw)
        assert validate_url(raw, allow_loopback=True).startswith(raw.split(":")[0])
    with pytest.raises(ResourceValidationError, match="https_required"):
        validate_url("http://example.com/", allow_loopback=True)
    with pytest.raises(ResourceValidationError, match="private_or_reserved_host"):
        validate_url("https://10.0.0.1/", allow_loopback=True)


def test_validate_text_and_relation():
    assert validate_text("  Spec  ", field="title", maximum=200, required=True) == "Spec"
    summary = validate_text("line\r\nnext", field="summary", maximum=50, required=False)
    assert summary == "line\nnext"
    assert validate_text(None, field="summary", maximum=50, required=False) == ""
    for bad in ("", "   ", "a\nb", "a\x00b", "x" * 201, 5):
        with pytest.raises(ResourceValidationError, match="invalid_title"):
            validate_text(bad, field="title", maximum=200, required=True)
    with pytest.raises(ResourceValidationError, match="invalid_summary"):
        validate_text("bell\x07", field="summary", maximum=50, required=False)
    assert validate_relation("design_doc") == "design_doc"
    with pytest.raises(ResourceValidationError, match="invalid_relation"):
        validate_relation("owns")


def add(store: MemoryStore, meeting: str, url: str = "https://example.com/spec", **overrides):
    values = {
        "meeting_node_id": meeting,
        "url": url,
        "title": "Rollout spec",
        "summary": "Canary plan written by Alex",
        "relation": "design_doc",
        "created_at": "2026-09-06T10:00:00+00:00",
    }
    values.update(overrides)
    return store.add_resource(**values)


def test_resource_attaches_to_shared_meeting_and_survives_reindex(archive, no_network):  # noqa: F811
    data_dir = archive["data_dir"]
    reindex_memory(data_dir)
    store = memory(data_dir)
    shared = meeting_id(archive["shared_id"])
    added = add(store, shared)
    assert added["privacy"] == "shared" and added["relation"] == "design_doc"

    [hit] = store.search("rollout spec", node_types=["resource"])
    assert hit["metadata"] == {"relation": "design_doc", "url": "https://example.com/spec"}
    assert hit["source"]["meeting_key"] == archive["shared_key"]
    assert ("design_doc", "out", "Platform sync") in {
        (item["relation"], item["direction"], item["label"]) for item in hit["relations"]
    }
    [meeting] = store.search("platform sync", node_types=["meeting"])
    assert ("design_doc", "in", "Rollout spec") in {
        (item["relation"], item["direction"], item["label"]) for item in meeting["relations"]
    }

    reindex_memory(data_dir)
    assert store.search("rollout spec", node_types=["resource"])
    assert [item["title"] for item in store.list_resources()] == ["Rollout spec"]
    with pytest.raises(ResourceError, match="resource_exists"):
        add(store, shared)


def test_private_meeting_resources_need_explicit_opt_in(archive, no_network):  # noqa: F811
    data_dir = archive["data_dir"]
    reindex_memory(data_dir)
    store = memory(data_dir)
    private = meeting_id(archive["private_id"])
    with pytest.raises(ResourceError, match="meeting_unavailable"):
        add(store, private)
    with pytest.raises(ResourceError, match="meeting_unavailable"):
        add(store, meeting_id("0" * 16))
    with pytest.raises(ResourceError, match="meeting_unavailable"):
        add(store, "person:0123456789abcdef")
    add(store, private, url="https://example.com/career", title="Career ladder", allow_private=True)

    assert store.search("career ladder") == []
    assert store.list_resources() == []
    assert store.list_resources(meeting_node_id=private) == []
    [hit] = store.search("career ladder", include_private=True)
    assert hit["privacy"] == "private"
    [listed] = store.list_resources(include_private=True)
    assert listed["privacy"] == "private" and listed["orphaned"] is False


def test_resource_becomes_private_when_its_meeting_is_reclassified(archive, no_network):  # noqa: F811
    data_dir = archive["data_dir"]
    reindex_memory(data_dir)
    store = memory(data_dir)
    shared = meeting_id(archive["shared_id"])
    add(store, shared)
    reclassified = make_meeting("Platform sync", 4)
    store_meeting(
        data_dir,
        reclassified,
        make_analysis("Platform sync", "Quokka", "quokka plan", private=True),
        make_transcript(("Alex", "quokka")),
    )
    reindex_memory(data_dir)
    assert store.search("rollout spec") == []
    assert store.list_resources() == []
    assert store.search("rollout spec", include_private=True)[0]["privacy"] == "private"


def test_orphaned_resources_fail_closed(archive, no_network):  # noqa: F811
    data_dir = archive["data_dir"]
    reindex_memory(data_dir)
    store = memory(data_dir)
    add(store, meeting_id(archive["shared_id"]))
    for path in (data_dir / "wiki/meetings").glob("*.md"):
        if path.name != "index.md":
            path.unlink()
    reindex_memory(data_dir)
    assert store.list_resources() == []
    [orphan] = store.list_resources(include_private=True)
    assert orphan["orphaned"] is True and orphan["privacy"] == "private"
    assert store.search("rollout spec", include_private=True) == []


def test_cli_add_and_list_resources(archive, tmp_path, capsys, no_network):  # noqa: F811
    config = write_config(tmp_path, archive["data_dir"])
    assert main(["--config", str(config), "reindex-memory"]) == 0
    capsys.readouterr()
    shared = meeting_id(archive["shared_id"])
    base = ["--config", str(config), "memory-add-resource", f"--meeting={shared}"]
    assert (
        main(
            [
                *base,
                "--url=https://example.com/spec",
                "--title=Rollout spec",
                "--summary=Canary plan",
                "--relation=design_doc",
            ]
        )
        == 0
    )
    output = json.loads(capsys.readouterr().out)
    assert output["added"] is True and output["resource"]["url"] == "https://example.com/spec"

    for url, reason in (
        ("http://example.com/", "https_required"),
        ("https://u:p@example.com/", "credentials_not_allowed"),
        ("https://192.168.0.2/", "private_or_reserved_host"),
        ("https://example.com/#x", "fragment_not_allowed"),
    ):
        assert main([*base, f"--url={url}", "--title=Bad"]) == 1
        printed = capsys.readouterr().out
        assert json.loads(printed) == {"error": reason}
        assert url not in printed
    assert main([*base, "--url=http://localhost:3000/x", "--title=Dev", "--allow-loopback"]) == 0
    capsys.readouterr()
    private = meeting_id(archive["private_id"])
    assert (
        main(
            [
                "--config",
                str(config),
                "memory-add-resource",
                f"--meeting={private}",
                "--url=https://example.com/p",
                "--title=Secret",
            ]
        )
        == 1
    )
    assert json.loads(capsys.readouterr().out) == {"error": "meeting_unavailable"}
    with pytest.raises(SystemExit):
        main([*base, "--url=https://example.com/", "--title=x", "--relation=owns"])
    capsys.readouterr()

    assert main(["--config", str(config), "memory-resources"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert {item["title"] for item in listed["items"]} == {"Rollout spec", "Dev"}
    assert {item["privacy"] for item in listed["items"]} == {"shared"}
    assert main(["--config", str(config), "memory-resources", "--meeting=bogus"]) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "invalid_resource_query"
