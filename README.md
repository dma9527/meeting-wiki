# Meeting Wiki

A local-first meeting memory system that turns conversations into an evolving,
plain-Markdown knowledge base.

Unlike tools that produce one isolated summary per call, Meeting Wiki maintains
people, topics, decisions, action items, and meeting history across time. Your
files stay readable without the app and work with Obsidian, VS Code, Git, or any
Markdown tool.

## Status

Early alpha. macOS on Apple Silicon is the first supported desktop platform.
The packaged app now contains an app-owned Python runtime, Meeting Wiki
components, `rec`, and `sox`; it does not require Homebrew, Node.js, Python, a
source checkout, or a user venv on the target Mac.

The current local artifact is unsigned and contains a test-only source offer
for bundled copyleft audio components. It is appropriate only for Martin's own
Macs. Do not upload it as a public GitHub release or send it to other people.
A distributable release requires a Developer ID certificate, notarization, and
a real source offer or a replacement for the copyleft audio toolchain. See the
[signed macOS release runbook](docs/releasing-macos.md) and
[portable runtime notes](docs/portable-runtime.md).

## Install on another Apple Silicon Mac

This section is the complete installation guide to send with a signed release.
The target Mac needs macOS 14 or later and Apple Silicon. Intel Macs are not
supported.

### Install a signed release

1. Download `Meeting Wiki-<version>-arm64.dmg` and `SHA256SUMS` from the
   GitHub release page.
2. In the download directory, verify the DMG was not changed in transit:

   ```bash
   grep 'Meeting Wiki-.*-arm64\.dmg$' SHA256SUMS | shasum -a 256 -c -
   ```

   The command must print `OK`.
3. Open the DMG and drag **Meeting Wiki** to **Applications**.
4. Open **Meeting Wiki** from Applications. Complete the first-run wizard:
   - Choose an online provider or Local only.
   - For an online provider, enter the endpoint, model names, and API key.
     The key is encrypted through macOS Keychain facilities, never written to
     `config.toml` or application logs.
   - Read and acknowledge the data-egress notice before checking an external
     provider. Meeting audio and transcript text are sent only to the provider
     selected in the wizard.
   - Grant Microphone and Screen & System Audio Recording permission when
     macOS requests them.
   - Run the provider connection test, then make a short recording.

Running setup again to change providers is transactional. The new provider is
checked with a temporary config first, and the active key, config, and setup
state change only when you press **Finish setup** after a passing check. A
failed check, or closing the window, leaves the current provider working. Leave
the key field blank to check and keep the key already saved for that provider,
or use **Test current setup** to check the active provider without changes.
The key field has **Show key** (hides again after 20 seconds) and **Paste**
controls; pasted text goes only into the masked field and is never logged.

Your meetings, local wiki, jobs, logs, and private meeting data stay under
`~/.meeting-wiki/` by default. Removing the app does not delete this data.

### Install an unsigned personal test build

Unsigned builds must only be used on a Mac you control. After copying the app
to `/Applications`, remove the macOS download quarantine attribute:

```bash
xattr -dr com.apple.quarantine "/Applications/Meeting Wiki.app"
```

Then follow the first-run steps above. If macOS reports that the installation
is damaged, do not bypass it. Obtain a fresh artifact whose bundled runtime
passes the release checks.

### Build on the target Mac

Use this only when no signed release is available. Install the build tools,
clone the repository, then create an app-owned runtime and an unsigned local
artifact:

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install uv node sox

cd meeting-wiki
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -e '.[dev,gemini]'
printf '%s\n' 'Personal build, not distributed.' > /tmp/meeting-wiki-source-offer.txt
MEETING_WIKI_GPL_SOURCE_OFFER=/tmp/meeting-wiki-source-offer.txt \
  bash scripts/build-macos.sh
