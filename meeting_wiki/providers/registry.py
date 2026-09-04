"""Provider construction from validated config."""

from __future__ import annotations

from dataclasses import dataclass

from ..config import AppConfig
from .base import (
    CalendarProvider,
    LLMProvider,
    NotificationProvider,
    StorageProvider,
    TaskProvider,
    TranscriptionProvider,
)
from .calendar import ICSCalendarProvider, NoneCalendarProvider
from .integrations import (
    MacOSNotificationProvider,
    NoneTaskProvider,
    NoopNotificationProvider,
    WebhookTaskProvider,
)
from .llm import OllamaProvider, OpenAICompatibleProvider
from .local_storage import LocalFileStorage
from .s3_storage import S3Storage
from .transcription import MLXWhisperTranscriber, OpenAITranscriber, TextImportTranscriber


@dataclass
class ProviderBundle:
    transcription: TranscriptionProvider
    llm: LLMProvider
    storage: StorageProvider
    private_storage: StorageProvider
    calendar: CalendarProvider
    notification: NotificationProvider
    task: TaskProvider


def build_providers(config: AppConfig) -> ProviderBundle:
    if config.providers.transcription == "mlx_whisper":
        transcription = MLXWhisperTranscriber(config.mlx_whisper.model)
    elif config.providers.transcription == "openai_compatible":
        settings = config.openai_transcription
        transcription = OpenAITranscriber(
            settings.base_url,
            settings.model,
            config.secret(settings.api_key_env),
            settings.timeout_seconds,
        )
    elif config.providers.transcription == "text":
        transcription = TextImportTranscriber()
    else:
        raise ValueError(f"Unknown transcription provider: {config.providers.transcription}")

    if config.providers.llm == "ollama":
        llm = OllamaProvider(
            config.ollama.base_url,
            config.ollama.model,
            config.ollama.timeout_seconds,
            config.ollama.num_ctx,
            config.privacy,
        )
    elif config.providers.llm == "openai_compatible":
        settings = config.openai_compatible
        llm = OpenAICompatibleProvider(
            settings.base_url,
            settings.model,
            config.secret(settings.api_key_env),
            settings.timeout_seconds,
            config.privacy,
        )
    else:
        raise ValueError(f"Unknown LLM provider: {config.providers.llm}")

    local_private = LocalFileStorage(config.data_dir)
    if config.providers.storage == "local":
        storage = local_private
    elif config.providers.storage == "s3":
        storage = S3Storage(config.s3.bucket, config.s3.prefix, config.s3.region, config.s3.profile)
    else:
        raise ValueError(f"Unknown storage provider: {config.providers.storage}")

    if config.providers.calendar == "none":
        calendar = NoneCalendarProvider()
    elif config.providers.calendar == "ics":
        calendar = ICSCalendarProvider(config.ics.path)
    else:
        raise ValueError(f"Unknown calendar provider: {config.providers.calendar}")

    if config.providers.notification == "none":
        notification = NoopNotificationProvider()
    elif config.providers.notification == "macos":
        notification = MacOSNotificationProvider()
    else:
        raise ValueError(f"Unknown notification provider: {config.providers.notification}")

    if config.providers.task == "none":
        task = NoneTaskProvider()
    elif config.providers.task == "webhook":
        task = WebhookTaskProvider(
            config.webhook.url,
            config.secret(config.webhook.token_env) if config.webhook.token_env else "",
            config.webhook.allow_private_networks,
        )
    else:
        raise ValueError(f"Unknown task provider: {config.providers.task}")

    return ProviderBundle(
        transcription=transcription,
        llm=llm,
        storage=storage,
        private_storage=local_private,
        calendar=calendar,
        notification=notification,
        task=task,
    )
