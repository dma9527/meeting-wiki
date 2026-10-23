# Agent Knowledge Base

This folder holds what a coding agent (Kiro, Claude Code, or similar) needs to know before changing Meeting Wiki. Read it before editing code. It is deliberately short; it links to the repository docs instead of copying them.

| File | Read it when |
|---|---|
| `project.md` | You need the architecture, repository layout, or data flow. |
| `rules.md` | You are about to change behavior, add a provider, touch privacy, commit, or push. Hard constraints live here. |
| `workflow.md` | You need to build, test, verify, version, or package. |
| `gotchas.md` | Something behaves unexpectedly, or you are changing config, language, Settings, or CI. |

## Source of truth

- `docs/architecture.md`: design principles and flow.
- `docs/known-issues.md`: open release blockers. Do not claim a blocker is closed without evidence.
- `docs/productization-roadmap.md`: execution ledger with status and evidence.
- `docs/release-checklist.md` and `docs/releasing-macos.md`: release gates.
- `CONTRIBUTING.md`: contributor rules.

If this folder disagrees with the code or those docs, the code and docs win. Fix this folder in the same change.

## Keeping this folder useful

- Add a lesson only when it cost real time to learn and is not obvious from the code.
- Keep every entry short, concrete, and verifiable. Name the file or test that proves it.
- This repository is public. Never put personal paths, account IDs, employer-internal systems, credentials, meeting content, or contact details in this folder.
