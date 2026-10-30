# Installation

[English](installation.md) | [简体中文](../zh-CN/guide/installation.md)

Requirements: Apple Silicon Mac (M1 or newer) with macOS 14.2 or later. Intel
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
2. On a Mac other than the build Mac, remove the download quarantine flag from
   the DMG before you open it. Otherwise Finder reports the ad-hoc signed app
   as damaged when you drag it to Applications:

   ```bash
   xattr -d com.apple.quarantine Meeting\ Wiki-*-arm64.dmg
   ```

3. Open the DMG and drag **Meeting Wiki** to **Applications**.
4. On a Mac other than the build Mac, clear any flag left on the installed copy:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Meeting Wiki.app"
   ```

5. Open Meeting Wiki and continue with [Setup](setup.md).

The app bundles its own Python runtime, Meeting Wiki components, `rec`, and
`sox`. The target Mac does not need Homebrew, Python, Node.js, or a source
checkout.

## Command-line tools and MCP

The app bundles the `meeting-wiki` CLI and the `meeting-wiki-mcp` server, but a
clean Mac has no command for them. To add them, choose **Install command-line
tools...** in the menu bar and confirm.

- It writes two small scripts, `meeting-wiki` and `meeting-wiki-mcp`, to
  `~/.local/bin`, readable and runnable only by you.
- It never replaces an existing file. If a file with either name is already
  there with other content, or is a link, it is left unchanged and reported.
- Each script runs the Python inside `/Applications/Meeting Wiki.app` (or
  `~/Applications/Meeting Wiki.app`), found again on every run, so the tools
  keep working after you replace the app with a new build. If the app is not
  there, the script prints an error and exits with status 127.

`~/.local/bin` is not on the default macOS `PATH`. If `meeting-wiki` is not
found, add this line to `~/.zshrc` and open a new Terminal window:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

For an MCP client, use the full path `~/.local/bin/meeting-wiki-mcp` (expanded
to your home folder) as the command.

API keys stay with the app. Read commands such as `memory-search`, `status`,
and the MCP server need no key. Commands that call your provider from the
Terminal, such as `ingest --now` or `worker`, need the key in the environment;
normal processing runs inside the app.

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
|---|---|
| "Meeting Wiki is damaged and can't be opened" | Run the `xattr` commands in steps 2 and 4, then drag the app again. |
| "Meeting Wiki installation damaged" | The bundled runtime is missing. Rebuild. Do not bypass the check. |
| Recording has no system audio | Allow Meeting Wiki under System Audio Recording Only in Screen & System Audio Recording, then quit and reopen the app. Local builds are not signed with a stable identity, so after installing a new build, remove Meeting Wiki from that list and add it again. |
| Build exits with "AUDIO TOOLS BLOCKED" | Set `MEETING_WIKI_GPL_SOURCE_OFFER` as shown above. |
| Build says "Apple Silicon macOS only" | Intel Macs are not supported. |

More detail: [install-macos.md](../install-macos.md).
