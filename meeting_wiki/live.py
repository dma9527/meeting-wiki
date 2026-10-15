"""Privacy-scoped helpers for a display-only local live session."""

from __future__ import annotations

import hmac
import json
import re
from collections.abc import Mapping

from .models import TranscriptSegment


def _normalized_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def deduplicate_segments(
    existing: list[TranscriptSegment], incoming: list[TranscriptSegment]
) -> list[TranscriptSegment]:
    """Return only new final segments while retaining incoming order."""
    seen = {_normalized_text(segment.text) for segment in existing}
    unique: list[TranscriptSegment] = []
    for segment in incoming:
        normalized = _normalized_text(segment.text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(segment)
    return unique


def validate_session_message(message: Mapping[str, object], token: str) -> str:
    supplied = message.get("token")
    event_type = message.get("type")
    if not isinstance(supplied, str) or not hmac.compare_digest(supplied, token):
        raise PermissionError("Live session token is invalid")
    if not isinstance(event_type, str) or not event_type:
        raise ValueError("Live session message type is required")
    return event_type


class LoopbackBridge:
    """Authenticated, single-client live-event bridge bound to loopback only."""

    def __init__(self, token: str):
        self._token = token
        self._connection = None
        self._server = None
        self.port: int | None = None

    async def start(self) -> int:
        from websockets.asyncio.server import serve

        self._server = await serve(self._handle, "127.0.0.1", 0)
        socket = self._server.sockets[0]
        self.port = int(socket.getsockname()[1])
        return self.port

    async def _handle(self, connection) -> None:
        remote = connection.remote_address
        if not remote or remote[0] not in {"127.0.0.1", "::1"}:
            await connection.close(code=1008, reason="loopback required")
            return
        try:
            raw_message = await connection.recv()
            message = json.loads(raw_message)
            if validate_session_message(message, self._token) != "authenticate":
                raise PermissionError("Live session authentication required")
        except (PermissionError, ValueError, TypeError):
            await connection.close(code=1008, reason="authentication required")
            return
        self._connection = connection
        try:
            await connection.wait_closed()
        finally:
            if self._connection is connection:
                self._connection = None

    async def publish(self, event_type: str, payload: Mapping[str, object]) -> bool:
        if self._connection is None:
            return False
        import json

        await self._connection.send(json.dumps({"type": event_type, "payload": payload}))
        return True

    async def close(self) -> None:
        if self._connection is not None:
            await self._connection.close()
            self._connection = None
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
