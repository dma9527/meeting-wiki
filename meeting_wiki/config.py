"""Configuration loading. Secrets are referenced by environment variable name."""

from __future__ import annotations

import ipaddress
import os
import re
import tomllib
import unicodedata
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DEFAULT_DATA_DIR = Path.home() / ".meeting-wiki"
DEFAULT_CONFIG_PATH = DEFAULT_DATA_DIR / "config.toml"
LEGACY_LANGUAGE_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9 -]{0,39}$")


def safe_legacy_language(value: str | None, fallback: str | None) -> str | None:
    if value is None or LEGACY_LANGUAGE_PATTERN.fullmatch(value):
        return value
    return fallback


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

    @model_validator(mode="after")
    def restrict_gemini_to_supported_capabilities(self) -> ProviderSelection:
        for field in ("storage", "calendar", "notification", "task"):
            if getattr(self, field) == "gemini":
                raise ValueError(f"providers.{field} does not support gemini")
        return self


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

    @field_validator("translation_target_language")
    @classmethod
    def validate_legacy_translation_language(cls, value: str) -> str:
        return safe_legacy_language(value, "zh") or "zh"

    @model_validator(mode="after")
    def validate_overlap(self) -> LiveConfig:
        if self.overlap_seconds >= self.chunk_seconds:
            raise ValueError("overlap_seconds must be less than chunk_seconds")
        return self


class LanguageConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transcript: Literal["auto", "en", "zh-CN"] = "auto"
    live_translation: Literal["en", "zh-CN"] = "zh-CN"
    live_summary: Literal["en", "zh-CN"] = "zh-CN"
    # "source" keeps generated memory in the language the speakers used, with no translation.
    memory: Literal["source", "en", "zh-CN"] = "source"
    ui: Literal["system", "en", "zh-CN"] = "system"


class OpenAITranscriptionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = "https://api.openai.com/v1"
    model: str = "whisper-1"
    api_key_env: str = "OPENAI_API_KEY"
    timeout_seconds: float = Field(default=600, gt=0, le=1800)


class GeminiConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key_env: str = "MEETING_WIKI_GEMINI_API_KEY"
    batch_audio_model: str = ""
    # interactions: a dedicated transcription model; generate_content: a general model.
    batch_audio_api: Literal["interactions", "generate_content"] = "interactions"
    live_model: str = ""
    language_model: str = ""
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


class RetentionConfig(BaseModel):
    """Planning thresholds only; `retention-plan` reports, it never deletes. None keeps forever."""

    model_config = ConfigDict(extra="forbid")
    audio_days: int | None = Field(default=None, ge=1, le=36500)
    dismissed_jobs_days: int | None = Field(default=None, ge=1, le=36500)
    live_tmp_hours: int | None = Field(default=24, ge=1, le=8760)
    backups_keep: int | None = Field(default=None, ge=1, le=1000)


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


PROFILE_NAME_MAX_LENGTH = 200


def clean_profile_name(value: str, field: str) -> str:
    """Normalize a speaker name and reject control, format, and unassigned characters."""
    cleaned = " ".join(unicodedata.normalize("NFC", value).split())
    if len(cleaned) > PROFILE_NAME_MAX_LENGTH:
        raise ValueError(f"{field} must be at most {PROFILE_NAME_MAX_LENGTH} characters")
    if any(unicodedata.category(char).startswith("C") for char in cleaned):
        raise ValueError(f"{field} must not contain control or invisible characters")
    if cleaned and not any(char.isalnum() for char in cleaned):
        raise ValueError(f"{field} must contain a letter or number")
    return cleaned


