# Meeting Wiki Release and Live Sidebar Design

## Goal

Prepare Meeting Wiki for a public macOS alpha that works without Martin's AWS account, lets users select local or external storage and model providers, and includes a secure live translation sidebar during recording.

## Scope

This work delivers four capabilities:

1. Repair all source-level release gates, including dependency audits and release verification.
2. Add a local-first live runtime for incremental transcription, translation, and rolling summaries.
3. Add a sandboxed Electron sidebar that displays live updates during a recording.
4. Validate the signed macOS release path and record any Apple credential gates that cannot be automated.

It does not add telemetry, a public network service, automatic task creation, cloud storage by default, or a new cloud-provider SDK.

## Current Constraints

- Default storage is local Markdown and SQLite beneath `~/.meeting-wiki/`.
- Existing batch providers support MLX Whisper, Ollama, OpenAI-compatible endpoints, local storage, and optional S3.
- The private `meeting-sidecar` implementation is not reusable as-is because it directly depends on AWS Transcribe Streaming, Bedrock, and S3.
- The desktop app records microphone and system audio locally, then starts the existing durable batch pipeline only after capture stops.
- The public app does not currently package a Python runtime. Setup installs a private virtual environment at `~/.meeting-wiki/venv`.

## Architecture

### Live Runtime

A new `meeting-wiki live` Python command will run as a child process of the Electron main process for one recording session. It will:

1. Read only the active local capture files as they grow.
2. Convert new audio into bounded, overlapping chunks.
3. Request incremental transcription from the configured live transcription provider.
4. Deduplicate overlap and publish ordered final transcript segments.
5. Request translation and rolling-summary updates from the configured live LLM provider.
6. Publish privacy-scoped events to the Electron main process over a loopback-only WebSocket.
7. Exit when capture stops, fails, is discarded, or the desktop app exits.

Partial transcript and translation events are display-only. They never enter SQLite jobs, shared Markdown, search indexes, or private/shared knowledge stores. The normal durable batch ingest continues after recording stops and remains the sole source for persistent wiki pages.

### Provider Boundary

The existing batch provider interfaces remain unchanged. The release adds two optional interfaces:

- `LiveTranscriptionProvider` emits incremental transcript segments from audio chunks.
- `LiveLanguageProvider` produces a target-language translation and rolling summary from the accumulated final transcript context.

The default live implementations run locally:

- Chunked MLX Whisper transcription.
- Ollama translation and summary through its loopback endpoint.

OpenAI-compatible endpoints are opt-in through configuration. Selecting one is an explicit user decision to send meeting data to that endpoint. No AWS provider is included in the public default configuration.

The provider registry validates that a selected live provider is compatible with the selected batch provider or has its own explicit endpoint and model configuration. Invalid combinations fail during `meeting-wiki doctor` and before recording begins.

### Sidebar and IPC

The Electron main process owns the live child process and is the only WebSocket client. It generates a random, per-session token, passes it to the live process through inherited environment variables, and connects only to `ws://127.0.0.1:<ephemeral-port>`.

The live process binds only to `127.0.0.1`, rejects missing or invalid session tokens before accepting messages, and sends no filesystem paths, credentials, or private knowledge-store contents. The renderer does not connect directly to the socket and never receives the token.

A new sandboxed sidebar window has a dedicated preload bridge with a narrow subscription API. It receives only:

- connection and processing state;
- final transcript excerpts;
- Chinese translation excerpts;
- rolling summary;
- action-item candidates;
- a user-visible local or external-provider indicator.

It has no generic IPC, filesystem, shell, navigation, popup, or Node access. The existing shared wiki window remains separate and cannot access live events.

### Privacy Rules

A private recording may display its own live transcript, translation, and summary in the private sidebar. It must not load shared wiki context, publish to shared wiki UI, write a persistent live transcript, or call integrations. The app must clearly display that the session is private.

Local audio, tokens, logs, and transient files use owner-only permissions. A discarded recording stops the live process and deletes its capture files through the existing discard path. Live errors redact transcript content and filesystem paths.

### Release Gates

`./scripts/verify-local.sh` becomes the mandatory local release check. It must complete:

- shell syntax;
- Python lint and tests;
- desktop syntax and tests;
- wheel and source-distribution safety checks;
- dependency audit;
- public-source safety scan.

The macOS release script additionally verifies matching desktop and Python versions, code signing, notarization, stapling, DMG checksums, and Gatekeeper assessment. Apple Developer ID and notarization credentials remain external operator gates. A clean-machine manual test is required before a public alpha.

## Alternatives Considered

### Port the AWS Sidecar Directly

This would be fast but violates the release goal because it hardcodes AWS service clients, an S3-backed context store, and Martin's account conventions. Rejected.

### Let the Renderer Connect Directly to a WebSocket

This would simplify the main-process code but exposes session authorization material to web content and broadens the renderer attack surface. Rejected.

### Persist Every Live Event in the Durable Job Queue

The durable queue is designed for final ingest jobs. Persisting partial transcript data would create privacy, retry, and duplicate-content issues without improving the final wiki pipeline. Rejected.

## Acceptance Criteria

1. A fresh local installation can record and show live transcript, Chinese translation, and rolling summary with MLX Whisper and Ollama only.
2. Users can select local defaults or explicitly configure OpenAI-compatible live and batch providers without source changes.
3. The live listener accepts only loopback clients that provide the session token. The renderer cannot access the listener or token directly.
4. Private recordings never expose live content through shared wiki, MCP, persistent live files, task providers, or shared context.
5. The complete local verification script succeeds with zero known dependency vulnerabilities.
6. The signed release script either succeeds or reports only the documented Apple certificate and notarization prerequisites.
7. A UX review verifies recording, sidebar, private-session, provider-choice, error, and recovery flows before release.
