# Online-Primary Portable Product Decision

## Status

Approved on 2026-10-15. This decision updates `2026-10-14-release-live-sidebar-design.md` and its implementation plan where they state that local models are the default.

## Product Default

Meeting Wiki remains local-storage-first. Audio, SQLite jobs, Markdown wiki data, private meetings, and MCP cache stay on the user's Mac by default.

The recommended first-run model path is online API key configuration:

1. The user selects an OpenAI-compatible transcription and language provider.
2. The app stores API key references in the macOS Keychain, never in `config.toml`, logs, or renderer state.
3. The app explains that audio and transcript content will be sent to the selected provider before enabling recording.
4. The live sidebar labels the session as `External provider` and identifies the configured provider.

Local models remain a complete alternative:

1. The user selects Local only during first-run setup.
2. The app installs or manages the local runtime and downloads selected ASR and language models.
3. The live sidebar labels the session as `Local only`.
4. Local mode does not require an API key or network connection after models are available.

## Portable Install Shape

A signed DMG must install a self-contained macOS app that includes Electron, the app-owned Python runtime, Meeting Wiki Python dependencies, worker, and capture dependencies. It must not require a source checkout, Node.js, Homebrew, or a virtual environment created by a shell script.

The first-run wizard owns configuration. It asks for storage location, model path, API key when external mode is chosen, recording permissions, and a configuration test. It may offer optional local-model downloads after the user chooses local mode.

Models are not embedded in the base DMG because their size and license terms vary. They are downloaded only after the user selects a model and sees the source, size, and storage location.

## Acceptance Criteria

1. A user can install the signed DMG, complete first-run setup, add an online API key, and record with live transcription, Chinese translation, summary, and persistent local wiki data without a terminal.
2. A user can instead select local-only mode and complete the same workflow after app-managed model installation.
3. API keys remain in Keychain and never enter TOML, application logs, crash reports, renderer IPC, source distributions, or GitHub Actions output.
4. Switching providers requires a successful health check and explicit acknowledgement of data egress when switching to an external endpoint.
5. The app continues to bind all live-session transport to loopback only, with a unique session token withheld from renderers.
