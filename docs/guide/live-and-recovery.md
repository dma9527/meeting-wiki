# Live Sidebar and Recovery

[English](live-and-recovery.md) | [简体中文](../zh-CN/guide/live-and-recovery.md)

## Live sidebar

When live captions are enabled for a recording, either by the saved default or
**Start with options...**, and the provider supports them, Meeting Wiki opens
a **Meeting Wiki Live** window beside your meeting. Automatic recordings keep
live features off until recording defaults are saved. Automatic recordings
start live after the 10-second short-meeting discard window. With a provider
that has no live adapter (such as Other online API key), no live window opens
and nothing is started for live captions. Provider, audio, startup, and
connection failures show a fixed notification while recording and batch
processing continue. A missing key pauses provider processing, and a missing
runtime prevents queueing until the app is repaired. It shows:

- a status line and any live issue;
- a **Private session** badge for private recordings;
- a badge for whether live captions run on this Mac or at an external
  provider;
- **Summary**: a rolling summary in the live-summary language selected in Settings;
- **Transcript and translation**: final transcript lines with a translation
  into the live-translation language selected in Settings.

Behavior to know:

- Live text is display only. It never changes saved notes. The saved meeting is
  processed from the full recording after you stop.
- Live captions transcribe two channels: your microphone, labeled **You**,
  and all audio played on this Mac, including other participants, labeled
  **Others**. The rolling summary covers both. With an online provider, both audio channels and the
  transcript text are sent to the provider, including for private
  recordings. Each channel uses its own provider connection, so live usage
  is about twice that of a single channel.
- If system audio is not available, live keeps captioning your microphone.
  When system audio stays completely silent for 30 seconds, the live window
  suggests checking System Audio Recording permission. A quiet meeting can
  show the same hint.
- A dropped live provider connection is retried a few times before live stops.
  The reason for a live failure, without any meeting content, is written to
  `live.log` in the Meeting Wiki logs folder.
- **Run self-check...** opens one short live session with silent audio. When
  the provider rejects it, the dialog shows the error codes, for example a
  WebSocket close code and provider status.
- If live features cannot start, the menu shows "Live captions, translation,
  and summary unavailable. Recording continues." Provider, audio, startup, and
  connection failures do not stop recording or batch processing. A missing key
  pauses provider processing, and a missing runtime prevents queueing until the
  app is repaired.
- Closing the live window only hides it. Live captions keep running, and
  **Show live captions** in the menu bar shows the window again. Live captions
  stop when the recording stops.
- With a hand-edited configuration, the window opens only after the live
  process reports that it is listening.
- Changes to live settings apply from the next recording. An open live window
  keeps its current setting.
- A private session does not load shared wiki context.

## Processing status

The menu bar icon stays the same. While recording, the elapsed time appears
next to it. Processing status is shown in the menu.

**Run self-check...** reports on microphone and system audio permission, batch
transcription and analysis, live captions, storage, the memory index, and the
Claude skill. Each line is fixed text chosen from a status code. Provider error
text, paths, and keys are never shown. macOS has no way to read the System
Audio Recording Only permission, so system audio shows as Allowed only when
full Screen & System Audio Recording is granted. Otherwise it shows a note,
not an error.

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
- [Job states and recovery actions](../reference/job-states.md) lists every
  state, what the app does on its own, and what you can do, including what to
  try when jobs wait or a job seems stuck.

From the CLI:

```bash
meeting-wiki status --summary
meeting-wiki status --state dead
meeting-wiki retry 12
meeting-wiki self-check
meeting-wiki diagnostics-export --output ~/Desktop/meeting-wiki-diagnostics.json
```

`diagnostics-export` writes a privacy-safe report you can attach to a bug
report. It contains the app and OS version, which providers are selected,
local storage and memory state, job counts and fixed failure codes, recent
event codes, and recent live connection error codes. Event and log times are
included, so the report shows when you were using the app. It never contains
meeting titles, transcripts, attendees, URLs, file paths, error text, or keys.

The export runs offline. It contacts no provider, so it does not test your
connection; use **Run self-check...** for that. It opens your databases
read-only (SQLite may add its own `-wal` and `-shm` helper files next to a
database that is in use), refuses to overwrite a file, and writes nothing if
any value is not an allowed code. A source it cannot read is reported as
`unreadable` rather than as empty. Read the file before you share it.

Default status output never includes meeting titles, source paths,
transcripts, or provider error details. Use `status --verbose` only on your own
machine.
