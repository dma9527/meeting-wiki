# Live Sidebar and Recovery

[English](live-and-recovery.md) | [简体中文](../zh-CN/guide/live-and-recovery.md)

## Live sidebar

When a recording starts, Meeting Wiki opens a **Meeting Wiki Live** window
beside your meeting. It shows:

- a status line and any live issue;
- a **Private session** badge for private recordings;
- a badge for whether live captions run on this Mac or at an external
  provider;
- **Summary**: a rolling summary that appears after the first few sentences;
- **Transcript and translation**: final transcript lines with a translation
  into the language set in Settings.

Behavior to know:

- Live text is display only. It never changes saved notes. The saved meeting is
  processed from the full recording after you stop.
- Live captions use microphone audio. With an online provider, that audio is
  sent to the provider.
- If live captions cannot start, the menu shows "Live captions unavailable.
  Recording continues." Recording and processing still work.
- Closing the live window stops live captions for that recording. The
  recording itself continues.
- Changes to live settings apply from the next recording. An open live window
  keeps its current setting.
- A private session does not load shared wiki context.

## Processing status

The menu bar shows when meetings are processing or need attention.

**Run self-check...** reports on microphone and system audio permission, batch
transcription and analysis, live captions, storage, the memory index, and the
Claude skill. Each line is fixed text chosen from a status code. Provider error
text, paths, and keys are never shown.

**Open logs** opens the local log folder.

## Recover failed processing

- **Retry failed processing** appears in the menu bar when jobs have failed.
- **Open Wiki & Corrections > Processing recovery** lists failed jobs. Retry
  the ones you choose, or use **Retry all**.
- **Dismiss** hides a failed job without removing its recording, transcript,
  wiki pages, or local diagnostic record. Restore it from **Dismissed jobs**.

From the CLI:

```bash
meeting-wiki status --summary
meeting-wiki status --state dead
meeting-wiki retry 12
meeting-wiki self-check
```

Default status output never includes meeting titles, source paths,
transcripts, or provider error details. Use `status --verbose` only on your own
machine.
