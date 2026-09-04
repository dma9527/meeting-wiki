"""Notification and task providers."""

from __future__ import annotations

import ipaddress
import json
import socket
import subprocess
from urllib.parse import urlparse

import httpx

from ..models import ActionItem


class NoopNotificationProvider:
    name = "none"

    def notify(self, title: str, body: str, level: str = "info") -> None:
        return None


class MacOSNotificationProvider:
    name = "macos"

    def notify(self, title: str, body: str, level: str = "info") -> None:
        script = (
            f"display notification {json.dumps(body[:500])} with title {json.dumps(title[:100])}"
        )
        subprocess.run(["osascript", "-e", script], check=False, capture_output=True, timeout=5)


class NoneTaskProvider:
    name = "none"

    def propose(self, item: ActionItem, meeting_key: str) -> str | None:
        return None


def validate_webhook_url(url: str, allow_private_networks: bool = False) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Webhook URL must use https with a hostname")
    if allow_private_networks:
        return
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise ValueError(f"Webhook hostname cannot be resolved: {parsed.hostname}") from error
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ValueError(
                "Webhook resolves to a private/reserved address; opt in explicitly if intended"
            )


class WebhookTaskProvider:
    name = "webhook"

    def __init__(self, url: str, token: str, allow_private_networks: bool = False):
        validate_webhook_url(url, allow_private_networks)
        self.url = url
        self.token = token
        self.allow_private_networks = allow_private_networks

    def propose(self, item: ActionItem, meeting_key: str) -> str | None:
        # Re-resolve immediately before each request to narrow DNS-rebinding
        # time-of-check/time-of-use exposure.
        validate_webhook_url(self.url, self.allow_private_networks)
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        response = httpx.post(
            self.url,
            headers=headers,
            json={"action_item": item.model_dump(mode="json"), "meeting": meeting_key},
            timeout=15,
        )
        response.raise_for_status()
        try:
            result = response.json()
            return str(result.get("url")) if result.get("url") else None
        except (json.JSONDecodeError, ValueError):
            return None
