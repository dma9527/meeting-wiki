# Known Issues

Open issues that affect distributable macOS builds. Items marked "release
blocker" must be closed before any build is published. Remove an item only when
the fix is merged and verified on a release candidate.

## Release blockers

### KI-0: No Developer ID or notarization credentials

`scripts/release-macos.sh` fails closed until a Developer ID Application
certificate and notarization credentials are installed. Until then only local
development builds from `scripts/build-macos.sh` exist, and those must not be
published. See `docs/releasing-macos.md`.

### KI-3: No corresponding-source decision for bundled GPL and LGPL tools

The bundled SoX closure includes GPL and LGPL components. The release owner
must choose and complete one of the paths in `docs/portable-runtime.md`
("Audio tool redistribution blocker"). The release script requires
`MEETING_WIKI_GPL_SOURCE_OFFER` but cannot verify that the offer is honored.

### KI-4: Credentialed signing and notarization remain unverified

`scripts/release-macos.sh` now signs every Mach-O file under
`Resources/runtime` before sealing the outer app. It requires hardened runtime,
a secure timestamp, one Developer ID team across the app and runtime, and the
expected outer-app entitlements. The script also verifies the extracted ZIP
and mounted DMG copies.

No build has passed these checks with a real Developer ID identity and
notarization credentials. A credentialed candidate must pass the full script
and second-Mac installation test before publication.

## Product limitations

### KI-5: First-run, uninstall, and real-meeting integrations are manual checks

Zoom and Google Meet automatic recording, first-run setup, and uninstall data
retention are verified by hand on a second Mac (`docs/release-checklist.md`
section 6). There is no automated end-to-end coverage on installed app paths.

### KI-6: Local development builds are ad-hoc signed

Builds from `scripts/build-macos.sh` are ad-hoc signed and blocked by
Gatekeeper on other Macs. They are for local testing only.
