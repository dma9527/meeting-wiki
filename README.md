# Meeting Wiki

A local-first meeting memory system that turns conversations into an evolving,
plain-Markdown knowledge base.

Unlike tools that produce one isolated summary per call, Meeting Wiki maintains
people, topics, decisions, action items, and meeting history across time. Your
files stay readable without the app and work with Obsidian, VS Code, Git, or any
Markdown tool.

## Status

Early alpha. macOS is the first supported desktop platform. The local pipeline
and MCP server are functional; release signing and wider hardware testing are
in progress. Local builds are not public release artifacts. See the
[signed macOS release runbook](docs/releasing-macos.md) for Developer ID,
notarization, Gatekeeper verification, and public alpha gates.

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

## Quick start

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

Wiki output appears under `~/.meeting-wiki/wiki/`. Private one-on-ones are
stored under `~/.meeting-wiki/private/` and are not visible through MCP.

## Provider configuration

Edit `~/.meeting-wiki/config.toml`:

| Capability | Providers |
|---|---|
| Transcription | `mlx_whisper`, `openai_compatible`, `text` |
| LLM | `ollama`, `openai_compatible` |
| Storage | `local`, `s3` |
| Calendar | `none`, `ics` |
| Notification | `macos`, `none` |
| Tasks | `none`, `webhook` |

Secrets are referenced by environment-variable name and never stored in TOML.
Local providers need no account or API key.

## ASR benchmarking

Use the [privacy-safe ASR benchmark harness](benchmarks/asr/README.md) to compare
transcription providers with synthetic, openly licensed, or local consented
audio. Default outputs contain aggregate metrics only and exclude paths,
transcripts, predictions, speaker names, and case identifiers.

## Deterministic wiki

The LLM returns a validated `MeetingAnalysis` object. It never rewrites Markdown
pages. A deterministic renderer owns frontmatter, section order, indexes,
action-item tables, and append-only entity timelines. Reprocessing the same
meeting is idempotent and cannot erase unseen page content.

## Pre-meeting briefs

Compile a privacy-safe brief for each upcoming calendar event from the wiki you
already have, with no LLM call and no network beyond reading the local ICS file:

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

Decision pages carry a `status` (accepted by default), a stable `decision_id`,
their source meeting, an effective timestamp, and `superseded_by`. A decision may
explicitly supersede another by exact `decision_id` or page path. Supersession is
idempotent and refuses to cross the private/shared boundary; decision titles are
never fuzzy-matched. Decision pages written before this existed read as accepted.

Action items carry forward by exact canonical owner and action identity, with no
fuzzy matching. The most recent meeting wins, so a later `done` closes an action
and a later reappearance reopens it. Open items live in
`wiki/action-items/active.md` and completed ones in `wiki/action-items/archive.md`.

## Private meetings

Use `--private` or mark the next desktop recording private. Private meetings:

- write only to `private/`;
- do not update shared people, topics, decisions, actions, indexes, or logs;
- are never mirrored to S3;
- are never returned by MCP;
- do not trigger task providers.

See [PRIVACY.md](PRIVACY.md) before recording other people. Recording consent
requirements vary by jurisdiction and organization.

## MCP

```bash
meeting-wiki-mcp
```

Read-only tools:

- `meeting_wiki_search`
- `meeting_wiki_read_page`
- `meeting_wiki_list_recent`
- `meeting_wiki_action_items`

## Desktop wiki and correction inbox

The menubar item "Open Wiki & Corrections" opens a local window for browsing the
shared wiki: recent meetings, full-text search, exact page reads, and open action
items. The window loads no remote content, runs with context isolation and a
sandboxed renderer, and reaches the main process only through a narrow preload
bridge. That bridge reads `data_dir/wiki` and nothing else; path containment
rejects `../`, absolute paths, null bytes, and symlinks that escape the tree, so
`private/` is unreachable from the window.

The correction inbox lists shared meetings whose transcript still uses an
ambiguous speaker label such as `Remote participant` or `spk_1`. Candidates are
derived only from shared `transcript-data` and `analysis` records; the private
tree is never read and transcript text never reaches the window. You rename a
speaker, preview a plan, then reprocess. Reprocessing re-enqueues the meeting's
original ingest job with an exact OLD=NEW mapping.

Correction is a review-before-reprocess flow because a rename cannot cleanly
update every wiki surface. The per-meeting page is rewritten, but the
deterministic renderer never deletes content it did not load, and re-analysis is
non-deterministic. So the old label is kept on append-only surfaces (people
timelines, the action-item table). The plan states exactly which entries remain
and the window shows this limitation before you confirm, rather than silently
corrupting the wiki. The same actions are available from the CLI:

```bash
meeting-wiki correct-inbox
meeting-wiki correct --meeting wiki/meetings/<page>.md --speaker "Remote participant=Sam Rivera"
meeting-wiki correct --meeting wiki/meetings/<page>.md --speaker "Remote participant=Sam Rivera" --reprocess
```

Without `--reprocess`, `correct` prints the plan and enqueues nothing.

## Processing status and recovery

The menubar shows whether meetings are processing or need attention. It also
provides system health checks, local logs, and a one-click retry for dead jobs.
The same privacy-safe controls are available from the CLI:

```bash
meeting-wiki status --summary
meeting-wiki status --state dead
meeting-wiki retry 12
```

Default status output never includes meeting titles, source paths, transcripts,
or provider error details. Use `status --verbose` only when inspecting your own
private machine.

## Development

```bash
./scripts/verify-local.sh
```

`setup.sh` optionally registers these read-only tools with Kiro and auto-approves
them. This lets agents read the shared `wiki/` without a prompt; `private/` is
structurally inaccessible. Remove the `autoApprove` entries from Kiro settings
if you prefer confirmation for every read.

## Optional S3 mode

S3 is not required. If enabled, use a dedicated private bucket with Block Public
Access, default encryption, versioning, and a least-privilege identity scoped to
the configured prefix. Meeting Wiki requests SSE-S3 for every object and refuses
to mirror any `private/` key. Review retention and deletion policies before use.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
