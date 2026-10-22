"use strict";

// Renderer logic. It talks to the main process only through window.meetingWiki
// and builds every node with textContent, so wiki content is never interpreted
// as markup.

const api = window.meetingWiki;
const loaded = { recent: false, actions: false, corrections: false, recovery: false };
let lastFocused = null;
let recoveryBusy = false;

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
  if (view === "recovery" && !loaded.recovery) loadRecovery();
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

const MEMORY_TYPE_LABELS = {
  meeting: "Meeting",
  person: "Person",
  topic: "Topic",
  decision: "Decision",
  action_item: "Action item",
  transcript_segment: "Transcript line",
  resource: "Resource",
};

const RESOURCE_RELATION_LABELS = {
  reference: "Reference",
  design_doc: "Design doc",
  ticket: "Ticket",
  code_review: "Code review",
  notes: "Notes",
  follow_up: "Follow-up",
};

let resourceFormCount = 0;

// Inline form for a shared meeting. The link is shown as text only; nothing opens or fetches it.
function resourceForm(item) {
  resourceFormCount += 1;
  const prefix = `resource-${resourceFormCount}`;
  const field = (id, label, control) =>
    el("div", { class: "resource-field" }, [el("label", { for: id, text: label }), control]);
  const url = el("input", { id: `${prefix}-url`, type: "url", autocomplete: "off", maxlength: "2048", placeholder: "https://" });
  const title = el("input", { id: `${prefix}-title`, type: "text", autocomplete: "off", maxlength: "200" });
  const summary = el("textarea", { id: `${prefix}-summary`, rows: "3", maxlength: "2000" });
  const relation = el("select", { id: `${prefix}-relation` });
  for (const [value, label] of Object.entries(RESOURCE_RELATION_LABELS)) {
    relation.appendChild(el("option", { value, text: label }));
  }
  const save = el("button", { class: "primary", type: "button", text: "Save resource" });
  const form = el("div", { class: "resource-form", hidden: true }, [
    el("p", { class: "explainer", text: "Stored locally on this shared meeting. Meeting Wiki never opens or fetches the link." }),
    field(url.id, "URL (https only)", url),
    field(title.id, "Title", title),
    field(summary.id, "Summary (optional)", summary),
    field(relation.id, "Relation", relation),
    save,
  ]);
  save.addEventListener("click", async () => {
    save.disabled = true;
    const result = await api.memory.addResource({
      meetingNodeId: item.meetingNodeId,
      url: url.value,
      title: title.value,
      summary: summary.value,
      relation: relation.value,
    });
    save.disabled = false;
    if (failed(result)) return;
    toast(`Resource “${result.resource.title}” added to ${item.label}.`);
    url.value = "";
    title.value = "";
    summary.value = "";
    form.hidden = true;
  });
  const toggle = el("button", { type: "button", text: "Add resource", "aria-expanded": "false" });
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    toggle.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) url.focus();
  });
  return [toggle, form];
}

function memoryTypeLabel(type) {
  return MEMORY_TYPE_LABELS[type] || "Record";
}

function updateMemoryScope() {
  const includePrivate = document.getElementById("memory-include-private").checked;
  const banner = document.getElementById("memory-scope");
  banner.textContent = includePrivate
    ? "Including private memory stored on this Mac. Private results stay in this window."
    : "Showing shared memory only.";
  banner.classList.toggle("is-private", includePrivate);
}

function sourceLine(source) {
  if (!source) return null;
  const when = source.occurredAt ? ` · ${source.occurredAt.slice(0, 10)}` : "";
  return `From ${source.title}${when}${source.privacy === "shared" ? "" : " (private)"}`;
}

