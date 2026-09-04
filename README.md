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
in progress.

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

## Deterministic wiki

The LLM returns a validated `MeetingAnalysis` object. It never rewrites Markdown
pages. A deterministic renderer owns frontmatter, section order, indexes,
action-item tables, and append-only entity timelines. Reprocessing the same
meeting is idempotent and cannot erase unseen page content.

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

## Development

```bash
./scripts/verify-local.sh

`setup.sh` optionally registers these read-only tools with Kiro and auto-approves
them. This lets agents read the shared `wiki/` without a prompt; `private/` is
structurally inaccessible. Remove the `autoApprove` entries from Kiro settings
if you prefer confirmation for every read.

## Optional S3 mode

S3 is not required. If enabled, use a dedicated private bucket with Block Public
Access, default encryption, versioning, and a least-privilege identity scoped to
the configured prefix. Meeting Wiki requests SSE-S3 for every object and refuses
to mirror any `private/` key. Review retention and deletion policies before use.
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
