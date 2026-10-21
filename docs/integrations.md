# Automatic recording for Zoom and Google Meet

Meeting Wiki can start recording when you join a Zoom or Google Meet meeting and
stop, save, and process it when you leave. Both integrations are **off** until
you turn them on in **Settings > Automatic recording** and press **Save
automatic recording**.

## What happens

- **Join:** Meeting Wiki runs the same start as **Start recording...** after
  the record panel: the same capture, time limit, live view, and "Recording
  started" notification. There is no countdown. The tray icon switches to the
  recording icon for the whole recording, which is the notice that it is
  running. An open record panel is closed.
- **Leave:** Meeting Wiki runs the same stop as **Stop and process**. The
  recording is saved and queued for processing.
- **Short meetings:** if the meeting ended within 10 seconds of the recording
  starting, the recording is discarded and not processed, and a "Short meeting
  not kept" notification appears.
- **Title and time:** the recording is queued with the title `Zoom meeting` or
  `Google Meet <meeting code>` and the join time as `--occurred-at`. The title
  is a placeholder, so processing still names the meeting from what was
  discussed or from a matching calendar event, as it does for a manual
  recording with no title.
- **Privacy:** integration recordings are shared (not private), the same as the
  record panel default. Mark sensitive meetings by recording them manually.

Ownership rules:

- An integration never takes over a recording you started yourself, and a
  second integration never takes over one started by the first.
- If you stop or discard an automatic recording yourself, or it hits the time
  limit, leaving the meeting later does nothing. Recording does not restart
  until the next join.
- Turning an integration off stops watching for meetings. It does not stop a
  recording already in progress; stop that one from the tray.
- Quitting Meeting Wiki saves and queues the recording as it does for any
  recording.

Recording consent rules in [PRIVACY.md](../PRIVACY.md) apply to automatic
recordings too. Tell participants before the meeting that you record.

## Zoom (desktop app)

Every 3 seconds, and only while the Zoom integration is on, Meeting Wiki runs
three built-in macOS tools against processes owned by you:

| Check | Tool | Meaning |
| --- | --- | --- |
| Is `zoom.us` running? | `/bin/ps -axo pid=,comm=` | Zoom is open. No other check runs when it is closed. |
| Does Zoom own UDP sockets? | `/usr/sbin/lsof -nP -w -a -iUDP -p <Zoom pids>` | Meeting audio and video. Zoom keeps none open between meetings. |
| Does Zoom hold a display-sleep assertion? | `/usr/bin/pmset -g assertions` | Zoom keeps the screen awake during a meeting. |

The `CptHost` meeting helper process also counts. Any signal while `zoom.us`
runs means "in a meeting". A join needs 2 matching samples in a row (about 6
seconds) and a leave needs 4 (about 12 seconds), so a short network drop does
not split a meeting. A check that fails keeps the last state and retries.

Boundaries:

- Only process names, socket counts, and power assertions of Zoom processes are
  inspected. The socket remote addresses and assertion names are not stored,
  logged, or sent anywhere.
- No Zoom window titles, chat, participants, recordings, or files are read. No
  Accessibility or Screen Recording access is used for detection. No Zoom API
  or account is used.
- Nothing listens on a network port.

Known limits:

- These are heuristics from observed Zoom behavior, not a Zoom interface. A
  Zoom update can change them. They were checked only against an idle Zoom app
  on macOS (no UDP sockets, no assertion, so "not in a meeting"), not yet
  against a live meeting. Confirm with a real meeting after each Zoom update.
- If your network blocks UDP, Zoom falls back to TCP and only the display-sleep
  assertion or `CptHost` can detect the meeting.
- Zoom in a web browser is not detected. Use the Google Meet extension only for
  Meet.
- Zoom Phone calls or Zoom Rooms controls may look like meetings.

## Google Meet (Chromium browsers)

Google Meet runs in a browser, so a small companion extension reports whether a
Meet tab is in a call.

### Setup

1. In Meeting Wiki, open **Settings > Automatic recording**, tick **Record
   Google Meet calls automatically**, and save. This pairs the browser
   connection (below).
2. Click **Show extension folder**. Finder opens the bundled
   `browser-extension/google-meet` folder.
3. In each browser you use for Meet, open its extensions page
   (`chrome://extensions`, `edge://extensions`, or `brave://extensions`), turn
   on **Developer mode**, choose **Load unpacked**, and pick that folder.
4. Open or reload a Meet tab. Settings shows "Extension last checked in at ..."
   once it reaches Meeting Wiki.

### What the extension does

- Permissions: only `nativeMessaging`. A content script runs only on
  `https://meet.google.com/*`, in the top frame.
- Every 2 seconds it checks whether the Leave call control exists (Meet's
  `jsname="CQylAd"` button, an English `aria-label="Leave call"`, or a button
  icon whose glyph name is `call_end`). Two matching checks report a join or
  leave. While joined it repeats the state every 10 seconds as a heartbeat.
- It sends `hello`, `joined`, `heartbeat`, or `left` with a random per-tab
  session ID and the meeting code from the URL path (`abc-defg-hij`).
