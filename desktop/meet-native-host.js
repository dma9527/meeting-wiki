"use strict";

// Chromium native messaging host for the Google Meet extension. The browser starts it over stdio
// (no socket); it turns each validated join/leave message into one 0600 file in a 0700 spool
// directory that only Meeting Wiki reads. It never logs message contents.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  EXTENSION_ORIGIN,
  MAX_MESSAGE_BYTES,
  validateExtensionMessage,
} = require("./meet-protocol");

// Bounds the spool while Meeting Wiki is not running; the app drops stale files anyway.
const MAX_SPOOL_FILES = 200;

function parseArgs(argv) {
  const index = argv.indexOf("--spool");
  const spoolDir = index >= 0 ? argv[index + 1] : "";
  return { spoolDir, origin: argv.find((arg) => arg.startsWith("chrome-extension://")) || "" };
}

// The spool counts as paired only while it is a private directory owned by this user.
function spoolReady(fsImpl, spoolDir, uid) {
  if (!spoolDir || !path.isAbsolute(spoolDir)) return false;
  try {
    const stat = fsImpl.lstatSync(spoolDir);
    return stat.isDirectory() && (uid === null || stat.uid === uid) && (stat.mode & 0o077) === 0;
  } catch (_) {
    return false;
  }
}

function writeEvent(fsImpl, spoolDir, event, now) {
  if (fsImpl.readdirSync(spoolDir).length >= MAX_SPOOL_FILES) return false;
  const at = now();
  const name = `${at}-${crypto.randomBytes(8).toString("hex")}.json`;
  const temp = path.join(spoolDir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
  fsImpl.writeFileSync(temp, JSON.stringify({ v: 1, ...event, at }), { mode: 0o600, flag: "wx" });
  fsImpl.renameSync(temp, path.join(spoolDir, name));
  return true;
}

// Native messaging frames: a 4-byte little-endian length, then UTF-8 JSON.
function createFrameReader(onMessage, onInvalid) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) {
        onInvalid();
        return;
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch (_) {
        continue;
      }
      onMessage(parsed);
    }
  };
}

function runHost({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  fsImpl = fs,
  now = Date.now,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  exit = (code) => process.exit(code),
} = {}) {
  const { spoolDir, origin } = parseArgs(argv);
  // Chromium passes the caller's origin; allowed_origins already pins it, this is a second check.
  if (origin !== EXTENSION_ORIGIN) {
    exit(1);
    return;
  }
  const read = createFrameReader(
    (message) => {
      const event = validateExtensionMessage(message);
      if (!event || !spoolReady(fsImpl, spoolDir, uid)) return;
      try {
        writeEvent(fsImpl, spoolDir, event, now);
      } catch (_) {}
    },
    () => exit(1),
  );
  stdin.on("data", read);
  stdin.on("end", () => exit(0));
}

if (require.main === module) runHost();

module.exports = { MAX_SPOOL_FILES, createFrameReader, parseArgs, runHost, spoolReady, writeEvent };
