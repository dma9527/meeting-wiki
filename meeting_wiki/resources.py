"""Validation for user-provided URL resources. URLs are stored only; never fetched."""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import parse_qsl, urlsplit, urlunsplit

RESOURCE_RELATIONS = frozenset(
    {"reference", "design_doc", "ticket", "code_review", "notes", "follow_up"}
)
MAX_URL_LENGTH = 2048
MAX_TITLE_LENGTH = 200
MAX_SUMMARY_LENGTH = 2000

_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_TLD = re.compile(r"[a-z]{2,63}|xn--[a-z0-9-]{1,59}")
_SPECIAL_USE_SUFFIXES = (
    "localhost", "local", "internal", "lan", "home.arpa", "test", "invalid", "onion", "intranet",
)
_LOOPBACK_NAMES = frozenset({"localhost"})
# Query names that usually carry bearer secrets or signatures (signed URLs, OAuth codes).
_SECRET_QUERY_NAMES = frozenset(
    {
        "access_token", "api_key", "apikey", "auth", "client_secret", "id_token", "passwd",
        "password", "refresh_token", "secret", "sig", "signature", "token",
        "x-amz-credential", "x-amz-security-token", "x-amz-signature", "x-goog-signature",
    }
)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class ResourceValidationError(ValueError):
    """Raised with a short fixed reason; never echoes the rejected input."""


def _ip_literal(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _is_loopback(host: str, address) -> bool:
    if address is not None:
        mapped = getattr(address, "ipv4_mapped", None)
        return bool(address.is_loopback or (mapped is not None and mapped.is_loopback))
    return host in _LOOPBACK_NAMES


def _check_public_address(address) -> None:
    mapped = getattr(address, "ipv4_mapped", None)
    for candidate in (address, mapped):
        if candidate is None:
            continue
        if (
            candidate.is_private
            or candidate.is_reserved
            or candidate.is_loopback
            or candidate.is_link_local
            or candidate.is_multicast
            or candidate.is_unspecified
            or not candidate.is_global
        ):
            raise ResourceValidationError("private_or_reserved_host")


def _check_hostname(host: str) -> None:
    if len(host) > 253 or host.endswith("."):
        raise ResourceValidationError("invalid_host")
    labels = host.split(".")
    if len(labels) < 2 or not all(_LABEL.fullmatch(label) for label in labels):
        raise ResourceValidationError("invalid_host")
    # Rejects numeric/hex hosts such as 2130706433 or 0x7f.1 that resolvers treat as IPs.
    if not _TLD.fullmatch(labels[-1]):
        raise ResourceValidationError("invalid_host")
    if any(host == suffix or host.endswith(f".{suffix}") for suffix in _SPECIAL_USE_SUFFIXES):
        raise ResourceValidationError("private_or_reserved_host")


def validate_url(raw: object, *, allow_loopback: bool = False) -> str:
    """Return a normalized https URL, or http/https loopback only when explicitly allowed."""
    if not isinstance(raw, str):
        raise ResourceValidationError("invalid_url")
    if not raw or len(raw) > MAX_URL_LENGTH or raw != raw.strip():
        raise ResourceValidationError("invalid_url")
    if not raw.isascii() or _CONTROL.search(raw) or any(ch in raw for ch in " \\<>\"`{}|^"):
        raise ResourceValidationError("invalid_url")
    if "#" in raw:
        raise ResourceValidationError("fragment_not_allowed")
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise ResourceValidationError("invalid_url") from None
    scheme = parts.scheme.lower()
    if scheme not in {"https", "http"}:
        raise ResourceValidationError("unsupported_scheme")
    if "@" in parts.netloc or parts.username is not None or parts.password is not None:
        raise ResourceValidationError("credentials_not_allowed")
    host = (parts.hostname or "").lower()
    if not host:
        raise ResourceValidationError("invalid_host")
    if port == 0:
        raise ResourceValidationError("invalid_url")
    address = _ip_literal(host)
    if _is_loopback(host, address):
        if not allow_loopback:
            raise ResourceValidationError("private_or_reserved_host")
    elif scheme != "https":
        raise ResourceValidationError("https_required")
    elif address is not None:
        _check_public_address(address)
    else:
        _check_hostname(host)
    for name, _value in parse_qsl(parts.query, keep_blank_values=True):
        if name.lower() in _SECRET_QUERY_NAMES:
            raise ResourceValidationError("credentials_not_allowed")
    netloc = f"[{host}]" if address is not None and address.version == 6 else host
    if port is not None:
        netloc = f"{netloc}:{port}"
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))


def validate_text(raw: object, *, field: str, maximum: int, required: bool) -> str:
    """Trim and bound user-entered text; newlines are allowed, other control characters not."""
    if raw is None:
        raw = ""
    if not isinstance(raw, str):
        raise ResourceValidationError(f"invalid_{field}")
    value = raw.replace("\r\n", "\n").strip()
    if (required and not value) or len(value) > maximum:
        raise ResourceValidationError(f"invalid_{field}")
    if _CONTROL.search(value.replace("\n", "")):
        raise ResourceValidationError(f"invalid_{field}")
    if field == "title" and "\n" in value:
        raise ResourceValidationError("invalid_title")
    return value


def validate_relation(raw: object) -> str:
    if not isinstance(raw, str) or raw not in RESOURCE_RELATIONS:
        raise ResourceValidationError("invalid_relation")
    return raw
