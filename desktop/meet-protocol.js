"use strict";

// Shared contract between the Google Meet extension, the native messaging host, and the app.
// The extension ID is derived from the public key in browser-extension/google-meet/manifest.json.

const NATIVE_HOST_NAME = "dev.meetingwiki.meet";
const EXTENSION_ID = "gkcbhkomnjbnkccnclloplaegimhcgcn";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

const EVENT_TYPES = Object.freeze(["hello", "joined", "heartbeat", "left"]);
const SESSION_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const MEETING_CODE_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
// One extension message or spool file is a few dozen bytes; anything larger is rejected.
const MAX_MESSAGE_BYTES = 1024;
const SPOOL_FILE_PATTERN = /^\d{13}-[a-f0-9]{16}\.json$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Returns the fields kept from an extension message, or null. Unknown keys are dropped.
function validateExtensionMessage(message) {
  if (!isPlainObject(message)) return null;
  const { type, session, meetingCode } = message;
  if (!EVENT_TYPES.includes(type) || typeof session !== "string" || !SESSION_PATTERN.test(session)) return null;
  const event = { type, session };
  if (meetingCode !== undefined && meetingCode !== null) {
    if (typeof meetingCode !== "string" || !MEETING_CODE_PATTERN.test(meetingCode)) return null;
    event.meetingCode = meetingCode;
  }
  return event;
}

// Spool files are written by the host with its own clock; the app re-validates every field.
function validateSpoolEvent(value) {
  if (!isPlainObject(value) || value.v !== 1 || !Number.isSafeInteger(value.at) || value.at <= 0) return null;
  const event = validateExtensionMessage(value);
  return event ? { ...event, at: value.at } : null;
}

module.exports = {
  EVENT_TYPES,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  MAX_MESSAGE_BYTES,
  MEETING_CODE_PATTERN,
  NATIVE_HOST_NAME,
  SESSION_PATTERN,
  SPOOL_FILE_PATTERN,
  validateExtensionMessage,
  validateSpoolEvent,
};
