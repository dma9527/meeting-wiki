# Meeting Wiki Documentation

[English](README.md) | [简体中文](zh-CN/README.md)

Meeting Wiki is an early alpha for macOS 14.2 or later on Apple Silicon. There is no
signed release; current builds are unsigned local test artifacts.

## User guides

1. [Installation](guide/installation.md): build the app, install it on your
   own Mac, uninstall.
2. [Setup and API key](guide/setup.md): providers, key storage, permissions,
   changing providers.
3. [Recording](guide/recording.md): manual recording, private meetings, audio
   import, Zoom and Google Meet automatic recording.
4. [Live sidebar and recovery](guide/live-and-recovery.md): live captions,
   self-check, retrying failed processing.
5. [Memory, URL resources, and Claude skill](guide/memory.md): the wiki
   window, memory search, attached links, MCP, speaker corrections.
6. [Data ownership](guide/data-ownership.md): encrypted backup, restore,
   deletion preview, retention plan.
7. [Known limitations](guide/limitations.md): release status and current gaps.

## Reference

- [CLI and configuration](reference/cli-and-config.md): command-line
  workflow, provider table, briefs, decisions, S3 mode, development.
- [Data ownership reference](data-ownership.md): backup format, included
  categories, deletion preview effects.
- [Integrations](integrations.md): every signal used by Zoom and Google Meet
  automatic recording.
- [Architecture](architecture.md)
- [macOS install details and troubleshooting](install-macos.md)

## Maintainers

- [Known issues and release blockers](known-issues.md)
- [Signed macOS release runbook](releasing-macos.md)
- [Release checklist](release-checklist.md)
- [Portable runtime](portable-runtime.md)
