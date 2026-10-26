# macOS Release Checklist

Use this list for every downloadable macOS build. A release ships only when
every item is checked. Items marked "script" are enforced by
`scripts/release-macos.sh` and fail closed. The rest need a person to sign off.
Open blockers are tracked in `docs/known-issues.md`.

## 1. Source identity

- [ ] script: Git tree is clean, including untracked files.
- [ ] script: `pyproject.toml`, `desktop/package.json`, and both versions in
      `desktop/package-lock.json` are equal and committed at `HEAD`.
- [ ] script: annotated tag `vVERSION` points at `HEAD` (release mode only).
- [ ] script: candidate builds never reuse a version already tagged on another
      commit.
- [ ] Release notes describe the user-visible changes and link
      `docs/known-issues.md`.

## 2. Legal and notices

- [ ] The release owner has made the GPL and LGPL corresponding-source
      decision for the bundled audio tools (see `docs/portable-runtime.md`).
- [ ] The corresponding source tarballs named by the source offer are
      published or otherwise available as the offer states.
- [ ] script: `MEETING_WIKI_GPL_SOURCE_OFFER` is a non-empty file, and the
      packaged `runtime/licenses/SOURCE-OFFER.txt` matches it.
- [ ] script: project `LICENSE` and `NOTICE` are packaged and match the
      committed files.
- [ ] `NOTICE` accurately identifies CPython, Python distributions, SoX, and
      its linked audio libraries.
- [ ] script: CPython's license, every Python distribution's retained license
      or notice, and every audio component license named by the runtime
      manifest are present in the app.

## 3. Credentials

- [ ] script: a valid Developer ID Application identity is in the keychain.
- [ ] script: notarization credentials work (`notarytool history`).
- [ ] No certificate, `.p8` key, or credential file is inside the repository,
      the build output, logs, or release attachments.

## 4. Artifact contents

- [ ] script: every `build.files` entry is in `app.asar` with committed
      content. The package contract independently requires
      `cli-installer.js` and `skills/meeting-wiki-memory/SKILL.md`.
- [ ] script: every `build.extraResources` file is in `Resources`, with no
      undeclared extras. The package contract independently requires all
      Google Meet extension files, runtime tools, runtime licenses, project
      notices, and the configured app icon.
- [ ] script: `Info.plist` requires macOS 14.2 or later and contains the exact
      microphone, screen-capture, and audio-capture descriptions from
      `desktop/package.json`.
- [ ] script: the build `.app`, the extracted ZIP, and the mounted DMG pass the
      privacy scan (no user data, secret-shaped content, or build host path).
- [ ] script: the DMG contains only `Meeting Wiki.app` and `Applications`.
- [ ] script: `release-manifest.json` and `SHA256SUMS` are written from the
      same commit.

## 5. Signing and Gatekeeper

- [ ] script: `codesign --verify --deep --strict` passes.
- [ ] script: the outer app and every runtime Mach-O file use the same
      Developer ID team, hardened runtime, and secure timestamp.
- [ ] script: the outer app retains the expected JIT and audio-input
      entitlements, and both runtime audio entry points retain audio-input.
- [ ] script: the app and DMG are signed, notarized, stapled, and validated.
- [ ] script: the DMG passes the primary-signature Gatekeeper assessment.
- [ ] script: `spctl --assess` accepts the build app and both unpacked copies.
- [ ] On a second Mac without the developer certificate, the DMG installs and
      opens without removing quarantine or any Gatekeeper bypass.

## 6. First run and uninstall (second Mac)

- [ ] Setup completes, and microphone and system-audio prompts show the
      expected text.
- [ ] A recording captures, processes, and appears in the Desktop Wiki.
- [ ] A private meeting stays out of shared search and integrations.
- [ ] Settings shows the Google Meet extension as bundled, and the Claude
      skill installs from the packaged app.
- [ ] Deleting the app leaves `~/.meeting-wiki` in place (data is retained).
      The uninstall steps in `docs/guide/installation.md` (app, `~/.local/bin`
      shims, Meet host manifests, Keychain "Safe Storage" item) remove what
      they describe.
- [ ] **Install command-line tools...** creates both shims, and
      `meeting-wiki status --summary` works from a new Terminal after adding
      `~/.local/bin` to `PATH`.

## 7. Publication

- [ ] Release mode (not `--candidate`) produced the artifacts.
- [ ] `release-manifest.json` shows `"publishable": true` and the tag commit.
- [ ] Draft GitHub Release has the DMG, ZIP, `release-manifest.json`,
      `SHA256SUMS`, source offer materials, release notes, and a link to
      `docs/known-issues.md`.
- [ ] Downloaded artifacts pass `shasum -a 256 -c SHA256SUMS` and Gatekeeper
      again before publishing.
- [ ] Support instructions point users to `meeting-wiki diagnostics-export`
      (the privacy-safe diagnostic report) and `SECURITY.md` for vulnerability
      reports.
