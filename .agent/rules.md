# Hard Rules

These are constraints, not preferences. If a task seems to require breaking one, stop and ask the owner.

## Privacy and data

- Never commit real audio, transcripts, calendar events, real names or emails, account IDs, credentials, or production configuration. Tests use clearly fake values, such as an all-zero account ID and `test-` prefixed resource names.
- Do not weaken private-meeting isolation. Private meetings never enter shared search, S3, or MCP.
- Do not add MCP write or delete tools. MCP stays read-only.
- Secrets live in environment variables or the macOS Keychain-backed store, never in TOML, logs, notifications, or test output.
- No telemetry. Reliability evidence stays local or is exported explicitly by the user.
- Notifications and error text must not contain meeting titles, Meet codes, file paths, or raw errors.
- External live providers receive microphone audio and transcript text, including for private recordings. Any change to that data flow must be disclosed in the UI, in docs, and in the English and Chinese copy.

## Architecture

- Core depends on provider protocols in `meeting_wiki/providers/base.py`, never on vendor SDKs.
- The LLM returns typed analysis records, never Markdown pages. Rendering stays deterministic and idempotent.
- New providers are optional, registered in `registry.py`, documented with their data flow, and covered by a contract test. The local default must keep working.
- Renderer code talks to the main process only through the preload bridge. Write dynamic values with `textContent` or `input.value`, never `innerHTML`. Keep the CSP self-only. Tests assert this.
- IPC handlers must check the sender is the expected window.
- Never let a UI save change a config key it does not own. Settings writes read back and compare everything outside the edited section.

## Releases

- Never publish, upload, or tag a release, and never present a build from `build-macos.sh` as distributable. It is ad-hoc signed for local testing.
- Never write, invent, or commit a `MEETING_WIKI_GPL_SOURCE_OFFER` file. It is a legal commitment only the release owner can make.
- Never install a build into `/Applications` or remove an installed app without explicit confirmation.
- Do not overwrite artifacts of a previous version in `desktop/dist`.
- Do not claim a release blocker in `docs/known-issues.md` is closed without evidence.

## Git

- Commit only when asked or when the task says to. Push only when asked. Never force push, rewrite pushed history, or use `--no-verify`.
- Stage specific files, not everything. Do not touch unrelated working-tree changes.
- Conventional Commits: `type(scope): Subject`, imperative, no trailing period, subject at most 70 characters. Put the why in the body, kept short.
- Do not publish or reply to code review comments on the owner's behalf.

## Code and writing style

- Do not add `eslint-disable` comments. Fix the cause.
- Desktop code is plain JavaScript. Validate every value that crosses a trust boundary (IPC arguments, config files, bridge payloads).
- Use descriptive names in callbacks (`instance`, `entry`), not one-letter or truncated names.
- Do not add unrequested features, refactors, or specs.
- Docs and commit messages: plain sentences ending in a period. Avoid em dashes, en dashes, and arrow characters.
- Public docs are English. Chinese counterparts live in `docs/zh-CN/` and the Settings catalog. Do not mix languages inside one document.
