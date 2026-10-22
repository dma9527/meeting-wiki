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

## Task delivery outbox

External task creation goes through `data_dir/outbox.db` (mode 0600). Each
action item gets a stable key: a SHA-256 of the meeting source ID and a
canonical form of the owner, action, and due date (whitespace and case
normalized). The flow per action is:

1. The job's delivery plan and every action payload commit in one transaction
   before any network call. A retried job reuses its committed plan, so a
   re-analysis cannot mint new keys for actions already in flight.
2. The row moves to `sending` under a 60-second lease, then the request runs.
3. On success the row becomes `delivered` with the returned `https` URL, if
   any. Delivered actions are never sent again.
4. Timeouts, network errors, and HTTP 408, 425, 429, and 5xx mark the row
   `failed`, and the job retries with backoff. Other 4xx responses mark it
   `rejected` and are not resent.

Every attempt for an action carries the same `Idempotency-Key` header and
`action_id` body field. A webhook receiver must treat a repeated key as the
same task. That is what keeps a timeout after an accepted creation, or a crash
between send and commit, from producing a duplicate. Private meetings and the
`none` task provider never create an outbox.

## Event journal

`data_dir/events.db` (mode 0600) records queue claims, stage transitions,
completions, failures, retries, and task delivery outcomes. Each row holds only
a timestamp, a fixed event code, the component and package version, a job ID,
an attempt count, stage codes, an outcome code, an HTTP status, an exception
type name, and a 12-character digest of the action key. The journal rejects
free text at write time, so titles, transcripts, paths, URLs, error messages,
and secrets cannot be stored. Write failures are ignored so the journal never
blocks processing. Read it with `meeting-wiki events --limit 100`.

## Canonical memory

`data_dir/memory.db` (mode 0600) holds a derived graph of meetings, people,
topics, decisions, action items, and transcript segments with source-backed
edges and an FTS5 index. Every node carries `shared` or `private`. Shared-only
search filters the matched node, every related node, and every cited source
meeting, so a shared result never names private memory. MCP always searches
shared-only.

`meeting-wiki reindex-memory` rebuilds the database from local artifacts in one
transaction. It anchors on `wiki/meetings/*.md` and `private/meetings/*.md`,
reads the matching `analysis` and `transcript-data` record from the same tree,
and skips any artifact reached through a symlink, a shared-tree page that claims
to be private, or a resource outside its own tree. A private copy replaces a
shared copy of the same meeting. It prints counts only and refuses to run with
S3 storage, where shared artifacts are not local.

The desktop Memory Search view calls `meeting-wiki memory-search` through one
`memory:search` IPC channel. Main validates the query and an allowlisted type
filter, passes values as `--flag=value`, and returns a fixed projection.
Private memory is included only when the owner ticks the checkbox for that
search; otherwise main also drops any non-shared item or relation.

## Live sidebar

While recording, the Electron main process spawns `meeting-wiki live` for the
growing microphone WAV. The child binds a WebSocket to `127.0.0.1` on an
ephemeral port, prints only that port, and admits exactly one client that
presents the per-session token passed through its environment. Main is that
client. It re-validates every event and forwards only state, final transcript
lines, translations, and summary points to a sandboxed sidebar whose preload
exposes `subscribe` and `unsubscribe`. Tokens, ports, paths, and keys stay in
main. Errors cross the boundary only as fixed issue codes.

Live output is display-only and never persisted. Stopping, discarding, quitting,
or closing the sidebar ends the live child. Any live failure leaves capture and
the durable batch ingest unchanged.