```

The build writes the DMG, ZIP, checksums, and app bundle under `desktop/dist/`.
The temporary source offer above is valid only for a build you keep on your own
Mac. Read `docs/portable-runtime.md` before distributing an artifact to anyone
else.

For detailed troubleshooting and uninstall instructions, read
[docs/install-macos.md](docs/install-macos.md).

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

Use `--private` on the CLI. In the desktop app, **Start recording...** (or
Cmd+Shift+0) opens a confirmation panel where you choose Shared wiki or
Private, set an optional title, and review capture permissions, where audio
is processed, the length limit, and live caption readiness before anything is
recorded. **Import audio...** asks the same privacy question for each import.
Private meetings:

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
- `meeting_wiki_memory_search` (shared memory only)
- `meeting_wiki_read_page`
- `meeting_wiki_list_recent`
- `meeting_wiki_action_items`

## Canonical memory

Each processed meeting is also indexed into `data_dir/memory.db`, a local graph
of people, topics, decisions, action items, and transcript lines with links back
to the source meeting. Rebuild it from existing local artifacts, for example
after upgrading or restoring a backup:

```bash
meeting-wiki reindex-memory
meeting-wiki memory-search --query "canary rollout" --type decision --type topic
meeting-wiki memory-search --query "canary rollout" --include-private
```

`reindex-memory` prints only counts. `memory-search` returns shared memory
unless you pass `--include-private`. The MCP `meeting_wiki_memory_search` tool
never returns private memory. The desktop window has a Memory search view with
type filters and an "Include private memory on this Mac" checkbox that starts
unchecked.

### URL resources

You can attach a link to a meeting with your own title and summary. Meeting Wiki
stores the URL, title, summary, and relation locally in `memory.db`; it never
opens, fetches, or sends the URL anywhere.

```bash
meeting-wiki memory-add-resource --meeting=meeting:<id> --url=https://docs.example.com/spec \
  --title="Rollout spec" --summary="Canary plan" --relation=design_doc
meeting-wiki memory-resources
meeting-wiki memory-resources --include-private
```

Take the meeting id from a `memory-search --type=meeting` result. URLs must be
https to a public host name or address, with no user name or password, no
secret-looking query parameters (such as `token` or `X-Amz-Signature`), and no
`#fragment`. Private, link-local, reserved, and special-use hosts (`.local`,
`.internal`, single-label names) are rejected; `--allow-loopback` permits
`http://localhost` style URLs for local tools. A resource inherits its meeting's
privacy: attaching to a private meeting needs `--allow-private`, and if a
meeting later becomes private or is removed, its resources disappear from shared
search and listings. Resources survive `reindex-memory`. In the desktop Memory
search view, each shared meeting result has an "Add resource" form; it can only
target shared meetings over https.

### Claude skill

The menubar item "Install Claude skill for meeting memory..." (next to "Open
Wiki & Corrections") copies a bundled, data-free
`SKILL.md` template to `~/.claude/skills/meeting-wiki-memory/SKILL.md`. It
teaches agents to query memory through the MCP tools or CLI, reindex safely,
keep private memory opt-in, and never write memory files directly. The installer
creates missing folders as 0700 and the file as 0600, refuses to overwrite a
file with different content, and shows the result (installed, already
installed, conflict, unsafe path, or error) in an in-app dialog with a fixed
message. It falls back to a notification only if the dialog cannot open. The
template lives at `desktop/skills/meeting-wiki-memory/SKILL.md`.

## Desktop wiki and correction inbox

The menubar item "Open Wiki & Corrections" opens a local window for browsing the
shared wiki: recent meetings, full-text search, exact page reads, and open action
items. The window loads no remote content, runs with context isolation and a
sandboxed renderer, and reaches the main process only through a narrow preload
bridge. That bridge reads `data_dir/wiki` and nothing else; path containment
rejects `../`, absolute paths, null bytes, and symlinks that escape the tree, so
`private/` is unreachable from the window. The only private data the window can
show is canonical memory, and only after you tick "Include private memory on this
Mac" for a Memory search.

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

## Automatic recording for Zoom and Google Meet

Settings > Automatic recording can start a recording when you join a meeting and
stop, save, and process it when you leave. Both integrations are off until you
turn them on. There is no countdown; the tray recording icon and the "Recording
started" notification show that it is recording. A meeting that ends within 10
seconds is discarded instead of processed.

- **Zoom app:** a 3-second local check of Zoom's processes, UDP sockets, and
  display-sleep assertion with `ps`, `lsof`, and `pmset`. No Zoom windows, chat,
  or participants are read.
- **Google Meet:** a bundled Chromium extension
  (`desktop/browser-extension/google-meet`, loaded once with Load unpacked)
  reports only whether the Leave call control exists. It reaches Meeting Wiki
  through a native messaging host pinned to the extension's ID and a private
  folder, with no network listener.

[docs/integrations.md](docs/integrations.md) lists every signal, boundary,
supported browser, and startup constraint.

## Processing status and recovery

The menubar shows whether meetings are processing or need attention. It also
provides a capability self-check, local logs, and a one-click retry for dead
jobs. **Run self-check...** reports microphone and system audio permission,
batch transcription and analysis, live captions, storage, the memory index, and
the Claude skill. Every line is fixed text chosen from a status code; provider
error text, paths, and keys are never shown. The engine side is available as
`meeting-wiki self-check`, which prints only status codes.
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
