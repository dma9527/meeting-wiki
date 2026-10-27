# Meeting Wiki Productization Roadmap

Last reviewed: 2026-10-27.

Baseline: Meeting Wiki 0.1.19 at commit `5ccb446`. The previous baseline was 0.1.13 at commit `3eb799b`; see "Progress since 0.1.13".

## Objective

Turn Meeting Wiki from a local engineering alpha into a trustworthy macOS private beta. The product promise is a local-first, source-linked meeting memory that users and their agents can query safely.

This document is the execution ledger. A work item is complete only when its implementation and required evidence are both present. `docs/release-checklist.md` remains the per-release sign-off list, and `docs/known-issues.md` remains the source of truth for open release blockers.

## Progress since 0.1.13

Every row names the commits that carry it. A row records what was built, not what was validated on a signed build; the phase sections below keep the open validation work.

| Version | Change | Commits |
|---|---|---|
| 0.1.14 | Quick-start recording defaults, reliable automatic live startup, language preferences in Settings. | `08008f9`, `33bb4f3`, `6b50e2a` |
| 0.1.15 | DMG and ZIP are built from the re-signed app and verified after mounting and extracting. Live captions both audio channels (You and Others) and recovers from dropped connections. A knowledge base for coding agents is added to the repository. | `1087672`, `309e955`, `c75838b` |
| 0.1.16 | First-run app language. Same-language translations are hidden in the live window. The memory language can follow the meeting. Setup, recording options, and the live window are localized. | `a365ea2`, `a0a9360`, `64f05d5`, `44947f8` |
| 0.1.17 | Tray menu, notifications, and dialogs are localized. Install instructions clear the download flag before the app is dragged out of the DMG. | `57370d3`, `34a5fa8`, `4263360` |
| 0.1.18 | Wiki and Corrections window is localized. | `b16be30` |
| 0.1.19 | Privacy-safe diagnostics export (CLI and tray). Electron 44.9.3. Dependency advisories fixed. | `01dd819`, `0b5aedb`, `2be02f8`, `e250805` |

## Status definitions

| Status | Meaning |
|---|---|
| Complete | Implemented and covered by repository evidence. |
| Partial | Useful implementation exists, but the stated contract or evidence is incomplete. |
| Blocked | Repository work is ready or substantially ready, but an external requirement prevents completion. |
| Not started | No product implementation or acceptance evidence exists. |
| Deferred | Intentionally outside the current beta gate. |

## Release principles

1. Do not distribute a build that cannot pass macOS signature and Gatekeeper checks.
2. Do not claim an integration is reliable until it passes a real end-to-end validation.
3. Preserve source audio and transcript lineage through every processing and recovery path.
4. Keep private memory opt-in and never expose it through shared search or integrations.
5. Prefer a narrow, verified workflow over broad unsupported integrations.
6. Keep the documented no-telemetry policy. Reliability evidence must remain local or be exported explicitly by the user.

## Status summary

| Phase | Status | Current gate |
|---|---|---|
| A. Release integrity | Blocked | Developer ID, notarization, corresponding source, and second-Mac validation. The diagnostic export is implemented and awaits that validation. |
| B. Core reliability | Partial | Real Gemini, Zoom, and Google Meet validation plus durable integration health. |
| C. Data ownership | Partial | Portable export and lifecycle apply policy. |
| D. Configuration and UX | Partial | Unified capability report and full Settings registry. |
| E. Memory differentiation | Partial | Canonical citation contract and dedicated history views. |
| F. Beta operations | Partial | Support documents exist, but cohort operations require a signed and validated alpha build. |

## Phase A: Release Integrity and Distribution Gate

**Status:** Blocked by external release prerequisites; one internal support item also remains.

### Complete

- Release preflight requires a clean Git tree, committed version parity, an exact annotated release tag, and explicit candidate mode.
- Release manifests record source identity, versions, runtime identity, extension identity, notices, source-offer hash, and artifact checksums.
- App, ZIP, and DMG inventory checks require the CLI installer, Claude skill, Google Meet extension, runtime tools, project notices, product icon, permission descriptions, and retained runtime licenses.
- Runtime staging records CPython, Python package, SoX, and linked-library licenses and blocks absent source-offer input.
- Local builds create the DMG and ZIP from the re-signed app and check the mounted and extracted copies, so the app is not reported as damaged after install on the build Mac (`scripts/build-macos.sh`, `tests/test_release_script.py`).
- Install instructions tell a second Mac to clear the download flag from the DMG before dragging the app out (KI-6). Developer ID signing removes this step.
- The desktop runtime is Electron 44.9.3. CI runs `pip-audit` and `npm audit --audit-level=high` and both are clean on the current commit.
- Release signing code implements inside-out runtime, app, and DMG signing. Static tests verify ordering, required entitlements, and fail-closed metadata checks; a credentialed run remains unverified under KI-4.
- Release, installation, security, and known-issue documents exist.

