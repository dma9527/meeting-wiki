# Meeting Wiki Live Sidebar Release Plan

**Goal:** Ship a public alpha candidate with a local-first live translation sidebar and passing release gates.

**Spec:** `docs/plans/2026-10-14-release-live-sidebar-design.md`

**Architecture:** Electron owns recording and the live-session lifecycle. A loopback Python live service emits non-persistent updates through an authenticated session channel. Existing durable ingestion remains responsible for final transcript processing and wiki rendering.

**Tech Stack:** Electron, Node.js test runner, Python 3.11+, Pydantic, SQLite, MLX Whisper, Ollama, WebSocket loopback protocol.

## Delivery Sequence

### Task 1: Repair dependency and release verification gates

**Files:**
- Modify: `pyproject.toml`
- Modify: `scripts/verify-local.sh`
- Modify: `scripts/release-macos.sh`
- Modify: `docs/releasing-macos.md`
- Test: `scripts/verify-local.sh`

1. Identify direct and transitive dependency sources for PyJWT and urllib3.
2. Update exact lower bounds to versions accepted by dependency audit.
3. Add a regression check that verifies release validation invokes the full local verification suite before any signing operation.
4. Run the new regression check and confirm it fails before the release-script change.
5. Implement the release-script gate and rerun the regression check.
6. Run `./scripts/verify-local.sh`.
7. Commit and push the validated gate repair.

### Task 2: Define live provider contracts and strict configuration

**Files:**
- Modify: `meeting_wiki/providers/base.py`
- Modify: `meeting_wiki/config.py`
- Modify: `meeting_wiki/providers/registry.py`
- Modify: `meeting_wiki/default_config.toml`
- Modify: `config.example.toml`
- Test: `tests/test_config_privacy.py`
- Test: `tests/test_providers.py`

1. Add failing provider-contract tests for ordered live transcript events, translation requests, default local configuration, and external endpoint opt-in.
2. Run the focused tests and confirm they fail because live provider contracts and config are absent.
3. Add typed provider protocols and capability validation without changing batch provider behavior.
4. Add validated, local-first live provider selection and endpoint settings.
5. Add provider registry construction and doctor validation.
6. Run focused tests, then full Python tests.
7. Commit and push the validated provider boundary.

### Task 3: Implement local live providers and the session protocol

**Files:**
- Create: `meeting_wiki/providers/live.py`
- Create: `meeting_wiki/live.py`
- Modify: `meeting_wiki/cli.py`
- Modify: `meeting_wiki/models.py`
- Test: `tests/test_live.py`
- Test: `tests/test_providers.py`

1. Add failing tests that prove the session rejects non-loopback or tokenless clients, rejects out-of-order events, and redacts errors.
2. Add failing tests for local chunk transcription overlap deduplication and translation output ordering.
3. Run the focused tests and confirm the live command is unavailable.
4. Implement the loopback-only live service with an ephemeral port and per-session token.
5. Implement testable local chunk sequencing, final-segment deduplication, local Ollama translation and summary calls, and explicit external-provider opt-in.
6. Expose `meeting-wiki live` with minimum required arguments and privacy mode.
7. Run focused tests, then `./scripts/verify-local.sh`.
8. Commit and push the validated live runtime.

### Task 4: Connect capture lifecycle to the live session

**Files:**
- Modify: `desktop/capture.js`
- Modify: `desktop/main.js`
- Create: `desktop/live-session.js`
- Modify: `desktop/package.json`
- Test: `desktop/test/capture.test.js`
- Test: `desktop/test/live-session.test.js`
- Test: `desktop/test/package-files.test.js`

1. Add failing tests for start, stop, discard, crash recovery, token forwarding, and loopback-only connection setup.
2. Run focused desktop tests and confirm the lifecycle module is absent.
3. Implement an audio tail reader that exposes only new owner-readable audio chunks from active local capture files.
4. Implement the Electron-owned live child process and WebSocket client. Use argument arrays and inherited environment variables rather than shell interpolation.
5. Wire start, stop, discard, and application exit to lifecycle cleanup.
6. Add all new packaged runtime files to the explicit Electron build allowlist.
7. Run focused desktop tests, then `./scripts/verify-local.sh`.
8. Commit and push the validated lifecycle integration.

### Task 5: Add the sandboxed live translation sidebar

**Files:**
- Create: `desktop/live-sidebar-window.js`
- Create: `desktop/live-sidebar-preload.js`
- Create: `desktop/renderer/live-sidebar.html`
- Create: `desktop/renderer/live-sidebar.js`
- Create: `desktop/renderer/live-sidebar.css`
- Modify: `desktop/main.js`
- Modify: `desktop/package.json`
- Test: `desktop/test/live-sidebar-window.test.js`
- Test: `desktop/test/package-files.test.js`

1. Add failing tests that prove the sidebar is sandboxed, has no generic IPC, blocks navigation and popups, and presents private-state and provider-state events correctly.
2. Run focused tests and confirm the sidebar implementation is absent.
3. Implement a dedicated window and preload bridge that expose subscription and unsubscribe methods only.
4. Implement a readable sidebar with live transcript, Chinese translation, rolling summary, action candidates, privacy state, provider state, and recovery actions.
5. Ensure the renderer receives no token, path, credential, or shared-wiki context for private sessions.
6. Run focused tests, desktop tests, and `./scripts/verify-local.sh`.
7. Commit and push the validated sidebar.

### Task 6: Package, document, and validate public alpha readiness

**Files:**
- Modify: `README.md`
- Modify: `docs/releasing-macos.md`
- Modify: `CHANGELOG.md`
- Modify: `desktop/package.json`
- Test: `scripts/public-safety-scan.sh`
- Test: `scripts/verify-local.sh`

1. Add release-document regression checks for local-only quick start, external-provider disclosure, private-session behavior, and live sidebar recovery.
2. Run checks and confirm the required release content is absent.
3. Document setup, provider selection, privacy boundaries, sidecar recovery, signed-release operator prerequisites, and clean-machine acceptance steps.
4. Bump the release-candidate version consistently across desktop and Python packages.
5. Run public safety scan, complete local verification, and macOS build validation.
6. Commit and push the public-alpha candidate preparation.

### Task 7: UX review and remediation

**Files:**
- Modify: only files identified by review findings.
- Test: affected focused tests plus `./scripts/verify-local.sh`.

1. Load the installed frontend design skill and web app testing skill.
2. Review the actual sidebar and onboarding flows: first run, provider choice, recording start, live update, private recording, offline model error, recovery, and stop.
3. Record actionable findings in `docs/plans/2026-10-14-release-live-sidebar-ux-review.md`.
4. Add failing tests for accepted findings, apply fixes, run focused and full verification.
5. Commit and push the UX review and remediation.

## Commit and Push Rule

Every completed task above ends with exactly one conventional commit after its stated verification passes. Each commit is pushed to `origin/main` before work begins on the next task. No force push, amend, or unpublished commit is allowed.

## Final Release Checklist

- `./scripts/verify-local.sh` exits 0.
- `scripts/release-macos.sh --check` confirms valid Apple signing and notarization prerequisites.
- A signed artifact build passes notarization, stapling, checksum, and Gatekeeper assessment when Apple credentials are available.
- A clean macOS Apple Silicon account completes setup, records a meeting, sees the live sidebar, stops processing, and uses the shared wiki without any AWS configuration.
- External providers remain opt-in and visibly identified.
- Private sessions remain isolated from shared storage, MCP, and shared wiki context.
- The UX review report contains no unresolved release-blocking finding.
