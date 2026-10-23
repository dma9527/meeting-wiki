<div align="center">

# Meeting Wiki

**Your meetings become private, source-linked memory that you and your agents can use.**

[![CI](https://github.com/dma9527/meeting-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/dma9527/meeting-wiki/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2014.2%2B%20Apple%20Silicon-black.svg)](docs/guide/installation.md)
[![Memory](https://img.shields.io/badge/memory-local--first-2f6f5f.svg)](docs/guide/memory.md)
[![MCP](https://img.shields.io/badge/MCP-read--only-6d4c9b.svg)](docs/guide/memory.md)

[English](README.md) | [简体中文](docs/zh-CN/README.md)

</div>

> **Early alpha.** Meeting Wiki is for technically comfortable Apple Silicon Mac users who want to test a local-first meeting memory workflow. It does not yet have a signed public release. See [known limitations](docs/guide/limitations.md).

## The problem

Most meeting tools give you a transcript and a one-time summary. A few weeks
later, you still have to remember where a decision came from, who committed to
an action, or which design document changed the plan.

Meeting Wiki keeps the source material on your Mac and turns each processed
meeting into an evolving knowledge system of meetings, people, topics,
decisions, action items, links, and transcript lines.

```text
Join a meeting
  Record microphone and system audio
  Live captions, translation, and rolling summary
  Durable batch transcript and analysis
  Source-linked Markdown wiki and local memory index
  Search from the app, CLI, MCP, or Claude skill
```

## Why Meeting Wiki

| What you get | Why it matters |
|---|---|
| **Local-first ownership** | Audio, transcripts, Markdown, memory, jobs, backups, and integration state live under `~/.meeting-wiki/`. |
| **Memory with sources** | Decisions, action items, people, topics, URL resources, and transcript segments point back to the meeting that created them. |
| **No meeting bot by default** | Capture happens on your Mac. Zoom and Google Meet automatic recording are opt-in integrations. |
| **Agent-ready, not agent-dependent** | A read-only MCP server and an installable Claude skill let agents query memory without direct file writes. |
| **Private by design** | Private meetings never enter shared wiki pages, shared MCP search, S3 mirroring, or task integrations. |
| **Recoverable workflow** | Queue recovery, processing controls, task outbox idempotency, event journal, backup, restore verification, and deletion preview are built in. |

## What it does today

- Records microphone and system audio from the macOS menu bar.
- Shows recording options on first use and for one-record overrides, including title, privacy, capture readiness, live status, and time limit.
- Runs a live sidebar with transcript, translation, and rolling summary while recording.
- Renews Gemini Live sessions before the provider connection limit when supported.
- Stops, saves, and processes recordings when an opt-in Zoom or Google Meet integration detects a meeting end.
- Discards integration-started recordings of 10 seconds or less.
- Builds deterministic Markdown pages for meetings, people, topics, decisions, and action items.
- Indexes canonical local memory with full-text search and relationship results.
- Stores user-attached URL resources without fetching or opening them.
- Creates encrypted backups, verifies restores into a new directory, and previews deletion or retention effects without deleting data.

## Start here

### 1. Install or build

Meeting Wiki currently has unsigned local test artifacts only. Build it on your
own Apple Silicon Mac, or copy a build you made to another Mac you own and
follow the install guide.

```text
Apple Silicon Mac
macOS 14.2 or later
Microphone permission
Screen & System Audio Recording permission
```

[Installation guide](docs/guide/installation.md)

### 2. Set up processing

Open **Run setup...** from the menu bar. Choose Gemini or another
OpenAI-compatible provider, paste or reveal a key only when needed, run the
candidate test, then finish. The active provider remains unchanged if a
candidate test fails.

[Setup and API key guide](docs/guide/setup.md)

### 3. Record one short meeting

The first time, choose **Start recording** or press `Cmd+Shift+0`, select the
privacy and live defaults, then start. Later normal starts use those saved
defaults immediately. Choose **Start with options...** for a one-record title,
privacy, or live override. When you stop, Meeting Wiki saves the recording,
queues durable processing, and writes the result to your local wiki.

[Recording guide](docs/guide/recording.md)

## Pick a workflow

| I want to... | Start here |
|---|---|
| Record a private one-on-one | [Private recording](docs/guide/recording.md#private-meetings) |
| Automatically record Zoom or Google Meet | [Automatic recording](docs/guide/recording.md#automatic-recording) |
| Understand why processing failed | [Live sidebar and recovery](docs/guide/live-and-recovery.md) |
| Search past decisions, people, or action items | [Memory search](docs/guide/memory.md) |
| Attach a design doc or ticket to a meeting | [URL resources](docs/guide/memory.md#url-resources) |
| Let Claude query meeting memory safely | [Claude skill and MCP](docs/guide/memory.md#claude-skill-and-mcp) |
| Back up or restore local data | [Data ownership](docs/guide/data-ownership.md) |
| Review release and platform limitations | [Known limitations](docs/guide/limitations.md) |

## Privacy boundary

- No telemetry.
- API keys are encrypted with Electron safeStorage into `secrets.json` (0600) in the
  storage folder, with the decryption key in the macOS Keychain. They are not written to
  `config.toml` or logs.
- Audio and transcript text go only to the provider selected in setup. A manually configured local provider keeps those inputs on the Mac; Local only setup is not available in this build.
- Shared MCP and wiki browsing do not read `private/`.
- URL resources are stored locally and are never fetched automatically.
- Automatic recording is off by default. You are responsible for giving any required recording notice and obtaining consent.

Read the full [privacy policy](PRIVACY.md) before recording other people.

## Documentation

| Topic | English | 简体中文 |
|---|---|---|
| Documentation index | [Docs](docs/README.md) | [中文文档](docs/zh-CN/README.md) |
| Installation | [Installation](docs/guide/installation.md) | [安装](docs/zh-CN/guide/installation.md) |
| Setup and API key | [Setup](docs/guide/setup.md) | [设置与 API Key](docs/zh-CN/guide/setup.md) |
| Recording | [Recording](docs/guide/recording.md) | [录音](docs/zh-CN/guide/recording.md) |
| Live and recovery | [Live sidebar and recovery](docs/guide/live-and-recovery.md) | [实时侧栏与恢复](docs/zh-CN/guide/live-and-recovery.md) |
| Memory and Claude skill | [Memory](docs/guide/memory.md) | [记忆与资源](docs/zh-CN/guide/memory.md) |
| Backup and restore | [Data ownership](docs/guide/data-ownership.md) | [数据归属](docs/zh-CN/guide/data-ownership.md) |
| CLI and config | [Reference](docs/reference/cli-and-config.md) | English only |

For contributors and maintainers, see [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), [release checklist](docs/release-checklist.md), and
[productization roadmap](docs/productization-roadmap.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
