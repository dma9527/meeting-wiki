"use strict";

// Renderer logic. It talks to the main process only through window.meetingWiki
// and builds every node with textContent, so wiki content is never interpreted
// as markup.

const api = window.meetingWiki;
const loaded = { recent: false, actions: false, corrections: false };
let lastFocused = null;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "hidden") node.hidden = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(child);
  }
  return node;
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 4000);
}

function failed(result) {
  if (result && typeof result === "object" && "error" in result) {
    toast(result.error);
    return true;
  }
  return false;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function emptyNote(text) {
  return el("p", { class: "list-empty", text });
}

function switchView(view) {
  for (const button of document.querySelectorAll(".rail-item")) {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const section of document.querySelectorAll(".view")) {
    section.hidden = section.id !== `view-${view}`;
  }
  const active = document.getElementById(`view-${view}`);
  if (active) active.focus();
  if (view === "recent" && !loaded.recent) loadRecent();
  if (view === "actions" && !loaded.actions) loadActions();
  if (view === "corrections" && !loaded.corrections) loadCorrections();
}

function openPageButton(pagePath, label) {
  const button = el("button", { class: "card-open", type: "button", text: label || "Open page" });
  button.addEventListener("click", () => openPage(pagePath));
  return button;
}

const DIALOG_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Make everything behind the modal non-focusable and hidden from assistive tech.
function setBackgroundInert(on) {
  for (const node of document.querySelectorAll(".workbench > *")) {
    if (node.id === "page-viewer") continue;
    node.inert = on;
    if (on) node.setAttribute("aria-hidden", "true");
    else node.removeAttribute("aria-hidden");
  }
}

// Keep Tab focus cycling inside the open dialog (WCAG 2.4.3).
function trapDialogFocus(event) {
  if (event.key !== "Tab") return;
  const viewer = document.getElementById("page-viewer");
  if (viewer.hidden) return;
  const focusable = Array.from(viewer.querySelectorAll(DIALOG_FOCUSABLE));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function openPage(pagePath) {
  const page = await api.readPage(pagePath);
  if (failed(page)) return;
  lastFocused = document.activeElement;
  document.getElementById("page-title").textContent = page.path || pagePath;
  document.getElementById("page-content").textContent =
    page.content + (page.truncated ? "\n\n… (truncated)" : "");
  const viewer = document.getElementById("page-viewer");
  viewer.hidden = false;
  setBackgroundInert(true);
  document.getElementById("page-close").focus();
}

function closePage() {
  document.getElementById("page-viewer").hidden = true;
  setBackgroundInert(false);
  if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
}

async function loadRecent() {
  const list = document.getElementById("recent-list");
  const result = await api.listRecent(20);
  if (failed(result)) return;
  loaded.recent = true;
  clear(list);
  if (result.items.length === 0) {
    list.appendChild(emptyNote("No meetings yet. Record or import one to get started."));
    return;
  }
  for (const meeting of result.items) {
    const card = el("article", { class: "card" }, [
      el("h3", { class: "card-title", text: meeting.title }),
      el("p", { class: "card-meta", text: `${meeting.meeting_type} · ${meeting.timestamp}` }),
    ]);
    if (meeting.description) card.appendChild(el("p", { text: meeting.description }));
    card.appendChild(openPageButton(meeting.path, "Open meeting"));
    list.appendChild(card);
  }
}

async function runSearch() {
  const query = document.getElementById("search-input").value.trim();
  const list = document.getElementById("search-results");
  clear(list);
  if (query.length < 2) {
    list.appendChild(emptyNote("Type at least two characters."));
    return;
  }
  const result = await api.search(query, 20);
  if (failed(result)) return;
  if (result.items.length === 0) {
    list.appendChild(emptyNote(`No pages match “${query}”.`));
    return;
  }
  for (const hit of result.items) {
    const card = el("article", { class: "card" }, [
      el("h3", { class: "card-title", text: hit.title }),
      el("p", { class: "card-meta", text: hit.path }),
    ]);
    for (const snippet of hit.snippets) {
      card.appendChild(el("p", { class: "snippet", text: snippet.text }));
    }
    card.appendChild(openPageButton(hit.path, "Open page"));
    list.appendChild(card);
  }
}

function parseActionRow(row) {
  const columns = row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  return {
    owner: columns[0] || "Unassigned",
    action: columns[1] || "",
    source: columns[2] || "",
    due: columns[3] || "",
  };
}

function sourcePath(source) {
  const match = source.match(/\[\[(meetings\/[^\]]+)\]\]/);
  return match ? `${match[1]}.md` : null;
}

async function loadActions() {
  const list = document.getElementById("actions-list");
  const result = await api.actionItems({ limit: 100 });
  if (failed(result)) return;
  loaded.actions = true;
  clear(list);
  if (result.items.length === 0) {
    list.appendChild(emptyNote("No open action items."));
    return;
  }
  for (const raw of result.items) {
    const item = parseActionRow(raw);
    const row = el("div", { class: "action-row" }, [
      el("span", { class: "action-owner", text: item.owner }),
      el("span", { text: item.action }),
      el("span", { class: "action-due", text: item.due || "no due date" }),
    ]);
    const card = el("article", { class: "card" }, [row]);
    const path = sourcePath(item.source);
    if (path) card.appendChild(openPageButton(path, "Open source meeting"));
    list.appendChild(card);
  }
}

function renderCorrectionCard(entry) {
  const card = el("article", { class: "card" }, [
    el("h3", { class: "card-title", text: entry.title }),
    el("p", { class: "card-meta", text: entry.timestamp || entry.meeting_key }),
  ]);
  const inputs = new Map();
  for (const label of entry.labels) {
    const inputId = `rename-${entry.meeting_key}-${label.label}`.replace(/[^\w-]/g, "-");
    const field = el("input", { type: "text", id: inputId, placeholder: "Correct name" });
    inputs.set(label.label, field);
    card.appendChild(
      el("div", { class: "rename-row" }, [
        el("label", { for: inputId }, [
          el("span", { class: "label-chip", text: `${label.label} (${label.segments})` }),
        ]),
        field,
      ]),
    );
  }

  const planBox = el("div", { class: "plan-box", hidden: true });
  const reprocess = el("button", { class: "primary", type: "button", text: "Reprocess", disabled: "" });

  function collectMapping() {
    const mapping = {};
    for (const [label, field] of inputs) {
      const value = field.value.trim();
      if (value) mapping[label] = value;
    }
    return mapping;
  }

  const preview = el("button", { type: "button", text: "Preview plan" });
  preview.addEventListener("click", async () => {
    const mapping = collectMapping();
    if (Object.keys(mapping).length === 0) {
      toast("Enter at least one corrected name.");
      return;
    }
    const plan = await api.corrections.plan(entry.meeting_key, mapping);
    if (failed(plan)) return;
    renderPlan(planBox, plan);
    planBox.hidden = false;
    reprocess.disabled = false;
    reprocess.dataset.mapping = JSON.stringify(mapping);
  });

  reprocess.addEventListener("click", async () => {
    const mapping = JSON.parse(reprocess.dataset.mapping || "{}");
    reprocess.disabled = true;
    const result = await api.corrections.apply(entry.meeting_key, mapping);
    if (result && result.error === "original_job_unavailable") {
      toast("Original job is no longer available; cannot reprocess this meeting.");
      reprocess.disabled = false;
      return;
    }
    if (result && result.error === "original_source_unavailable") {
      toast("The original audio or transcript is no longer available; cannot reprocess.");
      reprocess.disabled = false;
      return;
    }
    if (failed(result)) {
      reprocess.disabled = false;
      return;
    }
    toast(`Reprocessing queued (job ${result.job_id}). The old label stays on shared surfaces.`);
    loaded.corrections = false;
    loadCorrections();
  });

  card.appendChild(el("div", { class: "correction-actions" }, [preview, reprocess]));
  card.appendChild(planBox);
  return card;
}

function renderPlan(box, plan) {
  clear(box);
  box.appendChild(el("p", { text: "Reprocessing this meeting will:" }));
  const clean = el("ul");
  for (const key of plan.clean_surfaces || []) {
    clean.appendChild(el("li", { text: `Rewrite ${key} with the corrected names.` }));
  }
  box.appendChild(clean);
  const limitation = el("div", { class: "limitation" }, [
    el("strong", { text: "Limitation: " }),
    el("span", {
      text:
        "the deterministic renderer never deletes content it did not load, and re-analysis is " +
        "non-deterministic. The old label is kept on append-only surfaces below and must be " +
        "cleaned manually.",
    }),
  ]);
  const stale = plan.stale_surfaces || [];
  if (stale.length > 0) {
    const staleList = el("ul");
    for (const surface of stale) {
      staleList.appendChild(
        el("li", { text: `${surface.key} keeps ${surface.count} “${surface.label}” entr${surface.count === 1 ? "y" : "ies"}.` }),
      );
    }
    limitation.appendChild(staleList);
  }
  box.appendChild(limitation);
}

async function loadCorrections() {
  const list = document.getElementById("corrections-list");
  const badge = document.getElementById("corrections-count");
  const result = await api.corrections.inbox();
  if (failed(result)) return;
  loaded.corrections = true;
  clear(list);
  const entries = Array.isArray(result) ? result : [];
  badge.hidden = entries.length === 0;
  badge.textContent = String(entries.length);
  if (entries.length === 0) {
    list.appendChild(emptyNote("No ambiguous speaker labels. Everything is attributed."));
    return;
  }
  for (const entry of entries) list.appendChild(renderCorrectionCard(entry));
}

async function refreshBadge() {
  const result = await api.corrections.inbox();
  if (failed(result)) return;
  const entries = Array.isArray(result) ? result : [];
  const badge = document.getElementById("corrections-count");
  badge.hidden = entries.length === 0;
  badge.textContent = String(entries.length);
}

function init() {
  if (!api) {
    document.body.appendChild(emptyNote("Bridge unavailable. Reopen the window."));
    return;
  }
  for (const button of document.querySelectorAll(".rail-item")) {
    button.addEventListener("click", () => switchView(button.dataset.view));
  }
  document.getElementById("search-button").addEventListener("click", runSearch);
  document.getElementById("search-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") runSearch();
  });
  document.getElementById("page-close").addEventListener("click", closePage);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("page-viewer").hidden) closePage();
  });
  document.addEventListener("keydown", trapDialogFocus);
  loadRecent();
  refreshBadge();
}

document.addEventListener("DOMContentLoaded", init);
