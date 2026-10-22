# CLI and Configuration Reference

[Docs index](../README.md)

This page holds the detailed command-line and configuration material that used
to live in the root README. It is English only.

## Contents

- [Default architecture](#default-architecture)
- [CLI quick start](#cli-quick-start)
- [Provider configuration](#provider-configuration)
- [Deterministic wiki](#deterministic-wiki)
- [Pre-meeting briefs](#pre-meeting-briefs)
- [Decision lifecycle and action carry-over](#decision-lifecycle-and-action-carry-over)
- [Optional S3 mode](#optional-s3-mode)
- [ASR benchmarking](#asr-benchmarking)
- [Development](#development)

## Default architecture

- Capture: microphone plus macOS system audio.
- Transcription: MLX Whisper on Apple Silicon.
- Analysis: Ollama on localhost.
- Storage: local Markdown under `~/.meeting-wiki/`.
- Queue: durable SQLite jobs with crash recovery.
- Search: local read-only MCP server.
- Calendar, cloud storage, notifications, and task integrations are providers,
  not hard dependencies.
- Telemetry: none.

See [architecture.md](../architecture.md).

## CLI quick start

Prerequisites: macOS 14+, Apple Silicon, Python 3.11+, Node.js 20+, SoX,
Ollama, and an Ollama model.

```bash
brew install node python@3.12 sox ollama
ollama serve
ollama pull qwen3:8b

./scripts/setup.sh
meeting-wiki doctor

# Import an existing transcript, no ASR model needed.
meeting-wiki ingest --transcript sample.txt --title "Design review" --now

# Audio path, uses the configured transcription provider.
meeting-wiki ingest --audio meeting.wav --title "Weekly standup"
meeting-wiki worker
```

Use `--private` on `ingest` for a private meeting. Wiki output appears under
`~/.meeting-wiki/wiki/`. Private meetings are stored under
`~/.meeting-wiki/private/` and are not visible through MCP.

## Provider configuration

Edit `~/.meeting-wiki/config.toml` (see `config.example.toml`):

| Capability | Providers |
|---|---|
| Transcription | `mlx_whisper`, `openai_compatible`, `text` |
| LLM | `ollama`, `openai_compatible` |
| Storage | `local`, `s3` |
| Calendar | `none`, `ics` |
| Notification | `macos`, `none` |
| Tasks | `none`, `webhook` |

Secrets are referenced by environment-variable name and never stored in TOML.
Local providers need no account or API key. The desktop setup wizard writes
this file for you; see [Setup](../guide/setup.md).

## Deterministic wiki

The LLM returns a validated `MeetingAnalysis` object. It never rewrites
Markdown pages. A deterministic renderer owns frontmatter, section order,
indexes, action-item tables, and append-only entity timelines. Reprocessing the
same meeting is idempotent and cannot erase unseen page content.

## Pre-meeting briefs

Compile a privacy-safe brief for each upcoming calendar event from the wiki you
already have, with no LLM call and no network beyond reading the local ICS
file:

```bash
meeting-wiki brief --within 120
```

A shared event's brief reads only `wiki/` (participant history, matching open
action items, recent related meetings, open questions) plus the event's own
agenda, and is written to `wiki/briefs/`. A private or one-on-one event gets a
no-history brief built only from the event's own details, written to
`private/briefs/`; it reads no shared content. Briefs are deterministic and
idempotent: rerunning overwrites with identical bytes.

## Decision lifecycle and action carry-over

Decision pages carry a `status` (accepted by default), a stable
`decision_id`, their source meeting, an effective timestamp, and
`superseded_by`. A decision may explicitly supersede another by exact
`decision_id` or page path. Supersession is idempotent and refuses to cross the
private/shared boundary; decision titles are never fuzzy-matched. Decision
pages written before this existed read as accepted.

Action items carry forward by exact canonical owner and action identity, with
no fuzzy matching. The most recent meeting wins, so a later `done` closes an
action and a later reappearance reopens it. Open items live in
`wiki/action-items/active.md` and completed ones in
`wiki/action-items/archive.md`.

## Optional S3 mode

S3 is not required. If enabled, use a dedicated private bucket with Block
Public Access, default encryption, versioning, and a least-privilege identity
scoped to the configured prefix. Meeting Wiki requests SSE-S3 for every object
and refuses to mirror any `private/` key. Review retention and deletion
policies before use.

Shared S3 content is written as immutable, SHA-256-addressed objects under
`<prefix>/_meeting-wiki/objects/`. A single revision manifest at
`<prefix>/_meeting-wiki/manifest.json` maps wiki keys to those objects and is
replaced with a conditional PUT (`If-Match` / `If-None-Match`). A meeting's
transcript, analysis, and every wiki page it updates become visible together,
or not at all. If another writer changed a page the current job read, the job
fails with a conflict and can be retried instead of overwriting newer content.
Grant the identity `s3:GetObject`, `s3:PutObject`, and `s3:ListBucket` on the
prefix. Objects written before manifests existed stay readable until replaced.

## ASR benchmarking

Use the [privacy-safe ASR benchmark harness](../../benchmarks/asr/README.md) to
compare transcription providers with synthetic, openly licensed, or local
consented audio. Default outputs contain aggregate metrics only and exclude
paths, transcripts, predictions, speaker names, and case identifiers.

## Development

```bash
./scripts/verify-local.sh
```

`setup.sh` optionally registers the read-only MCP tools with Kiro and
auto-approves them. This lets agents read the shared `wiki/` without a prompt;
`private/` is structurally inaccessible. Remove the `autoApprove` entries from
Kiro settings if you prefer confirmation for every read.

See [CONTRIBUTING.md](../../CONTRIBUTING.md).