class IdentityConfig(BaseModel):
    """The profile that owns this device's microphone channel."""

    model_config = ConfigDict(extra="forbid")
    primary_profile_name: str = ""
    aliases: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("primary_profile_name")
    @classmethod
    def validate_primary_profile_name(cls, value: str) -> str:
        return clean_profile_name(value, "identity.primary_profile_name")

    @field_validator("aliases")
    @classmethod
    def validate_aliases(cls, values: list[str]) -> list[str]:
        cleaned: list[str] = []
        seen: set[str] = set()
        for value in values:
            alias = clean_profile_name(value, "identity.aliases")
            key = alias.casefold()
            if not alias or key in seen:
                raise ValueError("identity.aliases must be unique nonempty names")
            seen.add(key)
            cleaned.append(alias)
        return cleaned


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data_dir: Path = DEFAULT_DATA_DIR
    user_name: str = "User"
    identity: IdentityConfig = Field(default_factory=IdentityConfig)
    language: str | None = None
    providers: ProviderSelection = Field(default_factory=ProviderSelection)
    mlx_whisper: MLXWhisperConfig = Field(default_factory=MLXWhisperConfig)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    live: LiveConfig = Field(default_factory=LiveConfig)
    languages: LanguageConfig = Field(default_factory=LanguageConfig)
    openai_compatible: OpenAICompatibleConfig = Field(default_factory=OpenAICompatibleConfig)
    openai_transcription: OpenAITranscriptionConfig = Field(
        default_factory=OpenAITranscriptionConfig
    )
    gemini: GeminiConfig = Field(default_factory=GeminiConfig)
    s3: S3Config = Field(default_factory=S3Config)
    ics: ICSConfig = Field(default_factory=ICSConfig)
    webhook: WebhookConfig = Field(default_factory=WebhookConfig)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    jobs: JobConfig = Field(default_factory=JobConfig)
    retention: RetentionConfig = Field(default_factory=RetentionConfig)

    @field_validator("language")
    @classmethod
    def validate_legacy_transcript_language(cls, value: str | None) -> str | None:
        return safe_legacy_language(value, None)

    @field_validator("user_name")
    @classmethod
    def validate_user_name(cls, value: str) -> str:
        return clean_profile_name(value, "user_name") or "User"

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
        uses_gemini = "gemini" in {
            self.providers.live_transcription,
            self.providers.live_language,
        }
        if (uses_external_endpoint or uses_gemini) and not self.live.allow_external_providers:
            raise ValueError("live external providers require allow_external_providers = true")
        return self

    @model_validator(mode="after")
    def require_gemini_models(self) -> AppConfig:
        required = {
            "transcription": "batch_audio_model",
            "live_transcription": "live_model",
            "llm": "language_model",
            "live_language": "language_model",
        }
        for capability, model_field in required.items():
            selected = getattr(self.providers, capability) == "gemini"
            if selected and not getattr(self.gemini, model_field).strip():
                raise ValueError(
                    f"providers.{capability} = gemini requires a nonempty gemini.{model_field}"
                )
        return self

    @property
    def transcription_language(self) -> str | None:
        if "transcript" in self.languages.model_fields_set:
            return None if self.languages.transcript == "auto" else self.languages.transcript
        if not self.language or self.language == "auto":
            return None
        return "zh-CN" if self.language in {"zh", "zh-CN"} else self.language

    @property
    def live_translation_language(self) -> str:
        if "live_translation" in self.languages.model_fields_set:
            return self.languages.live_translation
        return (
            "zh-CN"
            if self.live.translation_target_language in {"zh", "zh-CN"}
            else self.live.translation_target_language
        )

    @property
    def live_summary_language(self) -> str:
        return self.languages.live_summary

    @property
    def memory_output_language(self) -> str:
        return self.languages.memory

    @property
    def ui_language(self) -> str:
        return self.languages.ui

    @property
    def primary_profile_name(self) -> str:
        return self.identity.primary_profile_name or self.user_name

    @property
    def primary_profile_aliases(self) -> tuple[str, ...]:
        aliases = [self.primary_profile_name, *self.identity.aliases]
        unique: list[str] = []
        seen: set[str] = set()
        for alias in aliases:
            key = alias.casefold()
            if key not in seen:
                seen.add(key)
                unique.append(alias)
        return tuple(unique)

    def is_primary_profile_alias(self, name: str) -> bool:
        return name.casefold() in {alias.casefold() for alias in self.primary_profile_aliases}

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