### Evidence

- `scripts/release-macos.sh`.
- `scripts/release_integrity.py`.
- `scripts/prepare-runtime-macos.sh`.
- `tests/test_release_integrity.py`.
- `tests/test_release_script.py`.
- `tests/shell/test-prepare-runtime.sh`.
- `docs/release-checklist.md`.
- [0.1.13 CI run 39867251856](https://github.com/dma9527/meeting-wiki/actions/runs/39867251856).

### Remaining validation and blockers

| Item | Status | Required evidence | Owner |
|---|---|---|---|
| Developer ID Application identity | Blocked | Valid certificate and private key available to the release process. | Release owner |
| Apple notarization | Blocked | Successful `notarytool` submission, stapling, and validation. | Release owner |
| GPL and LGPL corresponding source | Blocked | Matching source materials and an offer the release owner can honor. | Release owner |
| Credentialed signing path | Partial | Successful Developer ID app and DMG signing with matching team, timestamps, hardened runtime, and required entitlements. | Release owner |
| Tagged release build | Not started | `vVERSION` points to the release commit, release mode succeeds, and the manifest records `publishable: true`. | Release owner |
| Clean-Mac install | Not started | Gatekeeper, first run, permissions, upgrade, and uninstall checklist results from a second Mac. Depends on the credentialed release build. | Release owner and tester |
| User-initiated diagnostic export | Partial | `meeting-wiki diagnostics-export` and the tray item **Export diagnostics...** are implemented offline, with read-only access, per-field allowlists, and a fail-closed final scan (`tests/test_diagnostic_export.py`, `desktop/test/diagnostics-export.test.js`). A second-Mac check and an on-screen check of the save dialog remain. | Maintainer |

### Exit criteria

Phase A completes only when KI-0, KI-3, and KI-4 are closed; the user-initiated diagnostic export passes its privacy contract; and one release-mode build from the exact `vVERSION` tag records `publishable: true`, passes `scripts/release-macos.sh`, and satisfies sections 1 through 6 of `docs/release-checklist.md`.

## Phase B: Core Reliability and Availability

**Status:** Partial.

### Complete

- Durable capture manifests preserve recording-start time, privacy, and source identity before queue admission.
- Queue claims, stage updates, retries, and completion are claim-token protected.
- Retries reuse a persisted job-scoped analysis snapshot after analysis succeeds.
- The privacy-safe event journal records fixed event codes without meeting content or raw errors.
- External task delivery uses stable action IDs and a durable outbox.
- Correction reprocessing suppresses duplicate external task delivery.
- Recovery UI shows refresh time, stage, privacy-safe labels, persistent errors, individual retry, and counted bulk confirmation.
- Simulated Gemini Live renewal, transcript ordering, Zoom detection, Meet extension, native-host repair primitives, and event ordering have regression coverage.
- Live captions run on two channels: the microphone is labeled You and the audio played on the Mac is labeled Others. Each channel has its own provider session and reconnects up to three times with backoff, and a silent system channel is reported after 30 seconds.
- Live failures are written to a local log with allowlisted codes only, and **Run self-check...** can open one real live session with silent audio to prove the connection (`meeting-wiki self-check --probe-live`).
- A live outage seen in October was traced to the provider account (the service closed the connection with code 1011), not to the app. The probe now reports that kind of failure by code instead of as an unexplained "unavailable".

### Evidence

- `meeting_wiki/captures.py`.
- `meeting_wiki/jobs.py`.
- `meeting_wiki/events.py`.
- `meeting_wiki/outbox.py`.
- `meeting_wiki/live.py`.
- `desktop/zoom-detector.js`.
- `desktop/meet-bridge.js`.
- `desktop/meet-native-host.js`.
- `tests/test_retry_consistency.py`.
- `tests/test_outbox.py`.
- `tests/test_live.py`.
- `desktop/test/meet-native-host.test.js`.

### Remaining

| Item | Status | Acceptance evidence |
|---|---|---|
| Gemini Live soak | Not started | One 15-minute meeting with forced renewal and one provider-limit run, with no restart and no transcript gap. |
| Live and batch reconciliation | Partial | Defined continuity rule and an end-to-end comparison of final live and batch transcripts. |
| Zoom installed-app validation | Partial | Real join, leave, debounce, privacy, stop, and processing results on the signed release build. |
| Google Meet installed-app validation | Partial | Join, heartbeat, leave, browser restart, host repair, privacy, stop, and processing results on the signed release build. |
| Durable integration health | Partial | Persist last success, fixed failure code, dry-run result, component version, and observation time with corruption and restart tests. |
| Recovery state matrix | Complete | `docs/reference/job-states.md` lists every state with its automatic handling and allowed actions; `tests/test_job_state_matrix.py` runs each action against a real queue so the table cannot drift. Real-meeting validation of the stalled-work steps remains under the integration rows. |

### Exit criteria

- The Gemini soak and live-to-batch reconciliation rows are complete on the exact signed build.
- Zoom and Google Meet validation rows are complete on the same build.
- Durable integration health records last success, fixed failure code, dry-run result, component version, and observation time.
- A timeout after accepted external task creation cannot create a duplicate.
- The recovery state matrix gives every supported failed or stalled job state one documented action.

## Phase C: Data Ownership and Recovery

**Status:** Partial. The original technical exit criteria are implemented, but the user-facing lifecycle contract is incomplete.

### Complete

- Encrypted backup creation, verification, inspection, and staged restore cover local product data while excluding secrets and runtime files.
- Meeting deletion preview enumerates local, memory, S3, resource, and external-task effects without mutating data.
- S3 uses immutable revision objects and a conditionally committed manifest so readers do not observe partial revisions.
- Retention planning identifies eligible audio, dismissed jobs, temporary live chunks, and backups without deleting automatically.

### Evidence

- `meeting_wiki/backup.py` and `tests/test_backup.py`.
- `meeting_wiki/deletion.py` and `tests/test_deletion.py`.
- `meeting_wiki/retention.py` and `tests/test_retention.py`.
- `meeting_wiki/providers/s3_storage.py` and `tests/test_s3_revisions.py`.

### Remaining decisions and work

| Item | Status | Required decision or evidence |
|---|---|---|
| Portable export | Partial | Define selection scope, private-data behavior, archive schema, deterministic manifest, and inspection tests for Markdown, transcript JSON, and memory resources. |
| Deletion apply | Deferred | Decide whether beta remains preview-only or adds a guarded, crash-safe apply command with external-task and S3 behavior. |
| Retention apply | Deferred | Decide whether beta remains plan-only or adds confirmed cleanup with protected-job ordering and backup safety. |
| Device migration | Partial | Validate backup restore on a second Mac and document version compatibility and rollback. |

### Exit criteria

Phase C completes when portable export and second-device restore are validated, and the preview-only versus guarded-apply lifecycle policy is explicit.

## Phase D: Configuration and Product UX

**Status:** Partial and close to the beta bar.

### Complete

- Provider setup is transactional. Candidate configuration does not replace the active provider until a successful check and explicit finish.
- API key show, timed masking, paste, saved-key reuse, and current-provider testing use narrow IPC surfaces.
- Recording confirmation exposes title, privacy, capture scope, live availability, duration, and permission blockers.
- Every exposed setting shows when it applies.
- Memory resources use field-level validation and fixed error messages.
- Bulk recovery retry requires counted confirmation.
- Local only setup is visible but disabled because it cannot complete in this build.
- The app language is chosen at first run and in Settings. It sets the language of every window and the default live translation and summary languages. Setup, Settings, the recording options, the live window, the tray menu, notifications, dialogs, the self-check result, and the Wiki and Corrections window follow it. Meeting titles, wiki page text, paths, and error codes are never translated.
- The memory language can be **Same as the meeting**, which stores facts in the language that was spoken and is the default for new installs.
- Recording defaults (privacy and live) persist, so a normal start and the global shortcut begin immediately.
- CLI installation uses guarded user-owned shims and never overwrites custom files or links.

### Evidence

- `desktop/setup-window.js`.
- `desktop/settings-window.js`.
- `desktop/setting-metadata.js`.
- `desktop/record-window.js`.
- `desktop/self-check.js`.
- `desktop/cli-installer.js`.
- `desktop/main-localization.js` and `desktop/renderer/{i18n,setup-localization,settings-localization,record-localization,live-sidebar-localization,wiki-localization}.js`.
- Corresponding tests under `desktop/test/`, including catalog coverage tests that read the source for every string a window can show.

### Remaining

| Item | Status | Acceptance evidence |
|---|---|---|
| Localization review | Not started | A native reader reviews the Simplified Chinese catalogs, and every window is viewed on screen in each language. The copy so far has been checked by tests, not by a reader. |
| Electron 44 window check | Not started | Settings, recording options, the live window, the Wiki and Corrections window, and the **Export diagnostics...** save dialog are viewed on an installed 0.1.19 build. The upgrade was verified by tests, a full build, and a launch only. |
| Unified capability report | Partial | Provider, storage, permissions, live adapter, memory, Zoom, Meet, and skill state appear in one privacy-safe report. |
| Full Settings registry | Partial | Every configurable value declares owner form, default, persistence layer, validation, effect timing, restart behavior, and capability mapping. |
| Fresh-install usability | Not started | A new user completes setup, permissions, readiness, recording, processing, and recovery on the signed build without documentation. Depends on Phase A. |

### Exit criteria

Phase D completes when the registry and capability report have full coverage tests and fresh-install validation passes on the signed candidate.

## Phase E: Memory Differentiation

**Status:** Partial.

### Complete

- Local canonical memory stores typed meetings, people, topics, decisions, action items, transcript segments, and resources.
- Search returns typed relations and source-meeting metadata while excluding private memory by default.
- Read-only MCP and the installed Claude skill provide agent access without direct file access.
- User-supplied URL resources are stored but never fetched automatically.
- Primary profile name and aliases are configurable for any device owner.

### Evidence

- `meeting_wiki/memory.py`.
- `meeting_wiki/resources.py`.
- `meeting_wiki/mcp_server.py`.
- `tests/test_memory.py`.
- `tests/test_resources.py`.
- `tests/test_mcp.py`.

### Remaining

| Item | Status | Acceptance evidence |
|---|---|---|
| Canonical citation contract | Partial | Memory search results and relations use one citation shape across Desktop, CLI, MCP, and skill (`docs/reference/citations.md`). Wiki page search and list results still return plain page paths. |
| Decision History | Not started | Chronological decision view with citations and source navigation. |
| Person Commitments | Not started | Open, completed, changed, and contradicted commitments grouped by person and time. |
| Topic Evolution | Not started | Chronological statements and decisions with explicit source meetings. |
| User-triggered synthesis | Not started | Versioned output, explicit source set, conflict handling, user confirmation, and immutable source facts. |
| Speaker identity | Deferred | No implementation until consent, evidence, confidence, correction, retention, and revocation policies are approved. |

### Exit criteria

Phase E completes for private beta when Decision History, Person Commitments, and Topic Evolution use the canonical citation contract. Synthesis and speaker identity may remain deferred if the UI states that clearly.

## Phase F: Beta Operations and Growth

**Status:** Partial. Planning and documentation may proceed, but cohort operations begin only after a signed build passes Phases A and B.

### Planned beta work

| Item | Status | Acceptance evidence |
|---|---|---|
| Compatibility matrix | Not started | Tested macOS, browser, provider, extension, and native-host versions with support status. |
| Release-page update handoff | Not started | Signed release metadata check, explicit user action, release-page handoff, and failure recovery. |
| Automatic updates | Deferred | Trusted feed, rollback plan, signature validation, downgrade policy, and recovery tests. |
| Beta support package | Partial | Publish versioned release notes, migration and rollback guidance, known issues, consent guidance, and a support workflow that uses the Phase A diagnostic export. |
| Beta success criteria | Not started | Define local measurements and user-supplied diagnostic evidence for capture, batch completion, live renewal, integration detection, and restore success. |

Passive aggregate telemetry is not planned for private beta. Changing that policy requires an explicit privacy review and corresponding updates to `README.md` and `PRIVACY.md` before implementation.

### Exit criteria

- A signed alpha cohort can install, upgrade, recover, export, and report issues safely.
- Product claims match the exact integrations and versions validated on release candidates.
- No unresolved privacy or data-loss incident exists.

## Execution gates

Implementation may proceed across phases when work is independent, but release claims follow these gates in order.

1. **Distributable release build:** close every Phase A row, produce a release-mode artifact from the exact tag, and pass the second-Mac checklist.
2. **Reliable integrations:** pass every Phase B remaining row on that same build.
3. **Coherent product contract:** complete portable export, the lifecycle policy, second-device restore, unified capability reporting, the Settings registry, and fresh-install validation.
4. **Visible memory value:** ship the canonical citation contract, Decision History, Person Commitments, and Topic Evolution before adding broader synthesis.
5. **Private beta:** define compatibility, update handoff, diagnostic support operations, support, and success criteria.

No phase may claim public or beta readiness while an earlier release gate remains unmet.

## Immediate next milestones

| Priority | Milestone | Done when |
|---|---|---|
| 1 | Resolve release prerequisites | Developer ID, notarization, and corresponding-source materials are available and documented. The diagnostic export is implemented and needs the second-Mac check. |
| 2 | Build and validate a tagged release | Release mode records `publishable: true`, the release script passes, and the second-Mac checklist is complete. |
| 3 | Run the real integration matrix | Gemini, Zoom, and Meet results are recorded for that exact release build. |
| 4 | Unify health reporting | Durable integration state appears in one capability report and Settings view. |
| 5 | Ship Decision History | Chronological decisions use the canonical citation contract and open their sources. |
| 6 | Check 0.1.19 on screen | The two Phase D rows for the Electron 44 window check and the localization review are recorded as passed or fixed. |