- It never reads captions, transcripts, chat, participant names, the page
  title, browsing history, cookies, or storage, and it uses no
  `MutationObserver`, network request, or console logging.

### Pairing and the event path

There is no listener. Events reach Meeting Wiki like this:

1. **Pairing** (turning the setting on, and again at each Meeting Wiki start)
   writes a native messaging host manifest named `dev.meetingwiki.meet` into
   each detected browser's `NativeMessagingHosts` folder. Its
   `allowed_origins` contains only
   `chrome-extension://gkcbhkomnjbnkccnclloplaegimhcgcn/`, the fixed ID derived
   from the public key in the extension's `manifest.json`. The browser itself
   refuses to start the host for any other extension.
2. The manifest points to `~/.meeting-wiki/integrations/google-meet/meeting-wiki-meet-host`
   (mode 0700), a two-line script that runs Meeting Wiki's own Electron binary
   in Node mode on the bundled `meet-native-host.js`.
3. The browser starts the host over stdin and stdout. The host checks the
   caller origin again, accepts frames of at most 1 KB, keeps only the fields
   above, stamps its own time, and writes each event as a 0600 file in
   `~/.meeting-wiki/integrations/google-meet/events/` (mode 0700). It writes
   only when that folder exists, is owned by you, and is private, and it keeps
   at most 200 files.
4. Meeting Wiki reads that folder every second, validates every field, and
   deletes each file. Events older than 2 minutes, or queued before the
   integration started, are discarded.

No token, secret, or meeting data appears in any URL, command line, or log.
Access control is the browser's extension-ID pinning plus macOS file
permissions on your home folder: any program already running as you could
write to that folder, as it could start a recording through the tray.

**Turning Google Meet off** removes the host manifests that carry this name,
the host script, and any queued events. The extension stays installed but can
no longer reach Meeting Wiki; remove it from the browser if you like.

### Browser support and automatic-startup constraints

| Browser | Status | Manifest folder under `~/Library/Application Support/` |
| --- | --- | --- |
| Google Chrome, Beta, Dev, Canary | Supported | `Google/Chrome`, `Google/Chrome Beta`, `Google/Chrome Dev`, `Google/Chrome Canary` |
| Chromium | Supported | `Chromium` |
| Microsoft Edge | Supported | `Microsoft Edge` |
| Brave | Supported | `BraveSoftware/Brave-Browser` |
| Arc, Vivaldi, Opera, other Chromium forks | Not supported | Their native messaging folders are not documented consistently; not tested. |
| Safari | Not supported | Safari needs a signed app extension, not a Chromium extension. |
| Firefox | Not supported | Firefox uses a different manifest folder and an `allowed_extensions` key, and this extension is not packaged for it. |

Constraints on starting by itself:

- **One manual step per browser.** The extension is not in the Chrome Web
  Store. Chromium on macOS only installs outside extensions through the store,
  enterprise policy, or **Load unpacked** in Developer mode. Meeting Wiki
  cannot load it for you. A loaded unpacked extension stays loaded across
  browser restarts.
- **The browser must already have a profile folder** when the connection is
  paired. Install or first-run a browser, then restart Meeting Wiki (pairing
  runs again at start) or turn the setting off and on.
- **Meeting Wiki must be running.** The browser starts the host only while a
  Meet tab is open, and the host only queues events. If Meeting Wiki starts
  while you are already in a call, the next heartbeat (within 10 seconds)
  starts the recording mid-meeting.
- **Moving or updating the app** changes the host path. Meeting Wiki repairs
  the host at each start. Run it from `/Applications`; a quarantined copy run
  from Downloads gets a temporary path that breaks after it quits.
- **Incognito and guest windows** are not covered unless you allow the
  extension there in the browser.
- **Policy can block it.** `NativeMessagingBlocklist`, `ExtensionInstallBlocklist`,
  or a disabled Developer mode in managed browsers prevent detection.
- **Service worker restarts** are handled: the tab reconnects and resends its
  state, so a recording continues. If the browser crashes or quits without
  closing the tab, the leave is detected when heartbeats stop, after up to 45
  seconds.
- **Several Meet tabs:** recording runs from the first joined tab until the last
  joined tab leaves.
- **Meet UI changes** can break the Leave call check. The extension then sees no
  join and nothing records automatically; manual recording still works.
- **Electron fuse:** the host relies on Electron's `RunAsNode` fuse, which is on
  by default. A build that turns it off breaks the Meet connection.

## Settings readiness

The Automatic recording panel shows, for each integration:

- Zoom: whether `zoom.us.app` is in `/Applications`, whether `ps`, `lsof`, and
  `pmset` exist, and the watcher state (off, Zoom closed, Zoom open, in a
  meeting, or a check that did not finish).
- Google Meet: whether the extension is bundled, each supported browser found
  with whether its connection is installed, when the extension last checked in
  since Meeting Wiki started, and the watcher state.
- Both: Microphone and Screen & System Audio Recording permission. Without
  system audio, other participants are not recorded.
