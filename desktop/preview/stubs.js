"use strict";

// Fake bridge APIs for the UI preview. Every value is clearly fake sample data.

const resolved = (value) => () => Promise.resolve(value);

const MEETING_PATH = "meetings/2026-10-20-roadmap-sync.md";
const citation = {
  meetingTitle: "Roadmap sync 路线图同步",
  occurredAt: "2026-10-20T15:00:00Z",
  privacy: "shared",
  anchor: { startSeconds: 754 },
  sourcePath: MEETING_PATH,
};

function wiki() {
  return {
    uiLanguage: resolved("system"),
    listRecent: resolved({
      items: [
        { title: "Roadmap sync 路线图同步", meeting_type: "design-review", timestamp: "2026-10-20 15:00", path: MEETING_PATH, description: "Chose option B for the Q4 migration and agreed on a staged rollout." },
        { title: "Weekly standup", meeting_type: "standup", timestamp: "2026-10-19 09:30", path: "meetings/2026-10-19-standup.md", description: "Blockers on the export flow; Sam pairs with Alex on Thursday." },
        { title: "Customer feedback review", meeting_type: "customer", timestamp: "2026-10-17 14:00", path: "meetings/2026-10-17-feedback.md" },
      ],
    }),
    search: resolved({
      items: [
        { title: "Roadmap sync 路线图同步", path: MEETING_PATH, snippets: [{ text: "…we chose option B because the migration can be staged…" }] },
      ],
    }),
    readPage: resolved({ path: MEETING_PATH, content: "# Roadmap sync\n\n## Decisions\n- Option B for the Q4 migration\n", truncated: false }),
    actionItems: resolved({
      items: [
        "| Sam | Write the migration plan | [[meetings/2026-10-20-roadmap-sync]] | 2026-10-31 |",
        "| Alex | Share the rollout checklist 发送上线清单 | [[meetings/2026-10-19-standup]] | |",
        "| Unassigned | Confirm the customer pilot dates | [[meetings/2026-10-17-feedback]] | 2026-11-04 |",
      ],
    }),
    memory: {
      search: resolved({
        items: [
          {
            nodeType: "decision", label: "Use option B for the Q4 migration", privacy: "shared",
            content: "Option B lets the team stage the rollout and keep the old path for one release.",
            citation, relations: [{ relation: "decided_in", direction: "out", nodeType: "meeting", label: "Roadmap sync", citation }],
          },
          { nodeType: "person", label: "Sam", privacy: "shared", content: "Owns the migration plan.", citation: null, relations: [] },
        ],
      }),
      decisions: resolved({
        items: [
          { title: "Use option A for the Q4 migration", occurredAt: "2026-10-06T15:00:00Z", owner: "Alex", effectiveStatus: "superseded", detail: "Single cutover over one weekend.", supersededBy: { title: "Use option B for the Q4 migration", occurredAt: "2026-10-20T15:00:00Z" }, citation },
          { title: "Use option B for the Q4 migration", occurredAt: "2026-10-20T15:00:00Z", owner: "Sam", effectiveStatus: "accepted", detail: "Staged rollout, old path kept for one release.", supersedes: { title: "Use option A for the Q4 migration", occurredAt: "2026-10-06T15:00:00Z" }, citation },
        ],
      }),
      addResource: resolved({ ok: true }),
    },
    corrections: {
      inbox: resolved([
        { meeting_key: "2026-10-19-standup", title: "Weekly standup", timestamp: "2026-10-19 09:30", labels: [{ label: "spk_1", segments: 14 }, { label: "spk_2", segments: 6 }] },
      ]),
      plan: resolved({ ok: true, changes: [] }),
      apply: resolved({ ok: true }),
    },
    jobs: {
      listDead: resolved([
        { id: 15, label: "Recording", stage: "transcribing", attempts: 5, max_attempts: 5, captured_at: "2026-10-26T15:07:18Z", diagnostic: { category: "provider_request_failed", stage: "transcribing", provider: "gemini", operation: "transcription", sdk_error_type: "BadRequestError", http_status: 400 } },
      ]),
      listDismissed: resolved([]),
      retry: resolved({ ok: true }),
      retryAllDead: resolved({ ok: true, retried: 1 }),
      dismiss: resolved({ ok: true }),
      restore: resolved({ ok: true }),
    },
  };
}

function setup() {
  return {
    getSetupState: resolved({ storagePath: "~/.meeting-wiki/", savedKeys: { gemini: false, openai_compatible: false } }),
    saveOnlineProvider: resolved({ ok: true }),
    testOnlineProvider: resolved({ ok: true }),
    saveGeminiProvider: resolved({ ok: true }),
    testGeminiProvider: resolved({ ok: true }),
    setAppLanguage: resolved({ ok: true }),
    testSavedProvider: resolved({ ok: true, detail: "ok" }),
    readClipboardApiKey: resolved({ value: "" }),
    listLocalModels: resolved([]),
    downloadLocalModel: resolved({ ok: true }),
    onLocalModelProgress: () => () => {},
    completeSetup: resolved({ ok: true }),
  };
}

