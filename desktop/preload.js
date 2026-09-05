"use strict";

// The only bridge between the renderer and the main process. It exposes named,
// read-only wiki operations and the reviewed correction actions. No filesystem,
// shell, or generic invoke channel is reachable from the renderer.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meetingWiki", {
  listRecent: (limit) => ipcRenderer.invoke("wiki:listRecent", limit),
  search: (query, limit) => ipcRenderer.invoke("wiki:search", query, limit),
  readPage: (pagePath) => ipcRenderer.invoke("wiki:readPage", pagePath),
  actionItems: (options) => ipcRenderer.invoke("wiki:actionItems", options),
  corrections: {
    inbox: () => ipcRenderer.invoke("corrections:inbox"),
    plan: (meetingKey, mapping) => ipcRenderer.invoke("corrections:plan", meetingKey, mapping),
    apply: (meetingKey, mapping) => ipcRenderer.invoke("corrections:apply", meetingKey, mapping),
  },
});
