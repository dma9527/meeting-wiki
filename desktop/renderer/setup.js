"use strict";

// First-run setup renderer. It talks to the main process only through the
// window.meetingWikiSetup bridge and builds every dynamic node with textContent.
//
// Expected bridge (implemented by the preload, not here):
//   getSetupState()                 -> { storagePath?, mode?: "online" | "local", provider?, savedKeys: { gemini, openai_compatible } }
//   saveOnlineProvider(settings)    -> { ok: true } | { error: string }   (stages only; nothing is saved yet)
//       settings: { baseUrl, transcriptionModel, languageModel, apiKey, useSavedKey, acknowledgedEgress: true }
//   testOnlineProvider()            -> { ok: true, detail?: string } | { error: string }
//   saveGeminiProvider({ apiKey, useSavedKey, acknowledgedEgress: true }) -> { ok: true } | { error: string }
//   testGeminiProvider({ acknowledgedEgress: true })         -> { ok: true, detail?: string } | { error: string }
//   testSavedProvider()             -> { ok: true, detail } | { error }   (active setup, changes nothing)
//   readClipboardApiKey()           -> { value } | { error }
//   listLocalModels()               -> LocalModel[] | { error: string }
//       LocalModel: { id, name, role, sizeBytes?, source, license?, installed?, required? }
//   downloadLocalModel(id)          -> { ok: true } | { error: string }
//   onLocalModelProgress(callback)  -> unsubscribe function
//       callback({ id, receivedBytes?, totalBytes?, status: "downloading" | "installed" | "error", error? })
//   completeSetup({ mode, provider? }) -> { ok: true } | { error: string }   (the only commit point)
//       Gemini completes as { mode: "online", provider: "gemini" }.

