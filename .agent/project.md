# Project Overview

Meeting Wiki is a local-first macOS meeting recorder that turns recordings into a Markdown wiki and a searchable memory. Local files are the source of truth. Cloud providers are optional adapters.

## Two halves

- Python package `meeting_wiki/`: durable job queue, transcription and analysis through providers, deterministic wiki rendering, memory index, read-only MCP server, CLI (`meeting-wiki`).
- Electron app `desktop/`: tray recorder, audio capture, setup and Settings windows, live sidebar, wiki viewer, Zoom and Google Meet auto-record, packaging.

## Data flow

1. The desktop app captures microphone and system audio into a local WAV and writes `audio/<recording>.capture.json` (title, privacy choice, start time).
2. It enqueues an ingest job in SQLite. Queueing needs no provider credentials. `meeting-wiki recover-captures` queues any manifest left by a crash.
3. The worker claims the job. Before any write it resolves calendar identity and privacy once and freezes it in the job payload (`classification_frozen`). Retries reuse it.
4. The transcription provider returns a typed transcript. The LLM provider returns `MeetingAnalysis` JSON validated by Pydantic.
5. `WikiRenderer` writes pages. The model never writes Markdown directly.
6. Optional task and notification providers run last.
7. MCP exposes read-only search over shared wiki content only.

Default data directory is `~/.meeting-wiki/` (override with `MEETING_WIKI_DATA_DIR`). It holds config, jobs (SQLite, WAL), audio, transcripts, wiki, private notes, and logs. Desktop-only state is in `desktop-settings.json` beside them.

## Layout

| Path | Purpose |
|---|---|
| `meeting_wiki/config.py` | Pydantic config. All config-shape changes start here. |
| `meeting_wiki/providers/` | `base.py` protocols, `registry.py`, and one module per vendor (`gemini.py`, `llm.py`, `transcription.py`, `live.py`, `local_storage.py`, `s3_storage.py`, `calendar.py`, `integrations.py`). |
| `meeting_wiki/engine.py`, `worker.py`, `jobs.py` | Processing, queue, claim ownership, retries. |
| `meeting_wiki/live.py` | Display-only live session (captions, translation, rolling summary). |
| `meeting_wiki/wiki.py`, `memory.py`, `privacy.py` | Rendering, canonical memory, private/shared isolation. |
| `desktop/main.js` | Electron main process. |
| `desktop/managed-config.js` | Strict reader and writer for the TOML that setup generates. |
| `desktop/settings-window.js`, `renderer/settings.js`, `renderer/settings-localization.js` | Settings controller, renderer, zh-CN catalog. |
| `desktop/record-window.js`, `recording-settings.js` | Recording options form and saved defaults. |
| `desktop/auto-record.js`, `zoom-detector.js`, `meet-*.js`, `browser-extension/google-meet/` | Automatic recording. |
| `scripts/` | `verify-local.sh`, `build-macos.sh`, `release-macos.sh`, `public-safety-scan.sh`, runtime preparation. |
| `docs/` and `docs/zh-CN/` | English docs and Chinese guides. Keep guides in sync when behavior changes. |
| `tests/`, `desktop/test/` | Pytest and Node test runner suites. |

## Behavior contracts worth knowing

- Normal Start recording and the global shortcut use saved recording defaults and open no form. Only `Start with options...` shows the form, and it affects that one recording. The meeting title is never saved as a default.
- The first recording requires an explicit privacy choice (private or shared). Nothing is preselected.
- Automatic recordings (Zoom, Google Meet) use the saved auto-record privacy mode. Live features for automatic recordings start after the 10 second short-meeting discard window, and they stay off until recording defaults have been saved.
- Language preferences live in a `[languages]` table: `transcript` (auto, en, zh-CN), `live_translation`, `live_summary`, `memory` (en, zh-CN), `ui` (system, en, zh-CN). The `ui` value only affects the Settings window.
- Memory language changes generated descriptive text only. Titles, topic names, decision titles, people, owners, dates, URLs, and quotes keep their source form so entities do not split.
