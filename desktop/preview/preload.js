"use strict";

// Preview only: exposes fake bridges under the same names the real preloads use.
const { contextBridge } = require("electron");
const stubs = require("./stubs");

const GLOBALS = {
  wiki: "meetingWiki",
  setup: "meetingWikiSetup",
  settings: "meetingWikiSettings",
  record: "meetingWikiRecord",
  live: "meetingWikiLive",
};

const argument = process.argv.find((value) => value.startsWith("--mw-preview="));
const page = argument ? argument.split("=")[1] : "";
if (GLOBALS[page]) contextBridge.exposeInMainWorld(GLOBALS[page], stubs[page]());
