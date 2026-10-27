# Installing Meeting Wiki on Another Mac

Two ways to install on Macs you control. Use A when copying a local test build
you made to another Mac you own. Use B when you only have the source code.

Requirements for both: Apple Silicon Mac (M1 or newer), macOS 14.2 or newer.

## A. Install a prebuilt app

The current builds are not signed with a Developer ID or notarized, so macOS
blocks them on first launch. They are local test artifacts and must not be
given to other people or published while the release blockers remain open.

1. Copy `Meeting Wiki-VERSION-arm64.dmg` (or the `.zip`) and `SHA256SUMS` to the
   Mac. Replace `VERSION` with the version you built. Check the file was not changed in transit:

   Run the matching command from the folder that contains the artifact and
   `SHA256SUMS`.

   For the DMG:

   ```bash
   grep 'Meeting Wiki-VERSION-arm64\.dmg$' SHA256SUMS | shasum -a 256 -c -
   ```

   For the ZIP:

   ```bash
   grep 'Meeting Wiki-VERSION-arm64-mac\.zip$' SHA256SUMS | shasum -a 256 -c -
   ```

   The command must print `OK`.

2. Remove the download quarantine flag from the downloaded file before you
   open it. This build is ad-hoc signed, so on another Mac Finder reports the
   app as damaged when you drag it out of a quarantined DMG:

   ```bash
   xattr -d com.apple.quarantine "Meeting Wiki-VERSION-arm64.dmg"
   ```

   For the ZIP, run the same command on `Meeting Wiki-VERSION-arm64-mac.zip`.

3. Open the DMG and drag **Meeting Wiki** to **Applications**. For the ZIP,
   double-click it and move `Meeting Wiki.app` to `/Applications`.

4. Clear any flag left on the installed copy, for example after AirDrop:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Meeting Wiki.app"
   ```

5. Open the app. The app bundles Python, its dependencies, and SoX, so you do
   not need Homebrew, Python, or Node.js.

6. Complete first-run setup:
   - Choose a storage location (default `~/.meeting-wiki`).
   - Choose an online provider and paste your API key. The key is encrypted
     with Electron safeStorage and saved in `secrets.json` in the storage
     folder; the key that decrypts it is kept in the macOS Keychain. It is
     never written to `config.toml` or logs. Local only is not available in
     this build.
   - Grant **Microphone** and **Screen & System Audio Recording** permission
     when prompted (System Settings, Privacy & Security). Quit and reopen the
     app after granting system audio.
   - Run the configuration test.

7. Start a short test recording, stop it, and confirm the meeting appears in
   the Desktop Wiki.

If the app says "installation damaged", the bundle is missing its runtime.
Rebuild the artifact on the source Mac.

## B. Build from source on the target Mac

Install the build tools once:

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install uv node sox
```

Get the source, then build:

```bash
cd meeting-wiki
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -e '.[dev,gemini]'
MEETING_WIKI_GPL_SOURCE_OFFER=/path/to/SOURCE-OFFER.txt scripts/build-macos.sh
```

`MEETING_WIKI_GPL_SOURCE_OFFER` must point to a non-empty text file. SoX and
some of its libraries are GPL/LGPL, so the build refuses to bundle them
without it. For a build you only run on your own Macs, a short note such as
"Personal build, not distributed" is enough. Do not give this build to anyone
else or publish it. A future distributable build must close every blocker in
`docs/known-issues.md`, including the corresponding-source requirements in
`docs/portable-runtime.md`.

The build writes:

```text
desktop/dist/Meeting Wiki-0.1.19-arm64.dmg
desktop/dist/Meeting Wiki-0.1.19-arm64-mac.zip
desktop/dist/SHA256SUMS
desktop/dist/mac-arm64/Meeting Wiki.app
```

Then follow section A from step 3. Steps 2 and 4 are not needed for an app
you built on the same Mac.

## Command-line tools

Choose **Install command-line tools...** in the menu bar to add
`meeting-wiki` and `meeting-wiki-mcp` to `~/.local/bin`. See
[installation](guide/installation.md#command-line-tools-and-mcp) for the
`PATH` line and what the tools can do without the app's API key.

## Uninstall

1. Quit Meeting Wiki, then remove the app:

   ```bash
   rm -rf "/Applications/Meeting Wiki.app"
   ```

2. If you installed the command-line tools, remove them:

   ```bash
   rm -f ~/.local/bin/meeting-wiki ~/.local/bin/meeting-wiki-mcp
   ```

3. If you turned on Google Meet automatic recording, turn it off in Settings
   first, or remove `dev.meetingwiki.meet.json` from each browser's
   `NativeMessagingHosts` folder under `~/Library/Application Support/`.
4. If you installed the Claude skill, remove
   `~/.claude/skills/meeting-wiki-memory/`.

Your data stays in the storage folder (default `~/.meeting-wiki/`). That folder
also holds `secrets.json`, the encrypted API keys. Delete the folder only if you
also want to remove recordings, transcripts, the wiki, and the saved keys.

The key that decrypts `secrets.json` stays in the macOS Keychain. To remove it,
open Keychain Access, search for "Safe Storage", and delete the Meeting Wiki
item (normally "Meeting Wiki Safe Storage"). Without that item, a kept
`secrets.json` cannot be decrypted, and setup asks for the key again.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Meeting Wiki is damaged and can't be opened" | Run the `xattr` commands in steps A2 and A4, then drag the app again. |
| "Meeting Wiki installation damaged" | The bundled runtime is missing. Rebuild the artifact on the source Mac. |
| Recording has no system audio | Grant Screen & System Audio Recording, then restart the app. |
| Build exits with "AUDIO TOOLS BLOCKED" | Set `MEETING_WIKI_GPL_SOURCE_OFFER` as shown in B. |
| Build says "Apple Silicon macOS only" | Intel Macs are not supported. |
