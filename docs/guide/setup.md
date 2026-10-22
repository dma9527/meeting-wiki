# Setup and API Key

[English](setup.md) | [简体中文](../zh-CN/guide/setup.md)

The first-run wizard opens when you start Meeting Wiki. You can run it again
later from the menu bar with **Run setup...**.

## Choose a processing path

| Path | What it uses | Where meeting data goes |
|---|---|---|
| **Gemini, recommended** | Your Google Gemini API key for transcription, live captions, translation, and summaries | Audio and transcript text are sent to Google |
| **Other online API key** | An OpenAI-compatible endpoint, a transcription model, and a summary and translation model | Audio and transcript text are sent to the endpoint you enter |
| **Local only** | Models downloaded to this Mac | Stays on the Mac; works offline once models are installed, needs disk space |

For an online path you must acknowledge the data-egress notice before the
provider check runs. The wizard shows a data boundary summary of what leaves
the Mac.

## API key handling

- The key is encrypted through macOS Keychain facilities.
- It is never written to `config.toml` or to application logs.
- **Show key** reveals it and hides it again after 20 seconds. **Paste** puts
  clipboard text only into the masked field; pasted text is never logged.

## Permissions

Grant **Microphone** and **Screen & System Audio Recording** when macOS asks
(System Settings, Privacy & Security). Quit and reopen Meeting Wiki after
granting system audio. Then run the connection test and make a short test
recording.

## Changing providers

Running setup again is transactional:

- The new provider is checked with a temporary config first.
- The active key, config, and setup state change only when you press
  **Finish setup** after a passing check.
- A failed check, or closing the window, leaves the current provider working.
- Leave the key field blank to check and keep the key already saved for that
  provider type.
- **Test current setup** checks the active provider without changing it.

## Settings

**Settings...** in the menu bar holds options that do not need a new key:

- Gemini models, including the live transcription model.
- Live translation language (a code such as `zh` or a name such as Japanese)
  and summary context size.
- Maximum recording length.
- Automatic recording for Zoom and Google Meet.

Settings never change a hand-edited `config.toml`. Use **Run setup again** to
change the API key or switch provider.

## Where data lives

Meetings, the wiki, jobs, logs, and private meetings are stored under
`~/.meeting-wiki/` by default. Removing the app does not delete this folder.