function renderMemoryCard(item) {
  const title = el("h3", { class: "card-title", text: item.label || memoryTypeLabel(item.nodeType) });
  if (item.privacy !== "shared") title.appendChild(el("span", { class: "privacy-chip", text: "private" }));
  const card = el("article", { class: "card" }, [
    title,
    el("p", { class: "card-meta", text: memoryTypeLabel(item.nodeType) }),
  ]);
  if (item.nodeType === "resource") {
    const relation = RESOURCE_RELATION_LABELS[item.resourceRelation] || "Resource";
    card.appendChild(el("p", { class: "card-meta", text: relation }));
    if (item.url) card.appendChild(el("p", { class: "resource-url", text: item.url }));
    const summary = item.content.endsWith(item.url) ? item.content.slice(0, -item.url.length).trim() : item.content;
    if (summary) card.appendChild(el("p", { class: "snippet", text: summary }));
  } else if (item.content && item.content !== item.label) {
    card.appendChild(el("p", { class: "snippet", text: item.content }));
  }
  const origin = sourceLine(item.source);
  if (origin) card.appendChild(el("p", { class: "card-meta", text: origin }));
  if (item.relations.length > 0) {
    const relations = el("ul", { class: "relation-list", "aria-label": "Related records" });
    for (const relation of item.relations) {
      const incoming = relation.direction === "in" ? " (incoming)" : "";
      const via = relation.source ? `, source: ${relation.source.title}` : "";
      relations.appendChild(
        el("li", {
          text: `${relation.relation.replace(/_/g, " ")}${incoming}: ${memoryTypeLabel(relation.nodeType)} “${relation.label}”${via}`,
        }),
      );
    }
    card.appendChild(relations);
  }
  if (item.source && item.source.meetingKey) {
    card.appendChild(openPageButton(item.source.meetingKey, "Open source meeting"));
  }
  if (item.nodeType === "meeting" && item.privacy === "shared" && item.meetingNodeId && api.memory.addResource) {
    for (const node of resourceForm(item)) card.appendChild(node);
  }
  return card;
}

