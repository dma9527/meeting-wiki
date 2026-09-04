# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository. Do
not open a public issue for suspected credential exposure, path traversal,
private-meeting leakage, arbitrary command execution, SSRF, or recording data
exposure.

Include reproduction steps, affected version/commit, impact, and a minimal test
case. Do not include real meeting audio or transcripts.

## Security model

- Local providers are the default. No telemetry is collected.
- Secrets are read from environment variables or the operating system's normal
  credential chain, never from committed configuration.
- Private meetings are written only under `private/`, are not mirrored to S3,
  are not indexed, and are excluded from MCP.
- MCP is read-only over stdio and rejects path traversal.
- Webhook task integration requires HTTPS and rejects private/reserved network
  destinations unless the user explicitly opts in.
- The worker uses argument arrays rather than shell interpolation.

## Supported versions

Only the latest release and current `main` branch receive security fixes during
alpha development.

## Hardening checklist for releases

- Run `scripts/verify-local.sh`.
- Run a clean-history secret and PII scan.
- Build from a clean checkout.
- Sign and notarize macOS artifacts.
- Publish checksums.
- Verify packaged files contain no config, logs, audio, transcripts, models, or
  credentials.
