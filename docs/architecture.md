# Architecture

## Principles

1. Local files are the default source of truth.
2. Providers are optional adapters, not core dependencies.
3. The LLM emits validated facts, never complete Markdown pages.
4. Rendering is deterministic and idempotent.
5. Private meetings have separate storage and cannot enter shared search.
6. Jobs survive app/worker crashes.

## Flow

1. Electron captures microphone and system audio into a local WAV.
2. The desktop app enqueues an ingest job in SQLite.
3. The worker claims the job under `BEGIN IMMEDIATE`.
4. The configured transcription provider returns a typed transcript.
5. The deterministic privacy classifier selects meeting type and privacy.
6. The configured LLM provider returns `MeetingAnalysis` JSON validated by
   Pydantic.
7. `WikiRenderer` writes a meeting page and append-only entity/topic timelines,
   decisions, actions, and deterministic indexes.
8. Optional task/notification providers run last.
9. MCP exposes read-only search over `wiki/`. It has no private path and no
   write/delete tool.

## Source of truth

In default mode, `~/.meeting-wiki/` contains config, jobs, audio, transcripts,
wiki, private notes, and logs. Markdown is authoritative for knowledge. SQLite
stores job state only.

Optional S3 storage can be selected, but `private/` is hard-blocked and remains
local. No provider receives private data unless it is the explicitly selected
LLM or transcription provider needed to process that meeting.

## Determinism

LLM extraction itself is probabilistic. The deterministic guarantee begins
after `MeetingAnalysis` validates:

- fixed frontmatter key order;
- fixed section order per meeting type;
- stable slugs and source IDs;
- sorted tags and indexes;
- append markers prevent duplicate history entries;
- action-item rows have deterministic keys;
- atomic filesystem replacement;
- one trailing newline.

Reprocessing cannot erase content it did not load because the model never owns
page rendering.

## Provider boundary

Core imports only protocols in `meeting_wiki/providers/base.py`. Vendor SDKs
live inside provider modules. This keeps Ollama, OpenAI-compatible endpoints,
MLX Whisper, S3, ICS, macOS notifications, and webhooks independently
replaceable.

## Durability

The SQLite queue runs in WAL mode with synchronous FULL. Jobs have unique dedupe
keys, exponential backoff, max attempts, and visibility-timeout recovery.
Rendering is idempotent, so at-least-once processing is safe.
