"use strict";

// Runs on meet.google.com tabs. It answers one question, "is this tab in a call?", by checking
// whether the Leave call control exists. It never reads captions, transcripts, chat, participant
// names, or page history, and it never observes DOM mutations.

const MeetingWikiMeetContent = (() => {
  const PORT_NAME = "meeting-wiki-meet";
  const POLL_MS = 2000;
  const HEARTBEAT_MS = 10_000;
  const RECONNECT_MS = 1000;
  // Two matching checks (about 4 s) before a join or leave is reported.
  const CONFIRM_CHECKS = 2;
  // Meet's leave control: its stable jsname, the English label, and the call_end icon ligature.
  const LEAVE_SELECTORS = Object.freeze([
    'button[jsname="CQylAd"]',
    'button[aria-label="Leave call"]',
    '[role="button"][aria-label="Leave call"]',
  ]);
  const ICON_SELECTOR = "button i.google-material-icons, button i.google-symbols, button i.material-icons-extended";
  const CODE_PATTERN = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/;

  function hasLeaveControl(root) {
    if (LEAVE_SELECTORS.some((selector) => root.querySelector(selector))) return true;
    // Only the icon glyph name inside call buttons is compared, never page text.
    for (const icon of root.querySelectorAll(ICON_SELECTOR)) {
      if (typeof icon.textContent === "string" && icon.textContent.trim() === "call_end") return true;
    }
    return false;
  }

  function meetingCodeFrom(pathname) {
    const match = CODE_PATTERN.exec(typeof pathname === "string" ? pathname : "");
    return match ? match[1] : null;
  }

  function createMonitor({ root, location, connect, timers = globalThis, now = Date.now }) {
    let port = null;
    let joined = false;
    let streak = 0;
    let lastReport = 0;
    let stopped = false;

    function report() {
      lastReport = now();
      if (!port) return;
      try {
        port.postMessage({ type: "state", joined, meetingCode: meetingCodeFrom(location.pathname) });
      } catch (_) {
        port = null;
      }
    }

    function open() {
      if (stopped) return;
      try {
        port = connect();
      } catch (_) {
        // The extension was reloaded or removed; this page's copy can no longer reach it.
        stopped = true;
        port = null;
        return;
      }
      port.onDisconnect.addListener(() => {
        port = null;
        // The service worker restarted; reconnect and resend the current state.
        timers.setTimeout(() => { open(); report(); }, RECONNECT_MS);
      });
    }

    function check() {
      if (stopped) return;
      const present = hasLeaveControl(root);
      if (present === joined) {
        streak = 0;
        if (joined && now() - lastReport >= HEARTBEAT_MS) report();
        return;
      }
      streak += 1;
      if (streak < CONFIRM_CHECKS) return;
      joined = present;
      streak = 0;
      report();
    }

    return {
      start() {
        open();
        report();
        timers.setInterval(check, POLL_MS);
      },
      check,
      get joined() { return joined; },
    };
  }

  return { CONFIRM_CHECKS, HEARTBEAT_MS, LEAVE_SELECTORS, PORT_NAME, createMonitor, hasLeaveControl, meetingCodeFrom };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = MeetingWikiMeetContent;
} else if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.connect === "function") {
  MeetingWikiMeetContent.createMonitor({
    root: document,
    location: window.location,
    connect: () => chrome.runtime.connect({ name: MeetingWikiMeetContent.PORT_NAME }),
  }).start();
}
