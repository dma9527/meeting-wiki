# Signed macOS Release Runbook

Meeting Wiki source releases are public, but downloadable macOS artifacts must
be signed with Developer ID and notarized by Apple before they are published.
Do not publish artifacts from `scripts/build-macos.sh`; that script is for local
development builds only.

Apple references:

- [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Signing Mac software with Developer ID](https://developer.apple.com/developer-id/)
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

## Current credential gate

A release requires:

1. Active Apple Developer Program membership.
2. A Developer ID Application certificate and its private key.
3. Notarization credentials, either an App Store Connect API key or a local
   `notarytool` keychain profile.

A Developer ID Installer certificate is not required for the current DMG and ZIP
artifacts. It is required only if Meeting Wiki later distributes a signed
installer package.

Check the current machine without building anything:

```bash
scripts/release-macos.sh --check
```

The check fails closed when the signing identity or notarization credentials are
missing or invalid.

## One-time Apple setup

### 1. Create the signing certificate

The Apple Developer Account Holder creates a Developer ID Application
certificate in Certificates, Identifiers & Profiles. Generate a certificate
signing request from the release Mac so the matching private key remains in that
Mac's keychain. Download and install the resulting certificate.

Verify the identity:

```bash
security find-identity -v -p codesigning
```

The output must include a valid identity named like:

```text
Developer ID Application: Example Name (TEAMID)
```

### 2. Configure notarization

Preferred local setup:

```bash
xcrun notarytool store-credentials meeting-wiki-notary \
  --key /secure/path/AuthKey_KEYID.p8 \
  --key-id KEYID \
  --issuer ISSUER_UUID

export APPLE_NOTARY_PROFILE=meeting-wiki-notary
```

Alternatively, provide the API key directly:

```bash
export APPLE_API_KEY_PATH=/secure/path/AuthKey_KEYID.p8
export APPLE_API_KEY_ID=KEYID
export APPLE_API_ISSUER=ISSUER_UUID
```

The `.p8` key and certificate private key must never be copied into this
repository, the project data directory, logs, release artifacts, or issue
attachments.

If multiple Developer ID identities exist, select one explicitly:

```bash
export CSC_NAME='Developer ID Application: Example Name (TEAMID)'
```

## Build the release

Before releasing, update both Python and desktop versions and keep them equal:

- `pyproject.toml`: `project.version`
- `desktop/package.json`: `version`
- `desktop/package-lock.json`: root package version

Then commit the version bump and create the annotated release tag on that
commit before building. The tag name is `v` plus the version, for example
`v0.1.11`:

```bash
git tag -a v0.1.11 -m "Meeting Wiki 0.1.11"
scripts/release-macos.sh --check
scripts/release-macos.sh
```

To build an untagged release candidate for second-Mac testing, pass
`--candidate`. Candidate builds go through every signing and notarization gate,
but the release manifest records `"mode": "candidate"` and
`"publishable": false`. Never upload a candidate as a release.

```bash
scripts/release-macos.sh --check --candidate
scripts/release-macos.sh --candidate
```

The script fails closed before building unless all of these hold:

- The Git tree is clean, including untracked files.
- `pyproject.toml`, `desktop/package.json`, and both versions in
  `desktop/package-lock.json` are equal and committed at `HEAD`.
- Release mode: annotated tag `vVERSION` points at `HEAD`. Candidate mode:
  `vVERSION` does not already point at a different commit.
- `MEETING_WIKI_GPL_SOURCE_OFFER` names a non-empty file supplied by the
  release owner. The script never writes or assumes a source offer.
- A valid Developer ID Application identity and working notarization
  credentials are available.

The build then performs these gates:

1. Runs `scripts/verify-local.sh`.
2. Stages the bundled runtime with `scripts/prepare-runtime-macos.sh`
   (see `docs/portable-runtime.md`).
3. Installs exact desktop dependencies with `npm ci` and runs desktop tests.
4. Builds the `.app` with the Developer ID Application identity and checks
   `Resources/runtime/bin/{python,rec,sox}` with
   `scripts/assert-packaged-runtime.sh`.
5. Inspects the `.app` with `scripts/release_integrity.py`: every
   `build.files` entry is in `app.asar` with the committed content (including
   the Claude skill `skills/meeting-wiki-memory/SKILL.md`), every
   `build.extraResources` file is in `Resources` (including the Google Meet
   extension and the runtime), no undeclared file appears under those
   resources, no user data, secret-shaped content, or build host path is
   present, and the packaged source offer matches
   `MEETING_WIKI_GPL_SOURCE_OFFER`.
6. Verifies the signature and hardened runtime.
7. Notarizes, staples, and validates the `.app`.
8. Creates the final ZIP and DMG from the stapled app, then notarizes,
   staples, and validates the DMG.
9. Runs Gatekeeper assessment with `spctl`.
10. Extracts the final ZIP and attaches the final DMG read-only, repeats the
    step 5 inspection and Gatekeeper assessment on each copy, and checks the
    DMG contains only `Meeting Wiki.app` and the `Applications` link.
11. Re-runs the source preflight and writes `release-manifest.json`.
12. Writes `SHA256SUMS` for the DMG, ZIP, and release manifest.

`release-manifest.json` records the source commit, tag, mode, app version,
staged and packaged runtime tree hashes, Python and dependency lock hashes,
Google Meet extension version, Claude skill hash, `LICENSE` and `NOTICE`
hashes, the source offer hash, and the size and SHA-256 of each artifact. It
contains file names only, never build host paths.

Successful output is written under:

```text
desktop/dist/release/
```

See `docs/release-checklist.md` for the full sign-off list and
`docs/known-issues.md` for open release blockers.

## Independent release verification

Run these checks from a clean clone and on a second Mac that does not contain the
developer certificate:

```bash
codesign --verify --deep --strict --verbose=2 \
  'Meeting Wiki.app'
spctl --assess --type execute --verbose=4 \
  'Meeting Wiki.app'
xcrun stapler validate 'Meeting Wiki.app'
xcrun stapler validate 'Meeting-Wiki-VERSION-ARCH.dmg'
shasum -a 256 -c SHA256SUMS
```

Also verify:

- Gatekeeper opens the app without an unidentified-developer bypass.
- Microphone and system-audio permission prompts contain the expected text.
- Recording, local processing, Desktop Wiki, correction inbox, and private
  meeting isolation work from the packaged app.
- The app bundle contains no config, logs, audio, transcripts, databases,
  model files, API keys, or developer certificate material.

## GitHub release process

1. Run `scripts/verify-local.sh` and the public safety and gitleaks scans.
2. Build a `--candidate` from a clean checkout and test it on a second Mac.
3. Commit any fixes, then create the annotated `vVERSION` tag on the final
   commit. Do not push the tag until step 5 passes.
4. Run `scripts/release-macos.sh` from a clean checkout of that tag.
5. Test the tagged artifacts on a second Mac.
6. Push the tag and create a draft GitHub Release.
7. Upload the DMG, ZIP, `release-manifest.json`, `SHA256SUMS`, and the source
   offer materials.
8. Verify downloaded checksums and Gatekeeper behavior again.
9. Publish the release.

Never replace artifacts under an existing version tag. Fix forward with a new
patch version.

## Public alpha gate

Start with 5 to 10 invited Apple Silicon users. Do not add default telemetry.
Ask users to export the privacy-safe local diagnostic report when a failure
occurs.

Track these aggregate results manually:

- Download to first successful recording time.
- Setup and permission success rate.
- Capture success rate.
- Processing completion and retry rate.
- Processing latency by meeting duration and model.
- Speaker correction rate.
- Weekly reuse and pre-meeting brief usage.
- Private-meeting leakage incidents. The acceptable number is zero.

Move from signed alpha to beta only after the release process is repeatable, no
privacy incident is open, capture success is at least 99 percent, and the team
has reviewed feedback from at least 20 real meetings.
