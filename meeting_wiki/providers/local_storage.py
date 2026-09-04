"""Local filesystem storage, authoritative in local-first mode."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path, PurePosixPath


class LocalFileStorage:
    name = "local"

    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _path(self, key: str) -> Path:
        normalized = key.replace("\\", "/").lstrip("/")
        candidate = PurePosixPath(normalized)
        if not normalized or ".." in candidate.parts or "\x00" in normalized:
            raise ValueError("Invalid storage key")
        resolved = (self.root / Path(*candidate.parts)).resolve()
        try:
            resolved.relative_to(self.root)
        except ValueError as error:
            raise ValueError("Storage key escapes data directory") from error
        return resolved

    def read_text(self, key: str) -> str | None:
        path = self._path(key)
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8")

    def write_text(self, key: str, content: str, private: bool = False) -> None:
        normalized = key.replace("\\", "/").lstrip("/")
        if private and not normalized.startswith("private/"):
            raise ValueError("Private content must be stored under private/")
        if not private and normalized.startswith("private/"):
            raise ValueError("private/ writes require private=True")
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as handle:
            handle.write(content)
            temp_path = Path(handle.name)
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def list_keys(self, prefix: str = "") -> list[str]:
        base = self._path(prefix) if prefix else self.root
        if not base.exists():
            return []
        files = [base] if base.is_file() else base.rglob("*")
        return sorted(
            str(path.relative_to(self.root)).replace(os.sep, "/")
            for path in files
            if path.is_file()
        )
