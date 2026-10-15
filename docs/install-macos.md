# Installing Meeting Wiki on Another Mac

Two ways to install. Use A when someone hands you a built `.dmg` or `.zip`.
Use B when you only have the source code.

Requirements for both: Apple Silicon Mac (M1 or newer), macOS 14 or newer.

## A. Install a prebuilt app

The current builds are not signed with a Developer ID or notarized, so macOS
blocks them on first launch. Only install builds you received directly from
the person who built them.

1. Copy `Meeting Wiki-0.1.0-arm64.dmg` (or the `.zip`) and `SHA256SUMS` to the
   Mac. Check the file was not changed in transit:

   ```bash
   shasum -a 256 -c SHA256SUMS
   ```

   Every line must end in `OK`. The line for whichever file you did not copy
   reports missing; that is fine.

2. Open the DMG and drag **Meeting Wiki** to **Applications**. For the ZIP,
   double-click it and move `Meeting Wiki.app` to `/Applications`.

3. Remove the download quarantine flag. Without this, macOS reports the app
   as damaged:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Meeting Wiki.app"
   ```

4. Open the app. The app bundles Python, its dependencies, and SoX, so you do
   not need Homebrew, Python, or Node.js.

5. Complete first-run setup:
   - Choose a storage location (default `~/.meeting-wiki`).
   - Choose an online provider and paste your API key. The key is stored in
     the macOS Keychain, not in any file.
   - Grant **Microphone** and **Screen & System Audio Recording** permission
     when prompted (System Settings, Privacy & Security). Quit and reopen the
     app after granting system audio.
   - Run the configuration test.

6. Start a short test recording, stop it, and confirm the meeting appears in
   the Desktop Wiki.

If the app says "installation damaged", the bundle is missing its runtime.
Ask for a fresh build.

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
"Personal build, not distributed" is enough. Before giving the build to
anyone else, read `docs/portable-runtime.md` ("Audio tool redistribution
blocker").

The build writes:

```text
desktop/dist/Meeting Wiki-0.1.0-arm64.dmg
desktop/dist/Meeting Wiki-0.1.0-arm64-mac.zip
desktop/dist/SHA256SUMS
desktop/dist/mac-arm64/Meeting Wiki.app
```

Then follow section A from step 2. Step 3 is not needed for an app you built
on the same Mac.

## Uninstall

```bash
rm -rf "/Applications/Meeting Wiki.app"
```

Your recordings, wiki, and settings stay in the storage folder you chose
(default `~/.meeting-wiki`). Delete that folder only if you also want to
remove your data. API keys stay in Keychain Access under "Meeting Wiki".

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Meeting Wiki is damaged and can't be opened" | Run the `xattr` command in step A3. |
| "Meeting Wiki installation damaged" | The bundled runtime is missing. Rebuild or get a fresh build. |
| Recording has no system audio | Grant Screen & System Audio Recording, then restart the app. |
| Build exits with "AUDIO TOOLS BLOCKED" | Set `MEETING_WIKI_GPL_SOURCE_OFFER` as shown in B. |
| Build says "Apple Silicon macOS only" | Intel Macs are not supported. |
