# Native Gemini Provider Design

## Decision

Gemini is a first-class external provider, not an alias for the existing OpenAI-compatible audio provider.

The setup wizard will offer Gemini as the recommended all-in-one external option. It uses one Gemini API key stored through the existing Keychain-backed secret store. It will configure Gemini for batch transcription, live transcription, summary, and translation. OpenAI-compatible language-model support remains available as a separate advanced option. Local-only remains a model-managed alternative.

## Verified API Boundary

Google's official documentation describes native Gemini batch transcription through the Gemini 3.5 Transcribe model, and native Gemini Live transcription through the Gemini 3.5 Transcribe Live model. Live transcription accepts raw 16-bit PCM at 16kHz, mono, and emits interim and finalized transcript events. Gemini also offers OpenAI-compatible language-model calls.

Meeting Wiki must not call the current OpenAI `/audio/transcriptions` adapter for Gemini. The Gemini implementation uses a dedicated provider module and preserves the existing durable batch pipeline. Live events remain display-only and are not written to jobs, wiki Markdown, search, or MCP storage.

## Configuration Shape

```toml
[providers]
transcription = "gemini"
llm = "gemini"
live_transcription = "gemini"
live_language = "gemini"
storage = "local"

[live]
allow_external_providers = true

[gemini]
api_key_env = "MEETING_WIKI_GEMINI_API_KEY"
batch_audio_model = "gemini-3.5-transcribe"
live_model = "gemini-3.5-transcribe-live"
language_model = "[selected Gemini language model]"
```

The API key is not stored in TOML. The setup state records `provider: "gemini"`, and the main process injects only `MEETING_WIKI_GEMINI_API_KEY` into a fresh environment for each Python child process.

## Implementation Sequence

1. Add strict Gemini configuration and provider-selection tests.
2. Verify exact `google-genai` Python SDK signatures before writing the adapter.
3. Add native Gemini batch, language, and live provider adapters with faked-client tests.
4. Construct live providers through `ProviderBundle` and expose their health in `doctor`.
5. Implement the live command and connect it to the authenticated loopback bridge.
6. Replace the generic online setup card with Gemini, OpenAI-compatible, and Local-only provider choices.
7. Implement app-managed local models and portable runtime packaging.
8. Run UX review after the complete flow is present.

## Security Requirements

- Gemini API keys stay in the Keychain-backed secret store and never return through IPC.
- Setup requires an explicit acknowledgement that audio and transcript content are sent to Gemini.
- Live listener remains `127.0.0.1` only, uses a per-session token, and does not expose the token to renderer code.
- Errors redact keys, paths, and transcript text.