function settings() {
  const metadataKeys = [
    "primaryProfileName", "aliases", "transcriptLanguage", "liveTranslationLanguage", "liveSummaryLanguage",
    "memoryLanguage", "uiLanguage", "batchAudioModel", "liveModel", "languageModel", "summaryContextCharacters",
    "maxDurationMinutes", "defaultPrivacyMode", "liveEnabled", "zoomAutoRecord", "googleMeetAutoRecord", "autoRecordPrivacy",
  ];
  return {
    getIdentitySettings: resolved({ ready: true, values: { primaryProfileName: "Alex Test", aliases: ["Alex", "AT"] }, legacyUserName: "", limits: { nameMaxLength: 100, maxAliases: 20 } }),
    saveIdentitySettings: resolved({ ok: true, values: {} }),
    getLanguageSettings: resolved({
      ready: true,
      values: { transcriptLanguage: "auto", liveTranslationLanguage: "zh-CN", liveSummaryLanguage: "zh-CN", memoryLanguage: "source", uiLanguage: "system" },
      unsupportedFields: [],
      choices: { transcriptLanguage: ["auto", "en", "zh-CN"], liveTranslationLanguage: ["en", "zh-CN"], liveSummaryLanguage: ["en", "zh-CN"], memoryLanguage: ["source", "en", "zh-CN"], uiLanguage: ["system", "en", "zh-CN"] },
    }),
    saveLanguageSettings: resolved({ ok: true, values: {} }),
    getGeminiSettings: resolved({ ready: true, values: { batchAudioModel: "gemini-3.5-flash", liveModel: "gemini-3.5-transcribe-live", languageModel: "gemini-3.5-flash", summaryContextCharacters: 12000 }, bounds: { summaryContextCharacters: { min: 500, max: 100000 } } }),
    saveGeminiSettings: resolved({ ok: true, values: {} }),
    getRecordingSettings: resolved({ ready: true, values: { maxDurationMinutes: 120, defaultsConfigured: true, defaultPrivacyMode: "shared", liveEnabled: true }, bounds: { maxDurationMinutes: { min: 15, max: 480 } } }),
    saveRecordingSettings: resolved({ ok: true, values: {} }),
    getIntegrationSettings: resolved({
      ready: true,
      values: { zoomAutoRecord: true, googleMeetAutoRecord: false, autoRecordPrivacy: "shared", autoRecordPrivacyChoiceNeeded: false },
      readiness: {
        permissions: { microphone: "granted", systemAudio: "not_checkable" },
        zoom: { appInstalled: true, toolsAvailable: true, detector: "watching" },
        googleMeet: { browsers: [{ id: "chrome", name: "Google Chrome", found: true, connected: false }], spoolReady: true, extensionBundled: true, detector: "off", extensionLastSeenAt: null },
      },
    }),
    saveIntegrationSettings: resolved({ ok: true, values: {}, readiness: {} }),
    showMeetExtension: resolved({ ok: true }),
    rerunSetup: resolved({ ok: true }),
    getSettingMetadata: resolved({
      settings: Object.fromEntries(metadataKeys.map((key) => [key, { form: "settings", appliesAfter: "next_recording", copy: "Applies to the next recording." }])),
      manualEdit: "Edits made by hand apply after Meeting Wiki restarts.",
    }),
  };
}

function record() {
  return {
    getContext: resolved({
      setupComplete: true, uiLanguage: "system", blockers: [], maxDurationMinutes: 120,
      microphone: "granted", systemAudio: "not_checkable", destination: "gemini", host: "",
      live: "ready", liveStarts: true, liveScope: "external", recording: false,
      formMode: "override", defaults: { privacyMode: "shared", liveEnabled: true },
    }),
    start: resolved({ ok: true }),
    cancel: resolved({ ok: true }),
    openSetup: resolved({ ok: true }),
    openPrivacySettings: resolved({ ok: true }),
  };
}

function live() {
  const events = [
    { type: "locale", uiLanguage: "system" },
    { type: "state", phase: "listening", private: false, scope: "external", issue: "" },
    { type: "transcript", sequence: 1, speaker: "others", text: "Let's start with the migration timeline for Q4." },
    { type: "translation", sequence: 1, text: "我们先从第四季度的迁移时间表开始。" },
    { type: "transcript", sequence: 2, speaker: "you", text: "I think option B is safer because we can stage the rollout." },
    { type: "translation", sequence: 2, text: "我认为方案 B 更安全，因为可以分阶段上线。" },
    { type: "transcript", sequence: 3, speaker: "others", text: "Agreed. Sam, can you own the migration plan by Friday?" },
    { type: "translation", sequence: 3, text: "同意。Sam，你能在周五前负责迁移计划吗？" },
    { type: "summary", sequence: 3, points: ["团队倾向方案 B，以便分阶段上线。", "Sam 负责在周五前完成迁移计划。", "下一步确认客户试点日期。"] },
  ];
  return {
    subscribe(callback) {
      for (const event of events) setTimeout(() => callback(event), 0);
      return true;
    },
    unsubscribe() {},
  };
}

module.exports = { wiki, setup, settings, record, live };
