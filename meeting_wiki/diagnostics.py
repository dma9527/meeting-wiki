from __future__ import annotations

import re
from collections.abc import Mapping

_SAFE_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,79}\Z")
_SAFE_PROVIDER_STATUS = re.compile(r"[A-Z][A-Z0-9_]{0,63}\Z")


def safe_identifier(value: object, fallback: str = "UnknownError") -> str:
    """Return a bounded identifier without reading untrusted error text."""
    candidate = value if isinstance(value, str) else ""
    return candidate if _SAFE_IDENTIFIER.fullmatch(candidate) else fallback


def _http_status(error: BaseException) -> int | None:
    # google.genai errors expose code; Interactions API errors expose status_code.
    for attribute in ("code", "status_code"):
        value = getattr(error, attribute, None)
        if isinstance(value, int) and not isinstance(value, bool) and 400 <= value <= 599:
            return value
    return None


def safe_provider_metadata(error: BaseException) -> dict[str, object]:
    """Extract only allowlisted metadata from an SDK exception."""
    metadata: dict[str, object] = {"sdk_error_type": safe_identifier(type(error).__name__)}
    status_code = _http_status(error)
    if status_code is not None:
        metadata["http_status"] = status_code
    status = getattr(error, "status", None)
    if isinstance(status, str) and _SAFE_PROVIDER_STATUS.fullmatch(status):
        metadata["provider_status"] = status
    return metadata


class SafeProviderError(RuntimeError):
    """A provider failure that carries no service-provided text or request data."""

    def __init__(self, provider: str, operation: str, error: BaseException):
        self.provider = safe_identifier(provider, "unknown")
        self.operation = safe_identifier(operation, "unknown")
        self.metadata = safe_provider_metadata(error)
        details = [str(self.metadata["sdk_error_type"])]
        if "http_status" in self.metadata:
            details.append(f"HTTP {self.metadata['http_status']}")
        if "provider_status" in self.metadata:
            details.append(str(self.metadata["provider_status"]))
        details_text = ", ".join(details)
        message = f"{self.provider.title()} {self.operation} request failed ({details_text})"
        super().__init__(message)


def safe_job_diagnostic(
    error: BaseException,
    *,
    stage: str,
    attempt: int,
    max_attempts: int,
    provider: str | None,
) -> dict[str, object]:
    """Build a durable diagnostic record without reading exception messages."""
    diagnostic: dict[str, object] = {
        "version": 1,
        "stage": safe_identifier(stage, "unknown"),
        "attempt": max(0, attempt),
        "max_attempts": max(0, max_attempts),
        "category": "internal_error",
        "error_type": safe_identifier(type(error).__name__),
    }
    if isinstance(error, SafeProviderError):
        diagnostic["category"] = "provider_request_failed"
        diagnostic["provider"] = error.provider
        diagnostic["operation"] = error.operation
        diagnostic.update(error.metadata)
    elif provider:
        diagnostic["provider"] = safe_identifier(provider, "unknown")
    return diagnostic


def is_rate_limited(diagnostic: Mapping[str, object]) -> bool:
    """True when a provider refused the request for quota, which clears with time."""
    return (
        diagnostic.get("http_status") == 429
        or diagnostic.get("provider_status") == "RESOURCE_EXHAUSTED"
    )


def encode_diagnostic(diagnostic: Mapping[str, object]) -> str:
    """Serialize only a diagnostic built by safe_job_diagnostic."""
    import json

    return json.dumps(dict(diagnostic), separators=(",", ":"), sort_keys=True)


def decode_diagnostic(value: str | None) -> dict[str, object] | None:
    """Read a current-format safe record, rejecting arbitrary legacy text."""
    if not value:
        return None
    import json

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict) or parsed.get("version") != 1:
        return None
    required = {"version", "stage", "attempt", "max_attempts", "category", "error_type"}
    provider_keys = {"provider", "operation", "sdk_error_type", "http_status", "provider_status"}
    if not required.issubset(parsed) or set(parsed) - required - provider_keys:
        return None
    if parsed.get("category") not in {"internal_error", "provider_request_failed"}:
        return None
    for key in ("stage", "error_type"):
        if safe_identifier(parsed.get(key)) != parsed.get(key):
            return None
    if (
        not isinstance(parsed.get("attempt"), int)
        or isinstance(parsed["attempt"], bool)
        or parsed["attempt"] < 0
        or not isinstance(parsed.get("max_attempts"), int)
        or isinstance(parsed["max_attempts"], bool)
        or parsed["max_attempts"] < 0
    ):
        return None
    if parsed["category"] == "provider_request_failed":
        for key in ("provider", "operation", "sdk_error_type"):
            if safe_identifier(parsed.get(key)) != parsed.get(key):
                return None
        if "http_status" in parsed and (
            not isinstance(parsed["http_status"], int)
            or isinstance(parsed["http_status"], bool)
            or not 400 <= parsed["http_status"] <= 599
        ):
            return None
        if "provider_status" in parsed and (
            not isinstance(parsed["provider_status"], str)
            or not _SAFE_PROVIDER_STATUS.fullmatch(parsed["provider_status"])
        ):
            return None
    elif provider_keys.difference({"provider"}).intersection(parsed) or (
        "provider" in parsed and safe_identifier(parsed.get("provider")) != parsed["provider"]
    ):
        return None
    return parsed
