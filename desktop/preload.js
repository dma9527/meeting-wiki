"use strict";

// The only bridge between the renderer and the main process. It exposes named wiki
// reads, memory search, decision history, URL resources on shared meetings, and the
// reviewed correction actions. No filesystem, shell, or generic invoke channel is
// reachable from the renderer.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meetingWiki", {
  uiLanguage: () => ipcRenderer.invoke("wiki:uiLanguage"),
  listRecent: (limit) => ipcRenderer.invoke("wiki:listRecent", limit),
  search: (query, limit) => ipcRenderer.invoke("wiki:search", query, limit),
  readPage: (pagePath) => ipcRenderer.invoke("wiki:readPage", pagePath),
  actionItems: (options) => ipcRenderer.invoke("wiki:actionItems", options),
  memory: {
    search: (query, options) => ipcRenderer.invoke("memory:search", query, options),
    decisions: (options) => ipcRenderer.invoke("memory:decisions", options),
    addResource: (input) => ipcRenderer.invoke("memory:addResource", input),
  },
  corrections: {
    inbox: () => ipcRenderer.invoke("corrections:inbox"),
    plan: (meetingKey, mapping) => ipcRenderer.invoke("corrections:plan", meetingKey, mapping),
    apply: (meetingKey, mapping) => ipcRenderer.invoke("corrections:apply", meetingKey, mapping),
  },
  jobs: {
    listDead: () => ipcRenderer.invoke("jobs:listDead"),
    listDismissed: () => ipcRenderer.invoke("jobs:listDismissed"),
    retry: (jobId) => ipcRenderer.invoke("jobs:retry", jobId),
    retryAllDead: () => ipcRenderer.invoke("jobs:retryAllDead"),
    dismiss: (jobId) => ipcRenderer.invoke("jobs:dismiss", jobId),
    restore: (jobId) => ipcRenderer.invoke("jobs:restore", jobId),
  },
});
