# Installation

[English](installation.md) | [简体中文](../zh-CN/guide/installation.md)

Requirements: Apple Silicon Mac (M1 or newer) with macOS 14 or later. Intel
Macs are not supported.

There is no signed release. Every current build is an unsigned local test
artifact. Install one only on a Mac you control, and do not redistribute it.

## Build the app

Install the build tools once:

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install uv node sox
```

From the repository root, create the build environment and the app:

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -e '.[dev,gemini]'
printf '%s\n' 'Personal build, not distributed.' > /tmp/meeting-wiki-source-offer.txt
MEETING_WIKI_GPL_SOURCE_OFFER=/tmp/meeting-wiki-source-offer.txt \
  bash scripts/build-macos.sh
```

The build bundles SoX, which includes GPL and LGPL components, so it refuses to
run without `MEETING_WIKI_GPL_SOURCE_OFFER`. The note above is valid only for a
build you keep on your own Mac. See [portable runtime](../portable-runtime.md)
before giving a build to anyone.

Output goes to `desktop/dist/`: a DMG, a ZIP, `SHA256SUMS`, and
`mac-arm64/Meeting Wiki.app`.

## Install

1. If you copied the build to another of your Macs, verify it first:

   ```bash
   grep 'Meeting Wiki-.*-arm64\.dmg$' SHA256SUMS | shasum -a 256 -c -
   ```

   The command must print `OK`.
2. Open the DMG and drag **Meeting Wiki** to **Applications**.
3. On a Mac other than the build Mac, remove the download quarantine flag:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Meeting Wiki.app"
   ```

4. Open Meeting Wiki and continue with [Setup](setup.md).

The app bundles its own Python runtime, Meeting Wiki components, `rec`, and
`sox`. The target Mac does not need Homebrew, Python, Node.js, or a source
checkout.

## Uninstall

```bash
rm -rf "/Applications/Meeting Wiki.app"
```

Your data stays in `~/.meeting-wiki/`. Delete that folder only if you also want
to remove recordings, transcripts, and the wiki. API keys stay in Keychain
Access under "Meeting Wiki".

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Meeting Wiki is damaged and can't be opened" | Run the `xattr` command in step 3. |
| "Meeting Wiki installation damaged" | The bundled runtime is missing. Rebuild. Do not bypass the check. |
| Recording has no system audio | Grant Screen & System Audio Recording, then quit and reopen the app. |
| Build exits with "AUDIO TOOLS BLOCKED" | Set `MEETING_WIKI_GPL_SOURCE_OFFER` as shown above. |
| Build says "Apple Silicon macOS only" | Intel Macs are not supported. |

More detail: [install-macos.md](../install-macos.md).
