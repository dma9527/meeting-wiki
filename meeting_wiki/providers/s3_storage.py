"""Optional S3 storage provider. Private content is never mirrored."""

from __future__ import annotations


class S3Storage:
    name = "s3"

    def __init__(self, bucket: str, prefix: str, region: str, profile: str):
        if not bucket:
            raise ValueError("S3 bucket is required")
        try:
            import boto3
        except ImportError as error:
            raise RuntimeError("Install meeting-wiki[aws] to use S3 storage") from error
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self.client = boto3.Session(profile_name=profile).client("s3", region_name=region)

    def _key(self, key: str) -> str:
        normalized = key.replace("\\", "/").lstrip("/")
        if normalized.startswith("private/") or "/private/" in normalized:
            raise PermissionError(
                "Private meeting content can never be stored or read via S3 provider"
            )
        if ".." in normalized.split("/") or "\x00" in normalized:
            raise ValueError("Invalid storage key")
        return self.prefix + normalized

    def read_text(self, key: str) -> str | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self._key(key))
            return response["Body"].read().decode("utf-8")
        except self.client.exceptions.NoSuchKey:
            return None

    def write_text(self, key: str, content: str, private: bool = False) -> None:
        if private:
            raise PermissionError("Private meeting content can never be mirrored to S3")
        self.client.put_object(
            Bucket=self.bucket,
            Key=self._key(key),
            Body=content.encode("utf-8"),
            ContentType="text/markdown",
            ServerSideEncryption="AES256",
        )

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(key))
            return True
        except Exception:
            return False

    def list_keys(self, prefix: str = "") -> list[str]:
        remote_prefix = self._key(prefix)
        paginator = self.client.get_paginator("list_objects_v2")
        keys: list[str] = []
        for page in paginator.paginate(Bucket=self.bucket, Prefix=remote_prefix):
            for item in page.get("Contents", []):
                remote = item["Key"]
                keys.append(
                    remote[len(self.prefix) :] if remote.startswith(self.prefix) else remote
                )
        return sorted(keys)
