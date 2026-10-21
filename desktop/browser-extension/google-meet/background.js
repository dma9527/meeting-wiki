"use strict";

// Service worker. Relays join, heartbeat, and leave events from Meet tabs to the Meeting Wiki
// native messaging host. The native connection stays open only while a Meet tab is connected.
// Messages carry an opaque per-tab session ID and the meeting code from the URL, nothing else.

const MeetingWikiMeetBackground = (() => {
  const HOST_NAME = "dev.meetingwiki.meet";
  const PORT_NAME = "meeting-wiki-meet";
  const MEET_ORIGIN = "https://meet.google.com/";
  const CODE_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
  // Lets a final left event flush before the host connection closes.
  const IDLE_CLOSE_MS = 2000;

  function createRelay({ runtime, randomUUID, timers = globalThis }) {
    let nativePort = null;
    let closeTimer = null;
    const tabs = new Map();

    function native() {
      if (nativePort) return nativePort;
      try {
        nativePort = runtime.connectNative(HOST_NAME);
      } catch (_) {
        nativePort = null;
        return null;
      }
      nativePort.onDisconnect.addListener(() => {
        // Reading lastError marks a missing or unpaired host as handled.
        void runtime.lastError;
        nativePort = null;
      });
      return nativePort;
    }

    function send(message) {
      if (closeTimer !== null) {
        timers.clearTimeout(closeTimer);
        closeTimer = null;
      }
      const port = native();
      if (!port) return;
      try {
        port.postMessage(message);
      } catch (_) {
        nativePort = null;
      }
    }

    function closeWhenIdle() {
      if (tabs.size > 0 || !nativePort || closeTimer !== null) return;
      closeTimer = timers.setTimeout(() => {
        closeTimer = null;
        if (tabs.size === 0 && nativePort) {
          nativePort.disconnect();
          nativePort = null;
        }
      }, IDLE_CLOSE_MS);
    }

    function trustedSender(sender) {
      return Boolean(sender) &&
        sender.id === runtime.id &&
        sender.frameId === 0 &&
        typeof sender.url === "string" &&
        sender.url.startsWith(MEET_ORIGIN);
    }

    function onConnect(port) {
      if (port.name !== PORT_NAME || !trustedSender(port.sender)) {
        port.disconnect();
        return;
      }
      const record = { session: randomUUID(), joined: false };
      tabs.set(port, record);
      send({ type: "hello", session: record.session });
      port.onMessage.addListener((message) => {
        if (!message || message.type !== "state" || typeof message.joined !== "boolean") return;
        const meetingCode = typeof message.meetingCode === "string" && CODE_PATTERN.test(message.meetingCode)
          ? message.meetingCode
          : null;
        if (message.joined) {
          send({ type: record.joined ? "heartbeat" : "joined", session: record.session, meetingCode });
          record.joined = true;
        } else if (record.joined) {
          record.joined = false;
          send({ type: "left", session: record.session });
        }
      });
      port.onDisconnect.addListener(() => {
        tabs.delete(port);
        if (record.joined) send({ type: "left", session: record.session });
        closeWhenIdle();
      });
    }

    return { onConnect, get connectedTabs() { return tabs.size; }, get nativeOpen() { return nativePort !== null; } };
  }

  return { HOST_NAME, PORT_NAME, createRelay };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = MeetingWikiMeetBackground;
} else {
  const relay = MeetingWikiMeetBackground.createRelay({
    runtime: chrome.runtime,
    randomUUID: () => crypto.randomUUID(),
  });
  chrome.runtime.onConnect.addListener((port) => relay.onConnect(port));
}
