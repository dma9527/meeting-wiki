# Meeting Wiki

[English](README.md) | [简体中文](docs/zh-CN/README.md)

Local-first meeting memory for macOS. Meeting Wiki records your meetings and
compiles them into one evolving, plain-Markdown wiki of people, topics,
decisions, and action items, instead of a pile of one-off summaries.

Your files stay readable without the app and work with Obsidian, VS Code, Git,
or any Markdown tool.

## Status

**Early alpha (0.1.x). macOS 14+ on Apple Silicon only.**

There is no signed release yet. Builds are unsigned **local test artifacts**
for the maintainer's own Macs. Do not publish them as a GitHub release or send
them to other people. A public release needs a Developer ID signature,
notarization, and a settled license path for the bundled audio tools. See
[Known limitations](docs/guide/limitations.md).

## Quick start

1. **Build the app** on an Apple Silicon Mac from this repository. See
   [Installation](docs/guide/installation.md).
2. **Open Meeting Wiki** and finish setup: choose Gemini, another
   OpenAI-compatible provider, or Local only, then grant Microphone and Screen &
   System Audio Recording permission. See [Setup](docs/guide/setup.md).
3. **Record.** Choose **Start recording...** (Cmd+Shift+0) in the menu bar,
   pick Shared wiki or Private, and stop when the meeting ends. The meeting
   appears under `~/.meeting-wiki/wiki/` after processing. See
   [Recording](docs/guide/recording.md).

## Capabilities

- Records microphone and system audio, manually or automatically for Zoom and
  Google Meet (both off by default).
- Live sidebar with transcript, translation, and rolling summary while you
  record. Live text is display only.
- Deterministic Markdown wiki: the model returns validated facts, and code
  renders pages, indexes, timelines, and action-item tables.
- Private meetings that never touch shared pages, search, S3, or task
  integrations.
- Searchable canonical memory, URL resources you attach to meetings, a
  read-only MCP server, and an installable Claude skill.
- Durable job queue with self-check, retry, and a processing recovery view.
- Encrypted backup and restore, deletion preview, and retention planning.

## Privacy boundary

- No telemetry. Data lives under `~/.meeting-wiki/` on your Mac.
- Audio and transcript text go only to the provider you select in setup.
  Local only keeps them on the Mac.
- API keys are kept with macOS Keychain facilities, never in `config.toml` or
  logs.
- The MCP server and the wiki window read only `wiki/`, never `private/`.
- You are responsible for recording consent. Read [PRIVACY.md](PRIVACY.md).

## Documentation

| Guide | English | 简体中文 |
|---|---|---|
| Docs index | [docs/README.md](docs/README.md) | [docs/zh-CN/README.md](docs/zh-CN/README.md) |
| Installation | [installation](docs/guide/installation.md) | [安装](docs/zh-CN/guide/installation.md) |
| Setup and API key | [setup](docs/guide/setup.md) | [设置与 API Key](docs/zh-CN/guide/setup.md) |
| Recording | [recording](docs/guide/recording.md) | [录音](docs/zh-CN/guide/recording.md) |
| Live sidebar and recovery | [live-and-recovery](docs/guide/live-and-recovery.md) | [实时侧栏与恢复](docs/zh-CN/guide/live-and-recovery.md) |
| Memory, resources, Claude skill | [memory](docs/guide/memory.md) | [记忆与资源](docs/zh-CN/guide/memory.md) |
| Backup, restore, deletion preview | [data-ownership](docs/guide/data-ownership.md) | [数据归属](docs/zh-CN/guide/data-ownership.md) |
| Known limitations | [limitations](docs/guide/limitations.md) | [已知限制](docs/zh-CN/guide/limitations.md) |
| CLI and configuration | [cli-and-config](docs/reference/cli-and-config.md) | English only |

Also see [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
