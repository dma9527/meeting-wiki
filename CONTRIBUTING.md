# Contributing

Thank you for helping improve Meeting Wiki.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
cd desktop && npm install && cd ..
./scripts/verify-local.sh
```

## Rules

- Never commit real audio, transcripts, calendar events, employee/customer
  names, emails, account IDs, credentials, or production configuration.
- Tests must use clearly fake names and account identifiers.
- Do not weaken private-meeting isolation or add MCP write tools.
- Core code depends on provider interfaces, not vendor SDKs.
- LLMs return typed analysis records, never full Markdown pages.
- Rendering must remain deterministic and idempotent.
- Add tests for new providers and failure paths.
- Keep secrets in environment variables, never TOML.

## Pull requests

Include the problem, design trade-offs, validation performed, and privacy/data
flow changes. Run Python lint/tests and desktop tests before submission.

Large changes should be split into provider/core/UI commits so reviewers can
validate dependency direction.

## Adding a provider

Implement the matching protocol in `meeting_wiki/providers/base.py`, add it to
`registry.py`, document its data flow and secrets, and add a contract test.
Cloud providers must be optional; the local default must continue to work.
