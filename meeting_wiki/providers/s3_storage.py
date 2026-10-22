"""Optional S3 storage provider. Private content is never mirrored.

Shared content is stored as immutable, content-addressed blobs. One revision
manifest maps logical keys to blobs and is replaced with a conditional PUT, so
a reader resolves every key against a single committed revision and never sees
part of a multi-object write.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

RESERVED_PREFIX = "_meeting-wiki/"
MANIFEST_KEY = RESERVED_PREFIX + "manifest.json"
BLOB_PREFIX = RESERVED_PREFIX + "objects/"
MANIFEST_FORMAT = 1
MAX_COMMIT_ATTEMPTS = 5
_CONFLICT_CODES = {"PreconditionFailed", "412", "ConditionalRequestConflict", "409"}
_NOT_MODIFIED_CODES = {"NotModified", "304"}
_MISSING_CODES = {"NoSuchKey", "404", "NotFound"}


class StorageRevisionConflict(RuntimeError):
    """A concurrent revision changed data this revision read; retry the job."""


@dataclass(frozen=True)
class _Manifest:
    etag: str | None
    revision: int
    objects: dict[str, dict[str, Any]]

    def digest(self, key: str) -> str | None:
        entry = self.objects.get(key)
        return entry["sha256"] if entry else None

    def keys_under(self, prefix: str) -> tuple[str, ...]:
        return tuple(sorted(key for key in self.objects if key.startswith(prefix)))


@dataclass
class _Revision:
    base: _Manifest
    staged: dict[str, str] = field(default_factory=dict)
    observed: dict[str, str | None] = field(default_factory=dict)
    listings: dict[str, tuple[str, ...]] = field(default_factory=dict)


def _error_code(error: BaseException) -> str:
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        return str(response.get("Error", {}).get("Code", ""))
    return ""


class S3Storage:
    name = "s3"

    def __init__(
        self,
        bucket: str,
        prefix: str,
        region: str,
        profile: str,
        client: Any | None = None,
    ):
        if not bucket:
            raise ValueError("S3 bucket is required")
        if client is None:
            try:
                import boto3
            except ImportError as error:
                raise RuntimeError("Install meeting-wiki[aws] to use S3 storage") from error
            client = boto3.Session(profile_name=profile).client("s3", region_name=region)
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self.client = client
        self._local = threading.local()
        self._manifest_cache: _Manifest | None = None

    def _logical(self, key: str, allow_empty: bool = False) -> str:
        normalized = key.replace("\\", "/").lstrip("/")
        if normalized.startswith("private/") or "/private/" in normalized:
            raise PermissionError(
                "Private meeting content can never be stored or read via S3 provider"
            )
        if ".." in normalized.split("/") or "\x00" in normalized:
            raise ValueError("Invalid storage key")
        if (not normalized and not allow_empty) or normalized.startswith(RESERVED_PREFIX):
            raise ValueError("Invalid storage key")
        return normalized

    def _key(self, key: str) -> str:
        return self.prefix + self._logical(key, allow_empty=True)

    def _is_missing(self, error: BaseException) -> bool:
        missing = getattr(getattr(self.client, "exceptions", None), "NoSuchKey", None)
        if isinstance(missing, type) and isinstance(error, missing):
            return True
        return _error_code(error) in _MISSING_CODES

    def _active(self) -> _Revision | None:
        return getattr(self._local, "revision", None)

    def _fetch_manifest(self) -> _Manifest:
        request: dict[str, Any] = {"Bucket": self.bucket, "Key": self.prefix + MANIFEST_KEY}
        cached = self._manifest_cache
        if cached is not None and cached.etag:
            request["IfNoneMatch"] = cached.etag
        try:
            response = self.client.get_object(**request)
        except Exception as error:
            if cached is not None and _error_code(error) in _NOT_MODIFIED_CODES:
                return cached
            if self._is_missing(error):
                manifest = _Manifest(etag=None, revision=0, objects={})
                self._manifest_cache = manifest
                return manifest
            raise
        payload = json.loads(response["Body"].read().decode("utf-8"))
        if payload.get("format") != MANIFEST_FORMAT:
            raise RuntimeError("Unsupported S3 revision manifest format")
        objects = payload.get("objects", {})
        for key in objects:
            self._logical(key)
        manifest = _Manifest(
            etag=response.get("ETag"), revision=int(payload["revision"]), objects=objects
        )
        self._manifest_cache = manifest
        return manifest

    def _read_blob(self, key: str, digest: str) -> str:
        try:
            response = self.client.get_object(
                Bucket=self.bucket, Key=self.prefix + BLOB_PREFIX + digest
            )
        except Exception as error:
            if self._is_missing(error):
                raise RuntimeError(f"Committed S3 revision is missing data for {key}") from error
            raise
        data = response["Body"].read()
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError(f"S3 object failed integrity check for {key}")
        return data.decode("utf-8")

    def _read_legacy(self, key: str) -> str | None:
        """Read objects written before revision manifests existed."""
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self.prefix + key)
        except Exception as error:
            if self._is_missing(error):
                return None
            raise
        return response["Body"].read().decode("utf-8")

    def _legacy_keys(self, logical_prefix: str) -> list[str]:
        paginator = self.client.get_paginator("list_objects_v2")
        keys: list[str] = []
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self.prefix + logical_prefix):
            for item in page.get("Contents", []):
                remote = item["Key"]
                logical = remote[len(self.prefix) :] if remote.startswith(self.prefix) else remote
                if not logical.startswith(RESERVED_PREFIX):
                    keys.append(logical)
        return keys

    @contextmanager
    def revision(self) -> Iterator[None]:
        """Stage writes and publish them as one manifest revision on exit."""
        if self._active() is not None:
            yield
            return
        pending = _Revision(base=self._fetch_manifest())
        self._local.revision = pending
        try:
            yield
        finally:
            self._local.revision = None
        self._commit(pending)

    def _commit(self, pending: _Revision) -> None:
        if not pending.staged:
            return
        blobs: dict[str, tuple[str, int]] = {}
        for key, content in pending.staged.items():
            data = content.encode("utf-8")
            digest = hashlib.sha256(data).hexdigest()
            self.client.put_object(
                Bucket=self.bucket,
                Key=self.prefix + BLOB_PREFIX + digest,
                Body=data,
                ContentType="text/markdown",
                ServerSideEncryption="AES256",
            )
            blobs[key] = (digest, len(data))
        base = pending.base
        for _attempt in range(MAX_COMMIT_ATTEMPTS):
            revision = base.revision + 1
            objects = dict(base.objects)
            for key, (digest, size) in blobs.items():
                objects[key] = {"sha256": digest, "size": size, "revision": revision}
            body = json.dumps(
                {
                    "format": MANIFEST_FORMAT,
                    "revision": revision,
                    "committed_at": datetime.now(UTC).isoformat(),
                    "objects": objects,
                },
                sort_keys=True,
            ).encode("utf-8")
            condition = {"IfMatch": base.etag} if base.etag else {"IfNoneMatch": "*"}
            try:
                response = self.client.put_object(
                    Bucket=self.bucket,
                    Key=self.prefix + MANIFEST_KEY,
                    Body=body,
                    ContentType="application/json",
                    ServerSideEncryption="AES256",
                    **condition,
                )
            except Exception as error:
                if _error_code(error) not in _CONFLICT_CODES:
                    raise
                latest = self._fetch_manifest()
                self._ensure_rebase_safe(pending, latest)
                base = latest
                continue
            self._manifest_cache = _Manifest(
                etag=response.get("ETag"), revision=revision, objects=objects
            )
            return
        raise StorageRevisionConflict("S3 revision manifest kept changing; retry later")

    @staticmethod
    def _ensure_rebase_safe(pending: _Revision, latest: _Manifest) -> None:
        for key, digest in pending.observed.items():
            if latest.digest(key) != digest:
                raise StorageRevisionConflict(f"Concurrent S3 revision changed {key}")
        for prefix, keys in pending.listings.items():
            if latest.keys_under(prefix) != keys:
                raise StorageRevisionConflict(f"Concurrent S3 revision changed {prefix}")

    def read_text(self, key: str) -> str | None:
        logical = self._logical(key)
        pending = self._active()
        if pending is not None and logical in pending.staged:
            return pending.staged[logical]
        manifest = pending.base if pending is not None else self._fetch_manifest()
        digest = manifest.digest(logical)
        if pending is not None:
            pending.observed.setdefault(logical, digest)
        if digest is None:
            return self._read_legacy(logical)
        return self._read_blob(logical, digest)

    def write_text(self, key: str, content: str, private: bool = False) -> None:
        if private:
            raise PermissionError("Private meeting content can never be mirrored to S3")
        logical = self._logical(key)
        with self.revision():
            pending = self._active()
            if pending is None:
                raise RuntimeError("S3 revision was not opened")
            pending.staged[logical] = content

    def exists(self, key: str) -> bool:
        logical = self._logical(key)
        pending = self._active()
        if pending is not None and logical in pending.staged:
            return True
        manifest = pending.base if pending is not None else self._fetch_manifest()
        digest = manifest.digest(logical)
        if pending is not None:
            pending.observed.setdefault(logical, digest)
        if digest is not None:
            return True
        try:
            self.client.head_object(Bucket=self.bucket, Key=self.prefix + logical)
            return True
        except Exception:
            return False

    def list_keys(self, prefix: str = "") -> list[str]:
        logical = self._logical(prefix, allow_empty=True)
        pending = self._active()
        manifest = pending.base if pending is not None else self._fetch_manifest()
        committed = manifest.keys_under(logical)
        if pending is not None:
            pending.listings.setdefault(logical, committed)
        keys = set(committed) | set(self._legacy_keys(logical))
        if pending is not None:
            keys |= {key for key in pending.staged if key.startswith(logical)}
        return sorted(keys)
