from __future__ import annotations

import pytest

from meeting_wiki.diagnostics import (
    SafeProviderError,
    decode_diagnostic,
    encode_diagnostic,
    failure_kind,
    is_rate_limited,
    provider_errors,
    safe_job_diagnostic,
    safe_provider_metadata,
)


class GenaiStyleError(Exception):
    def __init__(self, code, status=None):
        super().__init__("secret transcript text")
        self.code = code
        self.status = status


class InteractionsStyleError(Exception):
    def __init__(self, status_code):
        super().__init__("secret transcript text")
        self.status_code = status_code


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            GenaiStyleError(429, "RESOURCE_EXHAUSTED"),
            {"http_status": 429, "provider_status": "RESOURCE_EXHAUSTED"},
        ),
        (InteractionsStyleError(400), {"http_status": 400}),
        (InteractionsStyleError(True), {}),
        (InteractionsStyleError(200), {}),
        (GenaiStyleError(None, "lowercase status"), {}),
    ],
)
def test_provider_metadata_reads_only_structured_status_fields(error, expected):
    metadata = safe_provider_metadata(error)

    assert metadata == {"sdk_error_type": type(error).__name__, **expected}
    assert "secret" not in str(metadata)


@pytest.mark.parametrize(
    ("error", "limited"),
    [
        (InteractionsStyleError(429), True),
        (GenaiStyleError(None, "RESOURCE_EXHAUSTED"), True),
        (InteractionsStyleError(400), False),
        (GenaiStyleError(503, "UNAVAILABLE"), False),
    ],
)
def test_rate_limit_is_recognized_from_the_job_diagnostic(error, limited):
    diagnostic = safe_job_diagnostic(
        SafeProviderError("gemini", "transcription", error),
        stage="transcribing",
        attempt=1,
        max_attempts=5,
        provider="gemini",
    )

    assert is_rate_limited(diagnostic) is limited


def _http_status_error(status, body):
    import httpx

    request = httpx.Request("POST", "https://provider.example.test/v1/chat/completions")
    response = httpx.Response(status, json=body, request=request)
    return httpx.HTTPStatusError("secret transcript text", request=request, response=response)


@pytest.mark.parametrize(
    ("metadata", "kind"),
    [
        ({"http_status": 402, "provider_status": "RESOURCE_EXHAUSTED"}, "billing"),
        ({"http_status": 402}, "billing"),
        ({"http_status": 429, "provider_code": "insufficient_quota"}, "billing"),
        ({"http_status": 429, "provider_code": "rate_limit_exceeded"}, "rate_limited"),
        ({"provider_status": "RESOURCE_EXHAUSTED"}, "rate_limited"),
        ({"http_status": 401}, "auth"),
        ({"http_status": 403}, "auth"),
        ({"http_status": 400}, "bad_request"),
        ({"http_status": 503}, "server"),
        ({}, "network"),
    ],
)
def test_provider_failures_map_to_one_kind_for_every_provider(metadata, kind):
    assert failure_kind(metadata) == kind


def test_an_openai_style_http_error_keeps_status_and_code_but_never_the_message():
    error = _http_status_error(
        429,
        {
            "error": {
                "message": "secret quota text",
                "type": "insufficient_quota",
                "code": "insufficient_quota",
            }
        },
    )

    metadata = safe_provider_metadata(error)

    assert metadata == {
        "sdk_error_type": "HTTPStatusError",
        "http_status": 429,
        "provider_code": "insufficient_quota",
    }
    assert failure_kind(metadata) == "billing"


@pytest.mark.parametrize("body", [{"error": {"code": "Has Spaces"}}, {"code": 12}, ["x"], None])
def test_unsafe_or_missing_error_codes_are_dropped(body):
    import httpx

    request = httpx.Request("GET", "https://provider.example.test")
    response = (
        httpx.Response(402, json=body, request=request)
        if body is not None
        else httpx.Response(402, content=b"not json", request=request)
    )
    error = httpx.HTTPStatusError("secret", request=request, response=response)

    assert safe_provider_metadata(error) == {
        "sdk_error_type": "HTTPStatusError",
        "http_status": 402,
    }


def test_provider_errors_wraps_http_and_network_failures_only():
    import httpx

    with (
        pytest.raises(SafeProviderError) as raised,
        provider_errors("openai_compatible", "analysis"),
    ):
        raise _http_status_error(402, {"error": {"code": "insufficient_balance"}})
    assert raised.value.metadata["http_status"] == 402
    assert "secret" not in str(raised.value)

    with (
        pytest.raises(SafeProviderError) as network,
        provider_errors("openai_compatible", "transcription"),
    ):
        raise httpx.ConnectError("secret host")
    assert failure_kind(network.value.metadata) == "network"

    with pytest.raises(ValueError), provider_errors("openai_compatible", "analysis"):
        raise ValueError("not a provider error")


def test_job_diagnostics_record_the_failure_kind_and_round_trip():
    diagnostic = safe_job_diagnostic(
        SafeProviderError("gemini", "transcription", GenaiStyleError(402, "RESOURCE_EXHAUSTED")),
        stage="transcribing",
        attempt=1,
        max_attempts=5,
        provider="gemini",
    )

    assert diagnostic["failure_kind"] == "billing"
    assert is_rate_limited(diagnostic) is False
    assert decode_diagnostic(encode_diagnostic(diagnostic)) == diagnostic
    assert decode_diagnostic(encode_diagnostic({**diagnostic, "failure_kind": "made_up"})) is None
