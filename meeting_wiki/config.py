"""Configuration loading. Secrets are referenced by environment variable name."""

from __future__ import annotations

import ipaddress
import os
import tomllib
from pathlib import Path
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DEFAULT_DATA_DIR = Path.home() / ".meeting-wiki"
DEFAULT_CONFIG_PATH = DEFAULT_DATA_DIR / "config.toml"


class ProviderSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transcription: str = "mlx_whisper"
    llm: str = "ollama"
    live_transcription: str = "chunked_mlx_whisper"
    live_language: str = "ollama"
    storage: str = "local"
    calendar: str = "none"
    notification: str = "macos"
    task: str = "none"


class MLXWhisperConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = "mlx-community/whisper-small-mlx"
    language: str | None = None


class OpenAICompatibleConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = "http://127.0.0.1:11434/v1"
    model: str = ""
    api_key_env: str = ""
    timeout_seconds: float = Field(default=180, gt=0, le=900)


class OllamaConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = "http://127.0.0.1:11434"
    model: str = "qwen3:8b"
    timeout_seconds: float = Field(default=300, gt=0, le=900)
    num_ctx: int = Field(default=32768, ge=4096, le=262144)


class LiveConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    translation_target_language: str = "zh"
    chunk_seconds: int = Field(default=8, ge=2, le=60)
    overlap_seconds: int = Field(default=2, ge=0, le=20)
    summary_context_characters: int = Field(default=12000, ge=500, le=100000)
    allow_external_providers: bool = False

    @model_validator(mode="after")
    def validate_overlap(self) -> LiveConfig:
        if self.overlap_seconds >= self.chunk_seconds:
            raise ValueError("overlap_seconds must be less than chunk_seconds")
        return self


class OpenAITranscriptionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = "https://api.openai.com/v1"
    model: str = "whisper-1"
    api_key_env: str = "OPENAI_API_KEY"
    timeout_seconds: float = Field(default=600, gt=0, le=1800)


class S3Config(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bucket: str = ""
    prefix: str = "meeting-wiki/"
    region: str = "us-east-1"
    profile: str = "default"


class ICSConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: Path | None = None

    @field_validator("path")
    @classmethod
    def expand_path(cls, value: Path | None) -> Path | None:
        return value.expanduser().resolve() if value else None


class WebhookConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = ""
    token_env: str = ""
    allow_private_networks: bool = False


class PrivacyConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    private_terms: list[str] = Field(
        default_factory=lambda: [
            "1:1",
            "1-1",
            "1/1",
            "one-on-one",
            "one on one",
            "career",
            "skip-level",
            "skip level",
            "manager sync",
            "check-in",
            "catch-up",
        ]
    )
    max_private_attendees: int = Field(default=2, ge=1, le=10)


class JobConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_attempts: int = Field(default=5, ge=1, le=20)
    backoff_base_seconds: int = Field(default=2, ge=1, le=3600)
    visibility_timeout_seconds: int = Field(default=3600, ge=30, le=86400)


def is_loopback_url(value: str) -> bool:
    parsed = urlparse(value)
    hostname = parsed.hostname
    if hostname in {"localhost", "::1"}:
        return True
    if not hostname:
        return False
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data_dir: Path = DEFAULT_DATA_DIR
    user_name: str = "User"
    language: str | None = None
    providers: ProviderSelection = Field(default_factory=ProviderSelection)
    mlx_whisper: MLXWhisperConfig = Field(default_factory=MLXWhisperConfig)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    live: LiveConfig = Field(default_factory=LiveConfig)
    openai_compatible: OpenAICompatibleConfig = Field(default_factory=OpenAICompatibleConfig)
    openai_transcription: OpenAITranscriptionConfig = Field(
        default_factory=OpenAITranscriptionConfig
    )
    s3: S3Config = Field(default_factory=S3Config)
    ics: ICSConfig = Field(default_factory=ICSConfig)
    webhook: WebhookConfig = Field(default_factory=WebhookConfig)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    jobs: JobConfig = Field(default_factory=JobConfig)

    @field_validator("data_dir")
    @classmethod
    def expand_data_dir(cls, value: Path) -> Path:
        return value.expanduser().resolve()

    @model_validator(mode="after")
    def require_live_external_provider_opt_in(self) -> AppConfig:
        uses_external_endpoint = (
            self.providers.live_transcription == "openai_compatible"
            or self.providers.live_language == "openai_compatible"
        ) and not is_loopback_url(self.openai_compatible.base_url)
        if uses_external_endpoint and not self.live.allow_external_providers:
            raise ValueError("live external providers require allow_external_providers = true")
        return self

    def secret(self, env_name: str) -> str:
        if not env_name:
            return ""
        value = os.environ.get(env_name, "")
        if not value:
            raise RuntimeError(f"Required secret environment variable '{env_name}' is not set")
        return value


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> AppConfig:
    """Load TOML. MEETING_WIKI_DATA_DIR and MEETING_WIKI_USER override file values."""
    raw: dict[str, object] = {}
    expanded = path.expanduser()
    if expanded.exists():
        with expanded.open("rb") as handle:
            raw = tomllib.load(handle)
    if os.environ.get("MEETING_WIKI_DATA_DIR"):
        raw["data_dir"] = os.environ["MEETING_WIKI_DATA_DIR"]
    if os.environ.get("MEETING_WIKI_USER"):
        raw["user_name"] = os.environ["MEETING_WIKI_USER"]
    return AppConfig.model_validate(raw)