async function runMemorySearch() {
  const query = document.getElementById("memory-input").value.trim();
  const list = document.getElementById("memory-results");
  clear(list);
  if (query.length < 2) {
    list.appendChild(emptyNote("Type at least two characters."));
    return;
  }
  const types = Array.from(document.querySelectorAll('input[name="memory-type"]:checked')).map(
    (input) => input.value,
  );
  const includePrivate = document.getElementById("memory-include-private").checked === true;
  const result = await api.memory.search(query, { types, limit: 20, includePrivate });
  if (failed(result)) return;
  if (result.items.length === 0) {
    list.appendChild(emptyNote(`No memory matches “${query}”.`));
    return;
  }
  for (const item of result.items) list.appendChild(renderMemoryCard(item));
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
    if (result && result.error === "correction_already_applied") {
      toast("This correction was already applied; nothing new was queued.");
      reprocess.disabled = false;
      return;
    }
    if (result && result.error === "correction_job_inactive") {
      toast(`This correction's job ${result.job_id} is ${result.job_state}; retry it from Processing recovery.`);
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
  const retained = (plan.retained_external_tasks && plan.retained_external_tasks.count) || 0;
  if (retained > 0) {
    box.appendChild(
      el("p", {
        text:
          `No new tasks are proposed. ${retained} task${retained === 1 ? " was" : "s were"} ` +
          "already sent and keep the old label in the task system.",
      }),
    );
  }
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

function diagnosticText(job) {
  const diagnostic = job.diagnostic;
  if (!diagnostic) return `The job stopped during ${job.stage}.`;
  if (diagnostic.category !== "provider_request_failed") {
    return `The app stopped during ${diagnostic.stage}.`;
  }
  const details = [diagnostic.sdk_error_type];
  if (diagnostic.http_status) details.push(`HTTP ${diagnostic.http_status}`);
  if (diagnostic.provider_status) details.push(diagnostic.provider_status);
  return `${diagnostic.provider} ${diagnostic.operation} failed (${details.join(", ")}).`;
}

function setRecoveryBusy(busy) {
  recoveryBusy = busy;
  for (const button of document.querySelectorAll("[data-recovery-action]")) {
    button.disabled = busy;
  }
}

function recoveryMeta(job) {
  return `Job #${job.id} · ${job.stage} · attempt ${job.attempts} of ${job.max_attempts}`;
}

function recoveryCard(job, actions) {
  const card = el("article", { class: "card recovery-card" }, [
    el("h3", { class: "card-title", text: `Job #${job.id}` }),
    el("p", { class: "card-meta", text: recoveryMeta(job) }),
    el("p", { class: "recovery-diagnostic", text: diagnosticText(job) }),
  ]);
  const buttons = actions.map((action) => {
    const button = el("button", {
      class: action.primary ? "primary" : "",
      type: "button",
      text: action.label,
      "data-recovery-action": "",
    });
    button.addEventListener("click", async () => {
      if (recoveryBusy) return;
      if (action.confirm && !window.confirm(action.confirm)) return;
      setRecoveryBusy(true);
      const result = await action.run();
      setRecoveryBusy(false);
      if (failed(result)) return;
      toast(action.success(job.id));
      await loadRecovery(true);
    });
    return button;
  });
  card.appendChild(el("div", { class: "correction-actions" }, buttons));
  return card;
}

function renderRecovery(deadJobs, dismissedJobs) {
  const activeList = document.getElementById("recovery-list");
  const dismissedList = document.getElementById("dismissed-list");
  const retryAll = document.getElementById("recovery-retry-all");
  clear(activeList);
  clear(dismissedList);
  retryAll.disabled = recoveryBusy || deadJobs.length === 0;
  if (deadJobs.length === 0) {
    activeList.appendChild(emptyNote("No processing jobs need action."));
  }
  for (const job of deadJobs) {
    activeList.appendChild(recoveryCard(job, [
      {
        label: "Retry job",
        primary: true,
        run: () => api.jobs.retry(job.id),
        success: (jobId) => `Job #${jobId} queued for retry.`,
      },
      {
        label: "Dismiss",
        confirm: "Dismiss this job? Its recording, transcript, wiki pages, and local diagnostic record will be kept.",
        run: () => api.jobs.dismiss(job.id),
        success: (jobId) => `Job #${jobId} dismissed. Its meeting data was kept.`,
      },
    ]));
  }
  if (dismissedJobs.length === 0) {
    dismissedList.appendChild(emptyNote("No dismissed jobs."));
  }
  for (const job of dismissedJobs) {
    dismissedList.appendChild(recoveryCard(job, [{
      label: "Restore to recovery",
      run: () => api.jobs.restore(job.id),
      success: (jobId) => `Job #${jobId} restored to the recovery list.`,
    }]));
  }
}

async function loadRecovery(force = false) {
  if (!force && loaded.recovery) return;
  if (!api.jobs) {
    toast("Processing recovery is unavailable. Reopen the window.");
    return;
  }
  const [deadJobs, dismissedJobs] = await Promise.all([api.jobs.listDead(), api.jobs.listDismissed()]);
  if (failed(deadJobs) || failed(dismissedJobs)) return;
  loaded.recovery = true;
  renderRecovery(deadJobs, dismissedJobs);
  const badge = document.getElementById("recovery-count");
  badge.hidden = deadJobs.length === 0;
  badge.textContent = String(deadJobs.length);
}

async function retryAllRecoveryJobs() {
  if (recoveryBusy) return;
  const retryAll = document.getElementById("recovery-retry-all");
  if (retryAll.disabled) return;
  setRecoveryBusy(true);
  const result = await api.jobs.retryAllDead();
  setRecoveryBusy(false);
  if (failed(result)) return;
  toast(`${result} job${result === 1 ? "" : "s"} queued for retry.`);
  await loadRecovery(true);
}

async function refreshRecoveryBadge() {
  if (!api.jobs) return;
  const jobs = await api.jobs.listDead();
  if (failed(jobs)) return;
  const badge = document.getElementById("recovery-count");
  badge.hidden = jobs.length === 0;
  badge.textContent = String(jobs.length);
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
  document.getElementById("memory-button").addEventListener("click", runMemorySearch);
  document.getElementById("memory-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") runMemorySearch();
  });
  const includePrivate = document.getElementById("memory-include-private");
  includePrivate.checked = false;
  includePrivate.addEventListener("change", () => {
    updateMemoryScope();
    clear(document.getElementById("memory-results"));
  });
  updateMemoryScope();
  document.getElementById("page-close").addEventListener("click", closePage);
  document.getElementById("recovery-retry-all").addEventListener("click", retryAllRecoveryJobs);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("page-viewer").hidden) closePage();
  });
  document.addEventListener("keydown", trapDialogFocus);
  loadRecent();
  refreshBadge();
  refreshRecoveryBadge();
}

document.addEventListener("DOMContentLoaded", init);