(function setupWizard() {
  const bridge = window.meetingWikiSetup;
  const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const GEMINI_DESTINATION = "Google Gemini";

  const state = {
    mode: null,
    step: "choose",
    onlineHost: "",
    onlineSaved: false,
    savedKeys: { gemini: false, openai_compatible: false },
    usedSavedKey: false,
    models: [],
    progress: new Map(),
    busy: false,
  };

  // A revealed key is masked again after this delay, on submit, and when the step changes.
  const REVEAL_MS = 20_000;
  const revealTimers = new Map();

  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "hidden") node.hidden = value;
      else if (key === "disabled") node.disabled = value;
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child) node.appendChild(child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function announce(message) {
    const node = $("announcer");
    node.textContent = "";
    // A fresh text node lets screen readers repeat an identical message.
    window.setTimeout(() => {
      node.textContent = message;
    }, 30);
  }

  function errorOf(result) {
    if (result && typeof result === "object" && typeof result.error === "string") return result.error;
    return "";
  }

  async function call(method, ...args) {
    if (!bridge || typeof bridge[method] !== "function") {
      return { error: "Setup cannot reach the app. Close this window and reopen Meeting Wiki." };
    }
    try {
      const result = await bridge[method](...args);
      return result === undefined ? { ok: true } : result;
    } catch (_) {
      return { error: "The app did not respond. Try again." };
    }
  }

  function setStatus(id, message, tone) {
    const node = $(id);
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  function setBusy(button, busy, busyLabel) {
    state.busy = busy;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = busyLabel;
      button.setAttribute("aria-disabled", "true");
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.removeAttribute("aria-disabled");
    }
  }

  // ---- Field errors ----

  function showFieldError(input, message) {
    const node = $(`${input.id}-error`);
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  // ---- API key controls ----

  function toggleFor(input) {
    return document.querySelector(`[data-key-toggle="${input.id}"]`);
  }

  function maskKey(input, { announceIt = false } = {}) {
    clearTimeout(revealTimers.get(input.id));
    revealTimers.delete(input.id);
    const toggle = toggleFor(input);
    const wasShown = input.type === "text";
    input.type = "password";
    if (toggle) {
      toggle.textContent = "Show key";
      toggle.setAttribute("aria-pressed", "false");
    }
    if (wasShown && announceIt) announce("API key hidden.");
  }

  function maskAllKeys() {
    for (const input of document.querySelectorAll("input[name='apiKey']")) maskKey(input);
  }

  function onToggleKey(event) {
    const input = $(event.currentTarget.dataset.keyToggle);
    if (!input) return;
    if (input.type === "text") {
      maskKey(input, { announceIt: true });
      return;
    }
    input.type = "text";
    event.currentTarget.textContent = "Hide key";
    event.currentTarget.setAttribute("aria-pressed", "true");
    announce("API key shown. It hides again in 20 seconds.");
    revealTimers.set(input.id, window.setTimeout(() => maskKey(input, { announceIt: true }), REVEAL_MS));
  }

  // The main process validates the clipboard text; the value goes only into this masked field.
  async function onPasteKey(event) {
    const input = $(event.currentTarget.dataset.keyPaste);
    if (!input) return;
    const result = await call("readClipboardApiKey");
    const message = errorOf(result);
    if (message || typeof result.value !== "string") {
      showFieldError(input, message || "The clipboard could not be read.");
      input.focus();
      return;
    }
    maskKey(input);
    input.value = result.value;
    showFieldError(input, "");
    input.focus();
    announce("API key pasted.");
  }

  function renderSavedKeyHints() {
    $("gemini-api-key-saved").hidden = !state.savedKeys.gemini;
    $("online-api-key-saved").hidden = !state.savedKeys.openai_compatible;
  }

  // ---- Current setup ----

  async function onTestCurrent() {
    if (state.busy) return;
    const button = $("current-setup-test");
    setBusy(button, true, "Testing");
    setStatus("current-setup-status", "Checking your saved provider with the saved key.", "");
    const result = await call("testSavedProvider");
    setBusy(button, false);
    const message = errorOf(result);
    if (message || !result.ok) {
      setStatus("current-setup-status", `Check failed: ${message || "no response from the engine."}`, "error");
      return;
    }
    setStatus("current-setup-status", typeof result.detail === "string" ? result.detail : "Your saved provider responded.", "ok");
  }

  // ---- Endpoint parsing ----

  function parseEndpoint(raw) {
    const value = raw.trim();
    if (!value) return { error: "Enter the provider's endpoint URL." };
    let url;
    try {
      url = new URL(value);
    } catch (_) {
      return { error: "Enter a full URL, for example https://provider.example/v1." };
    }
    if (url.username || url.password) {
      return { error: "Remove the username or password from the URL. Use the API key field instead." };
    }
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return { error: "Use an https URL. Plain http is allowed only for a server on this Mac." };
    }
    return { url, host: url.host, loopback };
  }

  // ---- Data boundary panel ----

  function renderBoundary() {
    const panel = $("boundary");
    const gemini = state.mode === "gemini";
    panel.dataset.mode = gemini ? "online" : state.mode || "undecided";

    const parsed = parseEndpoint($("online-base-url").value);
    const host = gemini ? GEMINI_DESTINATION : parsed.error ? "" : parsed.host;
    state.onlineHost = host;
    $("boundary-host").textContent = host || "the endpoint you enter";
    $("boundary-loopback").hidden = gemini || !(host && parsed.loopback);
    for (const node of document.querySelectorAll("[data-host-ref]")) {
      node.textContent = host || "the provider above";
    }
  }

  // ---- Step navigation ----

  const PANEL_FOR_STEP = {
    choose: "panel-choose",
    gemini: "panel-gemini",
    online: "panel-online",
    local: "panel-local",
    confirm: "panel-confirm",
    done: "panel-done",
  };

  const INDICATOR_FOR_STEP = {
    choose: "choose",
    gemini: "configure",
    online: "configure",
    local: "configure",
    confirm: "confirm",
    done: "confirm",
  };

  function goTo(step) {
    state.step = step;
    maskAllKeys();
    for (const [key, id] of Object.entries(PANEL_FOR_STEP)) {
      $(id).hidden = key !== step;
    }
    const indicator = INDICATOR_FOR_STEP[step];
    const order = ["choose", "configure", "confirm"];
    const reached = order.indexOf(indicator);
    for (const item of document.querySelectorAll(".step")) {
      const index = order.indexOf(item.dataset.step);
      if (item.dataset.step === indicator) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
      item.dataset.done = String(index < reached || step === "done");
    }
    const heading = $(PANEL_FOR_STEP[step]).querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus();
      document.title = `${heading.textContent} · Meeting Wiki setup`;
    }
    if (step === "local") loadModels();
    if (step === "confirm") renderSummary();
  }

  // ---- Step 1: choose ----

  function selectedMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : null;
  }

  function onModeChange() {
    state.mode = selectedMode();
    $("choose-error").hidden = true;
    renderBoundary();
  }

  function onChooseSubmit(event) {
    event.preventDefault();
    const mode = selectedMode();
    if (!mode) {
      const node = $("choose-error");
      node.textContent = "Choose Gemini, Other online API key, or Local only to continue.";
      node.hidden = false;
      $("mode-gemini").focus();
      return;
    }
    state.mode = mode;
    renderBoundary();
    goTo(mode);
  }

  // ---- Step 2a: Gemini ----

  async function onGeminiSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    const button = $("gemini-save");
    const apiKey = $("gemini-api-key");
    const ack = $("gemini-egress-ack");
    const problems = [];
    const useSavedKey = !apiKey.value.trim() && state.savedKeys.gemini;
    const keyMessage = apiKey.value.trim() || useSavedKey ? "" : "Enter your Gemini API key.";
    showFieldError(apiKey, keyMessage);
    if (keyMessage) problems.push(apiKey);
    const ackMessage = ack.checked ? "" : "Confirm that meeting data will be sent to Google Gemini.";
    showFieldError(ack, ackMessage);
    if (ackMessage) problems.push(ack);
    if (problems.length) {
      setStatus("gemini-status", "", "");
      problems[0].focus();
      announce(`${problems.length} ${problems.length === 1 ? "field needs" : "fields need"} attention.`);
      return;
    }

    maskKey(apiKey);
    setBusy(button, true, "Checking");
    setStatus("gemini-status", "Preparing the Gemini check. Nothing is saved yet.", "");
    const saved = await call("saveGeminiProvider", {
      apiKey: apiKey.value.trim(),
      useSavedKey,
      acknowledgedEgress: true,
    });
    // The key is handed to the main process once and never kept in the page.
    apiKey.value = "";

    const saveError = errorOf(saved);
    if (saveError) {
      setBusy(button, false);
      setStatus("gemini-status", saveError, "error");
      apiKey.focus();
      return;
    }

    setStatus("gemini-status", "Checking the Gemini setup.", "");
    const tested = await call("testGeminiProvider", { acknowledgedEgress: true });
    setBusy(button, false);

    const testError = errorOf(tested);
    if (testError || !tested.ok) {
      setStatus("gemini-status", `Check failed: ${testError || "no response from the engine."}`, "error");
      apiKey.focus();
      return;
    }

    state.usedSavedKey = useSavedKey;
    const detail = typeof tested.detail === "string" && tested.detail ? ` ${tested.detail}` : "";
    setStatus("gemini-status", `Gemini check passed.${detail} Finish setup to switch to it.`, "ok");
    goTo("confirm");
  }

  // ---- Step 2b: online ----

  function validateOnline() {
    const baseUrl = $("online-base-url");
    const transcription = $("online-transcription-model");
    const language = $("online-language-model");
    const apiKey = $("online-api-key");
    const ack = $("online-egress-ack");
    const problems = [];

    const parsed = parseEndpoint(baseUrl.value);
    showFieldError(baseUrl, parsed.error || "");
    if (parsed.error) problems.push(baseUrl);

    for (const [input, label] of [
      [transcription, "Enter a transcription model name."],
      [language, "Enter a summary and translation model name."],
    ]) {
      const message = input.value.trim() ? "" : label;
      showFieldError(input, message);
      if (message) problems.push(input);
    }

    const useSavedKey = !apiKey.value.trim() && state.savedKeys.openai_compatible;
    const keyMessage = apiKey.value.trim() || useSavedKey ? "" : "Enter the API key from your provider.";
    showFieldError(apiKey, keyMessage);
    if (keyMessage) problems.push(apiKey);

    const ackMessage = ack.checked ? "" : "Confirm that meeting data will be sent to this provider.";
    showFieldError(ack, ackMessage);
    if (ackMessage) problems.push(ack);

    return { problems, parsed, useSavedKey };
  }

  async function onOnlineSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    const button = $("online-save");
    const { problems, parsed, useSavedKey } = validateOnline();
    if (problems.length) {
      setStatus("online-status", "", "");
      problems[0].focus();
      announce(`${problems.length} ${problems.length === 1 ? "field needs" : "fields need"} attention.`);
      return;
    }

    const apiKey = $("online-api-key");
    maskKey(apiKey);
    setBusy(button, true, "Testing connection");
    setStatus("online-status", "Preparing the connection test. Nothing is saved yet.", "");

    const saved = await call("saveOnlineProvider", {
      baseUrl: parsed.url.toString(),
      transcriptionModel: $("online-transcription-model").value.trim(),
      languageModel: $("online-language-model").value.trim(),
      apiKey: apiKey.value.trim(),
      useSavedKey,
      acknowledgedEgress: true,
    });
    // The key is handed to the main process once and never kept in the page.
    apiKey.value = "";

    const saveError = errorOf(saved);
    if (saveError) {
      setBusy(button, false);
      setStatus("online-status", saveError, "error");
      apiKey.focus();
      return;
    }

    setStatus("online-status", `Testing the connection to ${parsed.host}.`, "");
    const tested = await call("testOnlineProvider");
    setBusy(button, false);

    const testError = errorOf(tested);
    if (testError || !tested.ok) {
      state.onlineSaved = false;
      setStatus(
        "online-status",
        `Connection test failed: ${testError || "no response from the provider."} Check the URL, model names, and key, then try again.`,
        "error",
      );
      apiKey.focus();
      return;
    }

    state.onlineSaved = true;
    state.usedSavedKey = useSavedKey;
    const detail = typeof tested.detail === "string" && tested.detail ? ` ${tested.detail}` : "";
    setStatus("online-status", `Connected to ${parsed.host}.${detail} Finish setup to switch to it.`, "ok");
    goTo("confirm");
  }

  // ---- Step 2c: local ----

  function formatBytes(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "Size not reported";
    const units = ["bytes", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function isInstalled(model) {
    const progress = state.progress.get(model.id);
    return Boolean(model.installed) || (progress && progress.status === "installed");
  }

  function requiredReady() {
    const required = state.models.filter((model) => model.required !== false);
    return required.length > 0 && required.every(isInstalled);
  }

  function updateLocalContinue() {
    const ready = requiredReady();
    $("local-continue").disabled = !ready;
    $("local-continue-hint").hidden = ready;
  }

  function renderModel(model) {
    const progress = state.progress.get(model.id) || {};
    const installed = isInstalled(model);
    const downloading = progress.status === "downloading";
    const nameId = `model-${model.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-name`;

    const meta = el("dl", { class: "model-meta" }, [
      el("dt", { text: "Used for" }),
      el("dd", { text: model.role || "Not specified" }),
      el("dt", { text: "Size" }),
      el("dd", { text: formatBytes(model.sizeBytes) }),
      el("dt", { text: "Source" }),
      el("dd", {}, el("code", { text: model.source || "Not reported" })),
      model.license ? el("dt", { text: "License" }) : null,
      model.license ? el("dd", { text: model.license }) : null,
    ]);

    let control;
    if (installed) {
      control = el("p", { class: "model-state model-state-ok", text: "Installed" });
    } else if (downloading) {
      const total = typeof progress.totalBytes === "number" ? progress.totalBytes : model.sizeBytes;
      const received = typeof progress.receivedBytes === "number" ? progress.receivedBytes : 0;
      const bar = el("progress", { "aria-labelledby": nameId });
      if (typeof total === "number" && total > 0) {
        bar.max = total;
        bar.value = Math.min(received, total);
      }
      control = el("div", { class: "model-progress" }, [
        bar,
        el("p", {
          class: "model-state",
          text: total ? `${formatBytes(received)} of ${formatBytes(total)}` : "Downloading",
        }),
      ]);
    } else {
      const button = el("button", {
        type: "button",
        class: "button button-secondary",
        text: progress.status === "error" ? "Retry download" : "Download",
        "aria-describedby": nameId,
      });
      button.addEventListener("click", () => startDownload(model));
      control = el("div", { class: "model-actions" }, [
        button,
        progress.status === "error"
          ? el("p", { class: "field-error", text: progress.error || "Download failed." })
          : null,
      ]);
    }

    return el("li", { class: "model", "data-installed": String(installed) }, [
      el("div", { class: "model-head" }, [
        el("h3", { id: nameId, class: "model-name", text: model.name || model.id }),
        model.required === false ? el("span", { class: "tag tag-quiet", text: "Optional" }) : null,
      ]),
      meta,
      control,
    ]);
  }

  function renderModels() {
    const host = $("models-list");
    host.setAttribute("aria-busy", "false");
    clear(host);
    if (!state.models.length) {
      host.appendChild(
        el("p", {
          class: "list-empty",
          text: "No local models are available in this build. Go back and choose Online API key.",
        }),
      );
    } else {
      host.appendChild(el("ul", { class: "model-list" }, state.models.map(renderModel)));
    }
    updateLocalContinue();
  }

  let modelsLoaded = false;
  async function loadModels() {
    if (modelsLoaded) return;
    const result = await call("listLocalModels");
    const message = errorOf(result);
    if (message) {
      $("models-list").setAttribute("aria-busy", "false");
      clear($("models-list"));
      $("models-list").appendChild(el("p", { class: "field-error", text: message }));
      return;
    }
    modelsLoaded = true;
    state.models = Array.isArray(result)
      ? result.filter((model) => model && typeof model.id === "string" && model.id)
      : [];
    renderModels();
  }

  async function startDownload(model) {
    state.progress.set(model.id, { status: "downloading", receivedBytes: 0, totalBytes: model.sizeBytes });
    renderModels();
    setStatus("local-status", `Downloading ${model.name || model.id}.`, "");
    const result = await call("downloadLocalModel", model.id);
    const message = errorOf(result);
    if (message) {
      state.progress.set(model.id, { status: "error", error: message });
      setStatus("local-status", `${model.name || model.id}: ${message}`, "error");
      renderModels();
    }
  }

  function onModelProgress(event) {
    if (!event || typeof event.id !== "string") return;
    const model = state.models.find(({ id }) => id === event.id);
    if (!model) return;
    const previous = state.progress.get(event.id) || {};
    state.progress.set(event.id, { ...previous, ...event });
    const label = model.name || model.id;
    if (event.status === "installed" && previous.status !== "installed") {
      setStatus("local-status", `${label} installed.`, "ok");
    } else if (event.status === "error") {
      setStatus("local-status", `${label}: ${event.error || "Download failed."}`, "error");
    }
    renderModels();
    if (event.status === "installed" && requiredReady()) {
      announce("All required models are installed. You can continue.");
    }
  }

  // ---- Step 3: confirm ----

  function keyRow() {
    return state.usedSavedKey
      ? "Keeps the key already saved in the Keychain"
      : "Saved in the Keychain when you finish setup";
  }

  function renderSummary() {
    const list = $("confirm-summary");
    clear(list);
    const rows = [];
    if (state.mode === "gemini") {
      rows.push(["Path", "Gemini"]);
      rows.push(["Used for", "Transcription, live captions, translation, and summaries"]);
      rows.push(["API key", keyRow()]);
      rows.push(["Data egress", `Audio and transcript text are sent to ${GEMINI_DESTINATION}.`]);
    } else if (state.mode === "online") {
      rows.push(["Path", "Online API key"]);
      rows.push(["Provider", state.onlineHost || "Not set"]);
      rows.push(["Transcription model", $("online-transcription-model").value.trim()]);
      rows.push(["Summary and translation model", $("online-language-model").value.trim()]);
      rows.push(["API key", keyRow()]);
      rows.push(["Data egress", `Audio and transcript text are sent to ${state.onlineHost || "the provider"}.`]);
    } else {
      const installed = state.models.filter(isInstalled).map((model) => model.name || model.id);
      rows.push(["Path", "Local only"]);
      rows.push(["Models", installed.length ? installed.join(", ") : "None installed"]);
      rows.push(["Data egress", "None. Meeting content stays on this Mac."]);
    }
    rows.push(["Storage", $("boundary-storage").textContent]);
    rows.push(["Until you finish", "Your current provider, key, and settings stay active."]);
    for (const [term, value] of rows) {
      list.appendChild(el("dt", { text: term }));
      list.appendChild(el("dd", { text: value }));
    }
  }

  async function onFinish() {
    if (state.busy) return;
    const button = $("confirm-finish");
    setBusy(button, true, "Finishing");
    setStatus("confirm-status", "Saving setup.", "");
    const completion = state.mode === "gemini" ? { mode: "online", provider: "gemini" } : { mode: state.mode };
    const result = await call("completeSetup", completion);
    setBusy(button, false);
    const message = errorOf(result);
    if (message) {
      setStatus("confirm-status", message, "error");
      return;
    }
    setStatus("confirm-status", "", "");
    goTo("done");
  }

  // ---- Wiring ----

  async function init() {
    if (!bridge) {
      $("bridge-missing").hidden = false;
      for (const button of document.querySelectorAll("button[type='submit'], #confirm-finish")) {
        button.disabled = true;
      }
    }

    $("choose-form").addEventListener("submit", onChooseSubmit);
    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener("change", onModeChange);
    }

    $("gemini-form").addEventListener("submit", onGeminiSubmit);
    $("gemini-api-key").addEventListener("input", () => showFieldError($("gemini-api-key"), ""));
    $("gemini-egress-ack").addEventListener("change", () => showFieldError($("gemini-egress-ack"), ""));

    $("online-form").addEventListener("submit", onOnlineSubmit);
    $("online-base-url").addEventListener("input", () => {
      showFieldError($("online-base-url"), "");
      renderBoundary();
    });
    for (const id of ["online-transcription-model", "online-language-model", "online-api-key"]) {
      $(id).addEventListener("input", () => showFieldError($(id), ""));
    }
    $("online-egress-ack").addEventListener("change", () => showFieldError($("online-egress-ack"), ""));

    for (const button of document.querySelectorAll("[data-back]")) {
      button.addEventListener("click", () => goTo(button.dataset.back));
    }
    $("local-continue").addEventListener("click", () => {
      if (requiredReady()) goTo("confirm");
    });
    $("confirm-back").addEventListener("click", () => goTo(state.mode || "choose"));
    $("confirm-finish").addEventListener("click", onFinish);
    $("current-setup-test").addEventListener("click", onTestCurrent);
    for (const button of document.querySelectorAll("[data-key-toggle]")) button.addEventListener("click", onToggleKey);
    for (const button of document.querySelectorAll("[data-key-paste]")) button.addEventListener("click", onPasteKey);

    if (bridge && typeof bridge.onLocalModelProgress === "function") {
      const unsubscribe = bridge.onLocalModelProgress(onModelProgress);
      if (typeof unsubscribe === "function") window.addEventListener("beforeunload", unsubscribe);
    }

    renderBoundary();

    const initial = await call("getSetupState");
    if (!errorOf(initial) && initial && typeof initial === "object") {
      if (typeof initial.storagePath === "string" && initial.storagePath) {
        $("boundary-storage").textContent = initial.storagePath;
      }
      const keys = initial.savedKeys && typeof initial.savedKeys === "object" ? initial.savedKeys : {};
      state.savedKeys = { gemini: keys.gemini === true, openai_compatible: keys.openai_compatible === true };
      renderSavedKeyHints();
      if (initial.mode === "online") {
        $("current-setup-summary").textContent = initial.provider === "gemini"
          ? "Gemini is set up and in use."
          : "An online API key provider is set up and in use.";
        $("current-setup").hidden = false;
      }
      if (initial.mode === "online" || initial.mode === "local") {
        const selected = initial.mode === "online" && initial.provider === "gemini" ? "gemini" : initial.mode;
        const radio = $(`mode-${selected}`);
        radio.checked = true;
        onModeChange();
      }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
