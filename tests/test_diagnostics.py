from __future__ import annotations

import pytest

from meeting_wiki.diagnostics import (
    SafeProviderError,
    is_rate_limited,
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
