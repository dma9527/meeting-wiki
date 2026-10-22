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

### KI-1: NOTICE does not describe the bundled runtime

`NOTICE` states that SoX is not bundled. The packaged app bundles SoX, its
GPL and LGPL libraries, a CPython runtime, and Python packages under
`Resources/runtime`. The release owner must reconcile `NOTICE` with
`Resources/runtime/manifest.json` before publishing.

### KI-2: Runtime license texts cover only the audio tools

`Resources/runtime/licenses` contains license files from the Homebrew SoX
closure and the source offer. License texts for CPython and the bundled Python
packages are recorded by name in `runtime/manifest.json` but not copied into
`licenses/`.

### KI-3: No corresponding-source decision for bundled GPL and LGPL tools

The bundled SoX closure includes GPL and LGPL components. The release owner
must choose and complete one of the paths in `docs/portable-runtime.md`
("Audio tool redistribution blocker"). The release script requires
`MEETING_WIKI_GPL_SOURCE_OFFER` but cannot verify that the offer is honored.

### KI-4: Signing of nested runtime binaries is unverified

`scripts/release-macos.sh` re-signs the app with
`codesign --force --deep --sign` after electron-builder. This has not run with
a Developer ID identity. Two risks need verification on the first credentialed
run:

- Re-signing without `--options runtime` may drop the hardened runtime flag, in
  which case the script's hardened-runtime check fails.
- `Resources/runtime` Mach-O files (`python`, `sox`, dylibs) are ad-hoc signed
  during staging. Apple notarization requires every executable to carry a
  Developer ID signature with hardened runtime and a secure timestamp.

The script fails closed on both, but no notarized build exists yet.

## Product limitations

### KI-5: First-run, uninstall, and real-meeting integrations are manual checks

Zoom and Google Meet automatic recording, first-run setup, and uninstall data
retention are verified by hand on a second Mac (`docs/release-checklist.md`
section 6). There is no automated end-to-end coverage on installed app paths.

### KI-6: Local development builds are ad-hoc signed

Builds from `scripts/build-macos.sh` are ad-hoc signed and blocked by
Gatekeeper on other Macs. They are for local testing only.
