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

Then run:

```bash
scripts/release-macos.sh --check
scripts/release-macos.sh
```

The script performs these gates:

1. Installs exact desktop dependencies with `npm ci`.
2. Runs desktop tests.
3. Builds the `.app` with the Developer ID Application identity.
4. Verifies the signature and hardened runtime.
5. Submits a ZIP container to Apple notarization and waits for acceptance.
6. Staples and validates the ticket on the `.app`.
7. Creates final ZIP and DMG artifacts from the stapled app.
8. Submits, staples, and validates the final DMG.
9. Runs Gatekeeper assessment with `spctl`.
10. Writes `SHA256SUMS`.

Successful output is written under:

```text
desktop/dist/release/
```

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
2. Create the signed and notarized artifacts from a clean checkout.
3. Test the artifacts on a second Mac.
4. Create a version tag only after every gate passes.
5. Create a draft GitHub Release.
6. Upload the DMG, ZIP, and `SHA256SUMS`.
7. Verify downloaded checksums and Gatekeeper behavior again.
8. Publish the release.

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
