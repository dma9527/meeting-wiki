"use strict";

// Simplified Chinese for the Wiki window: STATIC keys are index.html selectors and
// MESSAGES keys are English strings from app.js and the main process.

(function wikiLocalization(globalObject) {
  const i18n = typeof module !== "undefined" && module.exports
    ? require("./i18n")
    : globalObject.meetingWikiI18n;

  const STATIC = Object.freeze({
    ".skip-link": "跳到主要内容",
    ".tagline": "本地知识工作台",
    "#scope-note": "读取你的共享 wiki。只有在“记忆搜索”中打开开关时，才会显示私密记忆。",
    ".rail-item[data-view='recent'] .rail-label": "最近的会议",
    ".rail-item[data-view='search'] .rail-label": "搜索",
    ".rail-item[data-view='memory'] .rail-label": "记忆搜索",
    ".rail-item[data-view='decisions'] .rail-label": "决定历史",
    ".rail-item[data-view='actions'] .rail-label": "未完成的待办",
    ".rail-item[data-view='corrections'] .rail-label": "更正收件箱",
    ".rail-item[data-view='recovery'] .rail-label": "处理恢复",
    "#recent-heading": "最近的会议",
    "#search-heading": "搜索 wiki",
    "label[for='search-input']": "搜索词",
    "#search-button": "搜索",
    "#memory-heading": "记忆搜索",
    "#view-memory > .explainer": "搜索规范化的会议记忆：人员、主题、决定、待办和转写内容。每条结果会列出相关记录和它来自的会议。在共享会议上使用“添加资源”，可以附上带有你自己标题和摘要的链接。链接只保存在这台 Mac 上，不会被打开或抓取。",
    "label[for='memory-input']": "记忆搜索词",
    "#memory-button": "搜索记忆",
    ".memory-filters legend": "记录类型",
    "#type-label-meeting": "会议",
    "#type-label-person": "人员",
    "#type-label-topic": "主题",
    "#type-label-decision": "决定",
    "#type-label-action-item": "待办",
    "#type-label-transcript-segment": "转写内容",
    "#type-label-resource": "资源",
    "#memory-private-label": "包含这台 Mac 上的私密记忆",
    "#decisions-heading": "决定历史",
    "#view-decisions > .explainer": "共享的决定，从旧到新排列。只有当后来的决定明确指向某个决定时，被指向的那个决定才会标为“已被取代”。不会隐藏或删除任何内容。",
    "#actions-heading": "未完成的待办",
    "#corrections-heading": "更正收件箱",
    "#corrections-intro-a": "转写中仍使用含糊说话人标签的会议，例如",
    "#corrections-intro-b": "或",
    "#corrections-intro-c": "。重命名说话人，查看计划，然后重新处理。",
    "#recovery-heading": "处理恢复",
    "#view-recovery .view-head .explainer": "只重试你选择的任务。忽略只会隐藏失败的任务，不会删除它的录音、转写、wiki 页面或本地诊断记录。",
    "#recovery-retry-all": "全部重试",
    "#recovery-updated": "尚未载入。",
    "#recovery-error-retry": "重试",
    "#dismissed-heading": "已忽略的任务",
    ".dismissed-section .explainer": "想让任务回到恢复列表时，可以恢复它。",
    "#page-title": "页面",
    "#page-close": "关闭",
  });

  // Attribute text is translated from its English source, so switching back restores it.
  const ATTRIBUTES = Object.freeze([
    { selector: ".rail", attribute: "aria-label", english: "Sections" },
    { selector: "#search-input", attribute: "placeholder", english: "e.g. migration rollout" },
    { selector: "#memory-input", attribute: "placeholder", english: "e.g. canary rollout" },
    { selector: "#page-close", attribute: "aria-label", english: "Close page" },
  ]);

  const MESSAGES = Object.freeze({
    Sections: "分区",
    "e.g. migration rollout": "例如：迁移上线",
    "e.g. canary rollout": "例如：灰度发布",
    "Close page": "关闭页面",
    "Bridge unavailable. Reopen the window.": "无法连接 App。请重新打开窗口。",
    "This action is unavailable.": "这个操作暂时无法使用。",
    "That page was not found.": "找不到这个页面。",
    "(truncated)": "（已截断）",
    "Open meeting": "打开会议",
    "Open page": "打开页面",
    "Open source meeting": "打开来源会议",
    "No meetings yet. Record or import one to get started.": "还没有会议。录制或导入一场会议即可开始。",
    "Type at least two characters.": "请至少输入两个字符。",
    "No pages match “{query}”.": "没有页面匹配“{query}”。",
    "No memory matches “{query}”.": "没有记忆匹配“{query}”。",
    Meeting: "会议",
    Person: "人员",
    Topic: "主题",
    Decision: "决定",
    "Action item": "待办",
    "Transcript line": "转写内容",
    Resource: "资源",
    Record: "记录",
    Reference: "参考资料",
    "Design doc": "设计文档",
    Ticket: "工单",
    "Code review": "代码评审",
    Notes: "笔记",
    "Follow-up": "后续跟进",
    "Add resource": "添加资源",
    "Save resource": "保存资源",
    "Stored locally on this shared meeting. Meeting Wiki never opens or fetches the link.": "保存在这台 Mac 上的这场共享会议中。Meeting Wiki 不会打开或抓取这个链接。",
    "URL (https only)": "URL（仅限 https）",
    Title: "标题",
    "Summary (optional)": "摘要（可选）",
    Relation: "关系",
    "Resource “{title}” added to {label}.": "资源“{title}”已添加到 {label}。",
    "Including private memory stored on this Mac. Private results stay in this window.": "已包含保存在这台 Mac 上的私密记忆。私密结果只会显示在这个窗口中。",
    "Showing shared memory only.": "只显示共享记忆。",
    "From {title}{when}{at}": "来自 {title}{when}{at}",
    "From {title}{when}{at} (private)": "来自 {title}{when}{at}（私密）",
    "at {time}": "位于 {time}",
    private: "私密",
    "Related records": "相关记录",
    "Unknown speaker": "未知说话人",
    ", source: {title}": "，来源：{title}",
    "{relation}: {type} “{label}”{via}": "{relation}：{type}“{label}”{via}",
    "{relation} (incoming): {type} “{label}”{via}": "{relation}（被引用）：{type}“{label}”{via}",
    "part of": "所属",
    "owned by": "负责人",
    "mentioned in": "提及于",
    "discussed in": "讨论于",
    "decided in": "决定于",
    "attributed to": "归属于",
    "assigned to": "分配给",
    "assigned in": "分配于",
    Unassigned: "未分配",
    "no due date": "没有截止日期",
    "No open action items.": "没有未完成的待办。",
    "No decisions recorded yet.": "还没有记录任何决定。",
    "Superseded": "已被取代",
    "Reversed": "已撤销",
    "Owner: {owner}": "负责人：{owner}",
    "Replaced by “{title}” ({date})": "被“{title}”取代（{date}）",
    "Replaces “{title}” ({date})": "取代了“{title}”（{date}）",
    "Correct name": "正确的名字",
    Reprocess: "重新处理",
    "Preview plan": "预览计划",
    "Enter at least one corrected name.": "请至少输入一个更正后的名字。",
    "Original job is no longer available; cannot reprocess this meeting.": "原始任务已不可用，无法重新处理这场会议。",
    "The original audio or transcript is no longer available; cannot reprocess.": "原始音频或转写已不可用，无法重新处理。",
    "This correction was already applied; nothing new was queued.": "这个更正已经应用过，没有新增排队任务。",
    "This correction's job {jobId} is {state}; retry it from Processing recovery.": "这个更正的任务 {jobId} 状态为{state}。请在“处理恢复”中重试。",
    "Reprocessing queued (job {jobId}). The old label stays on shared surfaces.": "已加入重新处理队列（任务 {jobId}）。旧标签会保留在共享内容中。",
    "Reprocessing this meeting will:": "重新处理这场会议会：",
    "Rewrite {key} with the corrected names.": "用更正后的名字重写 {key}。",
    "No new tasks are proposed. 1 task was already sent and keeps the old label in the task system.": "不会提出新任务。已发送的 1 个任务会在任务系统中保留旧标签。",
    "No new tasks are proposed. {count} tasks were already sent and keep the old label in the task system.": "不会提出新任务。已发送的 {count} 个任务会在任务系统中保留旧标签。",
    "Limitation: ": "限制：",
    "the deterministic renderer never deletes content it did not load, and re-analysis is non-deterministic. The old label is kept on append-only surfaces below and must be cleaned manually.": "确定性渲染器不会删除它没有载入的内容，而重新分析的结果并不固定。旧标签会保留在下面这些只追加的内容中，需要手动清理。",
    "{key} keeps 1 “{label}” entry.": "{key} 保留了 1 条“{label}”。",
    "{key} keeps {count} “{label}” entries.": "{key} 保留了 {count} 条“{label}”。",
    "No ambiguous speaker labels. Everything is attributed.": "没有含糊的说话人标签，所有内容都已标明说话人。",
    "The job stopped during {stage}.": "任务在“{stage}”阶段停止。",
    "The app stopped during {stage}.": "App 在“{stage}”阶段停止。",
    "{provider} {operation} failed ({details}).": "{provider} 的 {operation} 失败（{details}）。",
    "capture time unknown": "采集时间未知",
    "captured {time}": "采集于 {time}",
    "{captured} · Job #{id} · {stage} · attempt {attempts} of {max}": "{captured} · 任务 #{id} · {stage} · 第 {attempts} 次，共 {max} 次",
    Recording: "录音",
    queued: "排队中",
    transcribing: "转写中",
    analyzing: "分析中",
    rendering: "生成中",
    integrating: "整合中",
    done: "已完成",
    pending: "待处理",
    running: "运行中",
    failed: "失败",
    dead: "已停止重试",
    dismissed: "已忽略",
    "Retry job": "重试任务",
    Dismiss: "忽略",
    "Restore to recovery": "移回恢复列表",
    "Dismiss this job? Its recording, transcript, wiki pages, and local diagnostic record will be kept.": "要忽略这个任务吗？它的录音、转写、wiki 页面和本地诊断记录都会保留。",
    "Job #{id} queued for retry.": "任务 #{id} 已加入重试队列。",
    "Job #{id} dismissed. Its meeting data was kept.": "任务 #{id} 已忽略，会议数据已保留。",
    "Job #{id} restored to the recovery list.": "任务 #{id} 已移回恢复列表。",
    "{action} did not finish: {reason}": "{action}没有完成：{reason}",
    "Retry all": "全部重试",
    "No processing jobs need action.": "没有需要处理的任务。",
    "No dismissed jobs.": "没有已忽略的任务。",
    "Processing recovery is unavailable. Reopen the window.": "无法使用处理恢复。请重新打开窗口。",
    "Processing jobs could not be loaded: {reason}": "无法载入处理任务：{reason}",
    "The processing list could not be read.": "无法读取处理任务列表。",
    "The app did not respond.": "App 没有响应。",
    "Last updated {time}.": "最后更新于 {time}。",
    "Retry 1 failed job?": "要重试 1 个失败任务吗？",
    "Retry {count} failed jobs?": "要重试 {count} 个失败任务吗？",
    "Each one is processed again with the current provider settings.": "每个任务都会用当前 provider 设置重新处理。",
    "1 job queued for retry.": "已有 1 个任务加入重试队列。",
    "{count} jobs queued for retry.": "已有 {count} 个任务加入重试队列。",
    "Invalid job selected": "选择的任务无效",
    "Remove credentials or secret tokens from the URL.": "请从 URL 中去掉凭证或密钥令牌。",
    "Remove the #fragment from the URL.": "请从 URL 中去掉 #片段。",
    "Use an https URL.": "请使用 https URL。",
    "Use a public host name such as docs.example.com.": "请使用公开的主机名，例如 docs.example.com。",
    "Choose a relation from the list.": "请从列表中选择一种关系。",
    "The summary must be 2,000 characters or fewer.": "摘要不能超过 2,000 个字符。",
    "Enter a one-line title of 200 characters or fewer.": "请输入不超过 200 个字符的单行标题。",
    "Enter a valid https URL.": "请输入有效的 https URL。",
    "That meeting is not available for shared resources.": "这场会议不能添加共享资源。",
    "Private, local, and reserved network addresses are not allowed.": "不允许使用私有、本地和保留的网络地址。",
    "This URL is already attached to that meeting.": "这个 URL 已经附在那场会议上。",
    "The resource could not be saved.": "无法保存这个资源。",
  });

  const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

  // Whole text first, then each sentence, so multi-sentence copy composes from sentence keys.
  function translateWikiMessage(message, choice, systemLocale = "en", vars = null) {
    if (typeof message !== "string" || !message) return "";
    const locale = i18n.resolveLocale(choice, systemLocale);
    if (locale !== "zh-CN") return i18n.fill(message, vars);
    if (has(MESSAGES, message)) return i18n.fill(MESSAGES[message], vars);
    const sentences = message.split(/(?<=[.?!])\s+/);
    if (sentences.length < 2) return i18n.fill(message, vars);
    return i18n.fill(i18n.joinSentences(sentences.map((sentence) => (has(MESSAGES, sentence) ? MESSAGES[sentence] : sentence)), choice, systemLocale), vars);
  }

  const applyStatic = i18n.createStaticApplier(STATIC);

  function applyWikiLocale(documentObject, choice, systemLocale = "en") {
    const locale = applyStatic(documentObject, choice, systemLocale);
    for (const { selector, attribute, english } of ATTRIBUTES) {
      const node = documentObject.querySelector(selector);
      if (!node) continue;
      node.setAttribute(attribute, locale === "zh-CN" && has(MESSAGES, english) ? MESSAGES[english] : english);
    }
    return locale;
  }

  const api = Object.freeze({
    applyWikiLocale,
    attributes: ATTRIBUTES,
    messages: MESSAGES,
    staticText: STATIC,
    translateWikiMessage,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalObject) globalObject.meetingWikiWikiLocalization = api;
})(typeof window === "undefined" ? null : window);
