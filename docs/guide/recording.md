# Recording

[English](recording.md) | [简体中文](../zh-CN/guide/recording.md)

Meeting Wiki records your microphone and macOS system audio. You are
responsible for telling participants and getting any consent the law, your
workplace, or the platform requires. Read [PRIVACY.md](../../PRIVACY.md).

## Manual recording

1. In the menu bar, choose **Start recording...** or press Cmd+Shift+0.
2. The confirmation panel opens. Choose **Shared wiki** or **Private**, and
   optionally enter a title. The panel also shows capture permissions, where
   audio is processed, the length limit, and live caption readiness. Nothing is
   recorded until you confirm.

   **Start recording** is disabled, with a button to fix it, when:
   - setup is not finished (**Open setup**), or
   - microphone access is denied or restricted (**Open Microphone
     settings**).

   macOS does not let Meeting Wiki check the system audio permission in
   advance, so the panel never says it is ready. **Open System Audio
   settings** opens the right pane if participants were silent before.
3. While recording, the menu shows elapsed time against the limit.
4. Finish with one of:
   - **Stop and process** (Cmd+Shift+0): saves the audio and queues it for
     transcription and analysis.
   - **Stop and discard**: stops and deletes the capture.

### Length limit

Recording stops on its own at the maximum length, then saves and processes the
meeting the same way as a manual stop. The default is 120 minutes. Change it
in **Settings... > Recording length** (15 to 480 minutes).

### Import existing audio

**Import audio...** queues an audio file you already have. It asks the same
Shared or Private question for each import.

## Private meetings

A private meeting:

- writes only to `private/`;
- does not update shared people, topics, decisions, action items, indexes, or
  logs;
- is never mirrored to S3;
- is never returned by MCP;
- does not trigger task providers.

## Automatic recording (Zoom and Google Meet)

Turn this on in **Settings... > Automatic recording**. Both integrations are
off until you enable them.

- Recording starts when you join and stops, saves, and processes when you
  leave.
- There is no countdown. The tray icon switches to the recording icon and a
  "Recording started" notification appears.
- A meeting that ends within 10 seconds is discarded, not processed.
- Automatic recording uses the same setup check as the record panel. It does
  not start while setup is unfinished.

**Where automatic recordings go.** Choose one option in Settings:

| Option | Result |
|---|---|
| **Private** (default for new installs) | Always private. |
| **Follow my calendar** | Shared only when a calendar event matches the recording start and the calendar does not mark it private. No calendar, or no matching event, means private. The decision is made once, before any wiki write, and kept on retries. |
| **Shared wiki** | Shared unless the calendar or the title marks the meeting private. This is how earlier versions behaved. |

If you already had automatic recording turned on before this setting existed,
Meeting Wiki keeps the earlier behavior (shared) and Settings shows a notice
until you choose an option and save. Your earlier choice is never changed for
you.

**Zoom app.** Every 3 seconds Meeting Wiki checks, on this Mac only, whether
the Zoom app is running, has meeting audio connections open, or is keeping the
display awake (`ps`, `lsof`, `pmset`). It does not read Zoom windows, chat,
participants, or titles, and does not use Accessibility access. Zoom in a web
browser is not detected.

**Google Meet** in Chrome, Edge, Brave, or Chromium. This needs the bundled
extension:

1. In Settings, choose **Show extension folder**.
2. In the browser extensions page, turn on Developer mode, choose **Load
   unpacked**, and pick that folder. Do this once per browser.

The extension only checks whether a meet.google.com tab shows the Leave call
button and reports joined or left with the meeting code. It cannot read
captions, transcripts, chat, participants, or browsing history. Events reach
Meeting Wiki through a native messaging host and a private folder on the Mac,
never a network port.

Full signal list: [integrations.md](../integrations.md).
