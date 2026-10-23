# Live Sidebar and Recovery

[English](live-and-recovery.md) | [简体中文](../zh-CN/guide/live-and-recovery.md)

## Live sidebar

When live captions are enabled for a recording, either by the saved default or
**Start with options...**, and the provider supports them, Meeting Wiki opens
a **Meeting Wiki Live** window beside your meeting. Automatic recordings keep
live features off until recording defaults are saved. With a provider that has
no live adapter (such as Other online API key), no live window opens and
nothing is started for live captions. It shows:

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
- Live captions use your microphone only. Other participants, who come
  through system audio, do not appear in live text; they are in the saved
  meeting. With an online provider, the microphone audio is sent to the
  provider.
- If live captions cannot start, the menu shows "Live captions unavailable.
  Recording continues." Recording and processing still work.
- Closing the live window only hides it. Live captions keep running, and
  **Show live captions** in the menu bar shows the window again. Live captions
  stop when the recording stops.
- With a hand-edited configuration, the window opens only after the live
  process reports that it is listening.
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
- **Open Wiki & Corrections > Processing recovery** lists failed jobs. Each
  card shows a label and the capture time. The label is the meeting title only
  for a shared meeting whose privacy is already decided; otherwise it is a
  fixed label such as "Private recording" or "Recording". Private titles are
  never shown.
- The list refreshes every time you open the view and shows when it was last
  updated. If loading or an action fails, the error stays on screen with a
  **Retry** button.
- Retry the jobs you choose, or use **Retry all**. Retry all, in the window or
  the menu bar, first asks you to confirm the number of jobs.
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
