# Meeting Wiki Productization Roadmap

## Objective

Turn Meeting Wiki from a local engineering alpha into a trustworthy macOS private beta. The product promise is a local-first, source-linked meeting memory that users and their agents can query safely.

## Release Principles

1. Do not distribute a build that cannot pass macOS signature and Gatekeeper checks.
2. Do not claim an integration is reliable until it passes a real end-to-end validation.
3. Preserve source audio and transcript lineage through every processing and recovery path.
4. Keep private memory opt-in and never expose it through shared search or integrations.
5. Prefer a narrow, verified workflow over broad unsupported integrations.

## Phase A: Release Integrity and Distribution Gate

### Goals

- Produce reproducible, traceable macOS release candidates.
- Prevent accidental publication of test-only artifacts.
- Align legal notices with the actual runtime contents.

### Work

- Add release preflight that requires a clean Git tree, a committed version bump, and an exact release tag.
- Record source commit, app version, runtime tree hash, extension version, and artifact checksums in a release manifest.
- Verify every declared extra resource is inside the final DMG and ZIP, including the Google Meet extension and Claude skill.
- Reconcile NOTICE, runtime licenses, SoX redistribution terms, and corresponding-source offer materials.
- Add macOS release validation that checks codesign, notarization, stapling, Gatekeeper, app resources, first-run startup, and uninstall retention.
- Add release notes, known issues, support instructions, and an artifact inventory.

### External blockers

- Developer ID Application certificate.
- Apple notarization credentials.
- Valid GPL and LGPL corresponding-source distribution decision for bundled audio tools.

### Exit criteria

- A clean macOS machine installs the DMG without quarantine removal.
- Gatekeeper accepts the application.
- DMG, ZIP, checksum, release manifest, notices, and source offer all reference one tagged commit.
- Artifact inspection proves no user data, secrets, local paths, or missing declared resources.

## Phase B: Core Reliability and Availability

### Goals

- Make capture, processing, and integrations resilient to transient faults.
- Keep user-visible state accurate and recoverable.

### Work

- Run real Gemini Live soak tests at short rollover intervals and at the provider connection limit.
- Validate session resumption, fresh rollover, final transcript continuity, and batch transcript reconciliation.
- Add a privacy-safe local event journal for capture, queue stages, live renewal, integration events, retry outcomes, and component versions.
- Make external task creation idempotent with stable action IDs and an outbox.
- Add durable per-integration readiness, last-success, last-failure-code, and dry-run status.
- Validate Zoom detection in a real meeting and add regression fixtures.
- Validate Google Meet extension join, leave, heartbeat, browser restart, and native host repair on installed app paths.
- Add a recovery view with refresh timestamp, retry-all confirmation, stage diagnostics, and log export.

### Exit criteria

- A 15-minute Gemini Live meeting does not require user restart.
- Zoom and Meet automatic recording pass documented real-environment test cases.
- A network timeout after accepted external task creation cannot create duplicates.
- Users can diagnose and recover every supported job state without editing files.

## Phase C: Data Ownership and Recovery

### Goals

- Make local ownership meaningful when devices fail, data is deleted, or users migrate.

### Work

- Add encrypted local backup and restore for audio, transcript, wiki, memory, settings metadata, jobs, and integration state.
- Add export formats for Markdown, transcript JSON, memory resources, and a verified archive manifest.
- Add meeting-level deletion preview covering audio, transcript, analysis, wiki, memory nodes, S3 copies, resources, and task links.
- Add retention settings for audio, dismissed jobs, temporary live chunks, and backups.
- Add S3 revision manifests or conditional write semantics for multi-object consistency.

### Exit criteria

- A user can create, verify, restore, and inspect an encrypted backup.
- A meeting deletion explains every affected artifact before execution.
- S3 readers never observe a partially committed meeting revision.

## Phase D: Configuration and Product UX

### Goals

- Make every configurable value understandable, validated, and self-explanatory.

### Work

- Finish transactional provider setup and make candidate versus active configuration explicit.
- Keep API key show, timed masking, paste, saved-key status, and test-current-key flows consistent across providers.
- Expand capability self-check to authenticated provider operations, storage read/write, permissions, live adapters, memory index, Meet extension, Zoom detector, and Claude skill state.
- Keep one Settings registry that declares default, persistence layer, validation, effect timing, restart behavior, and self-check mapping for every value.
- Replace implicit tray state with explicit recording confirmation, integration readiness, title, privacy, capture scope, and duration.
- Add field-level errors for memory resources and explicit confirmation for bulk retry.
- Hide or mark unavailable features that cannot complete, especially Local only setup.

### Exit criteria

- Every setting shows when it applies.
- Failed provider changes preserve the previous active configuration.
- Setup has no dead-end selectable route.
- A new user can confirm recording readiness without reading documentation.

## Phase E: Memory Differentiation

### Goals

- Make accumulated meeting memory more useful than one-off summaries.

### Work

- Add relationship-aware query views for decision history, person commitments, topic evolution, and linked resources.
- Add source citations and timeline navigation to every memory answer.
- Add periodic, user-triggered synthesis with explicit source lists and no silent overwrite of source facts.
- Add a consent-bound speaker identity program only after primary identity, manual correction, retention, and revocation flows are stable.
- Keep URL resources user-supplied and unfetched by default.

### Exit criteria

- Users can trace any decision, action item, topic statement, or resource to source meetings.
- Agents use the installed Claude skill or read-only MCP without direct file access.
- Speaker identity remains unknown unless consent, evidence, and confidence policy permit attribution.

## Phase F: Beta Operations and Growth

### Goals

- Support a small cohort without exposing users to unrecoverable data loss or unsupported workflows.

### Work

- Define supported macOS, browser, provider, and extension compatibility matrix.
- Define in-app update strategy, initially signed release check and release-page handoff, then automatic updates only after a trusted feed and rollback plan exist.
- Add opt-in aggregate reliability reporting with no audio, transcript, URL, meeting title, attendee, or key data.
- Publish support, vulnerability reporting, release notes, known issues, consent guidance, and data migration documentation.
- Establish beta success metrics: successful capture rate, batch completion rate, live renewal success, integration detection accuracy, and restore success rate.

### Exit criteria

- A signed alpha cohort can upgrade, recover, export, and report issues safely.
- Product claims match validated integrations and release constraints.

## Execution Order

1. Phase A release integrity.
2. Phase B core reliability.
3. Phase C data ownership.
4. Phase D configuration UX.
5. Phase E memory differentiation.
6. Phase F beta operations.

No later phase should claim public readiness while an earlier phase exit criterion remains unmet.
