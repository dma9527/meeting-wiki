# Known Limitations

[English](limitations.md) | [简体中文](../zh-CN/guide/limitations.md)

## Release status

- There is no signed or notarized release. Current builds are unsigned local
  test artifacts for the maintainer's own Macs.
- Do not upload them as a GitHub release or send them to other people.
- A public release is blocked on: a Developer ID certificate and notarization,
  a `NOTICE` that matches the bundled runtime, bundled license texts for Python
  packages, a corresponding-source decision for the bundled GPL and LGPL audio
  tools, and verified signing of nested runtime binaries.

Maintainer detail: [known-issues.md](../known-issues.md) and
[releasing-macos.md](../releasing-macos.md).

## Platform

- macOS 14.2 or later on Apple Silicon only. Intel Macs are not supported.
- Unsigned builds need the quarantine flag removed on any Mac other than the
  one that built them.

## Product gaps

- Deletion preview and retention plan only report. There is no delete command.
- Backup, restore, and deletion preview are CLI only.
- Zoom in a web browser is not detected for automatic recording.
- The Google Meet extension must be loaded unpacked once per browser.
- Speaker corrections keep the old label on append-only surfaces (people
  timelines, action-item table) and on external tasks sent before the
  correction.
- Live captions are display only. They label lines as You or Others by audio
  channel, not by individual speaker. Providers without a live adapter (Other
  online API key) have no live captions.
- Gemini live captions open one connection per audio channel, so a meeting with
  system audio uses the live model's quota twice. That quota is small; check it
  in Google AI Studio if captions stop during long meetings.
- Recordings longer than the provider's request limit (20 minutes for Gemini,
  10 minutes for Other online API key) are transcribed in parts. Gemini timing
  inside each part comes from the model and is approximate.
- Local only setup is not available in this build.
- The system audio permission cannot be checked before recording; a missing
  permission shows up as silent participants and a notification.
- The command-line tools find the app only in `/Applications` or
  `~/Applications`. Terminal commands that call a provider need the API key in
  the environment, because the app's saved key is not readable outside it.
- The Keychain item name for the encryption key comes from Electron and has not
  been checked on every build; search Keychain Access for "Safe Storage".
- API keys are not part of backups and must be re-entered after a restore.
- First-run setup, uninstall, and Zoom and Google Meet automatic recording are
  checked by hand on a second Mac. There is no automated end-to-end coverage
  of installed app paths.
