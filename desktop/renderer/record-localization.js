"use strict";

// Simplified Chinese for the recording window: STATIC keys are record.html selectors and
// MESSAGES keys are English strings from record.js and record-window.js.

(function recordLocalization(globalObject) {
  const i18n = typeof module !== "undefined" && module.exports
    ? require("./i18n")
    : globalObject.meetingWikiI18n;

  const STATIC = Object.freeze({
    title: "开始录音",
    "#bridge-missing": "录音窗口无法连接 App。请关闭窗口，然后从菜单栏重新操作。",
    "#record-heading": "开始录音",
    "#record-intro": "确认以下信息后开始。按下“开始录音”之前不会录任何内容。",
    "label[for='record-title']": "会议标题（可选）",
    "#record-title-hint": "留空时，会根据讨论内容自动命名。",
    ".record-privacy > legend": "笔记保存位置",
    "label[for='record-shared'] .record-choice-title": "Shared wiki",
    "#record-shared-desc": "笔记、人物、话题、决策和待办会更新这台 Mac 上的 Shared wiki。",
    "label[for='record-private'] .record-choice-title": "Private",
    "#record-private-desc": "笔记只保存在这台 Mac 的私密文件夹中，不会更新 Shared wiki，也不会通过 MCP 返回、同步到 S3 或发送给任务 provider。",
    "label[for='record-live-enabled']": "启动实时字幕、翻译和滚动总结",
    "#record-live-enabled-desc": "provider 支持 live 功能时，开始录音后会自动打开侧栏。",
    "#record-open-setup": "打开设置向导",
    "#record-open-microphone": "打开麦克风设置",
    "#record-details-heading": "开始前确认",
    "#record-details > dt:nth-of-type(1)": "采集",
    "#record-details > dt:nth-of-type(2)": "系统音频",
    "#record-open-system-audio": "打开系统音频设置",
    "#record-details > dt:nth-of-type(3)": "处理",
    "#record-details > dt:nth-of-type(4)": "时长上限",
    "#record-details > dt:nth-of-type(5)": "实时字幕",
    ".record-consent": "请告诉会议中的每个人你正在录音。",
    "#record-cancel": "取消",
    "#record-start": "开始录音",
  });

  const MESSAGES = Object.freeze({
    "Start a recording": "开始录音",
    "Checking.": "正在检查。",
    "Choose recording defaults": "选择录音默认值",
    "Choose once. Future starts use these defaults until you change them in Settings.": "只需选择一次。之后每次开始录音都会使用这些默认值，直到你在 Settings 中修改。",
    "blocked in System Settings": "已在系统设置中阻止",
    "restricted by a device policy": "受设备策略限制",
    "macOS asks when recording starts": "开始录音时 macOS 会询问",
    "status not reported": "未报告状态",
    "Your microphone": "你的麦克风",
    "{label} ({note})": "{label}（{note}）",
    "{microphone} and all audio played on this Mac, including other participants.": "{microphone}，以及这台 Mac 播放的全部音频（包括其他参会者）。",
    "Other participants are captured from all audio played on this Mac. macOS controls this with the System Audio Recording permission, which Meeting Wiki cannot check in advance. If participants were silent in an earlier recording, allow Meeting Wiki there.": "其他参会者的声音来自这台 Mac 播放的全部音频。macOS 通过 System Audio Recording 权限控制这一项，Meeting Wiki 无法提前检查。如果之前的录音里其他参会者没有声音，请在那里允许 Meeting Wiki。",
    "Setup is not finished, so recording cannot start. Open setup to choose a provider.": "设置尚未完成，无法开始录音。请打开设置向导选择 provider。",
    "Microphone access is blocked, so recording cannot start. Allow Meeting Wiki in System Settings, Privacy & Security, Microphone, then reopen this window.": "麦克风权限被阻止，无法开始录音。请在系统设置的隐私与安全性、麦克风中允许 Meeting Wiki，然后重新打开此窗口。",
    "Google Gemini": "Google Gemini",
    "your online provider": "你的在线 provider",
    "the providers in your configuration": "配置中的 provider",
    "After you stop, audio is processed by {where}.": "停止录音后，音频由 {where} 处理。",
    "Private notes stay in the private folder on this Mac.": "Private 笔记保存在这台 Mac 的私密文件夹中。",
    "Notes go to your shared wiki on this Mac.": "笔记会进入这台 Mac 上的 Shared wiki。",
    "Recording stops on its own after {minutes} minutes and is processed like a normal stop. Change this in Settings.": "录音会在 {minutes} 分钟后自动停止，并像正常停止一样处理。可以在 Settings 中修改。",
    "The length limit could not be read.": "无法读取时长上限。",
    "Off for this recording. Batch processing still runs after you stop.": "本次录音不启用。停止后仍会正常处理录音。",
    "Live captions, translation, and rolling summary start with the recording.": "实时字幕、翻译和滚动总结会随录音一起启动。",
    "Live captions cover your microphone and all audio played on this Mac, including other participants, each labeled.": "实时字幕覆盖你的麦克风和这台 Mac 播放的全部音频（包括其他参会者），并分别标注。",
    "They are display-only and never change saved notes.": "它们只用于显示，不会改变保存的笔记。",
    "Not available with this provider, so no live window opens. The recording is still processed after you stop.": "当前 provider 不支持，因此不会打开实时窗口。停止后仍会处理录音。",
    "Unavailable because the Meeting Wiki engine is missing. Reinstall the app.": "Meeting Wiki 引擎缺失，因此不可用。请重新安装 App。",
    "Unavailable because the API key could not be read. Run setup again. The audio is still saved.": "无法读取 API key，因此不可用。请重新运行设置向导。录音仍会保存。",
    "A live window opens only if your hand-edited configuration supports live captions.": "只有手动编辑的配置支持实时字幕时，才会打开实时窗口。",
    "Microphone audio and all audio played on this Mac are sent to {where} for captions.": "麦克风音频和这台 Mac 播放的全部音频会发送给 {where} 用于字幕。",
    "Microphone audio and all audio played on this Mac are sent to {where} for captions, including for this private meeting.": "麦克风音频和这台 Mac 播放的全部音频会发送给 {where} 用于字幕，这场私密会议也一样。",
    "They run on this Mac.": "它们在这台 Mac 上运行。",
    "A recording is already running. Stop it from the menu bar first.": "已经有录音正在进行。请先从菜单栏停止它。",
    "Choose where the notes go before starting.": "开始前请选择笔记保存位置。",
    "Keep the title to {max} characters or fewer.": "标题不能超过 {max} 个字符。",
    "Keep the title to 200 characters or fewer.": "标题不能超过 200 个字符。",
    "Starting a private recording.": "正在开始私密录音。",
    "Starting the recording.": "正在开始录音。",
    "The recording details could not be read.": "无法读取录音信息。",
    "The recording window cannot reach the app. Close it and use the menu bar again.": "录音窗口无法连接 App。请关闭窗口，然后从菜单栏重新操作。",
    "The app did not respond. Try again.": "App 没有响应，请重试。",
    "Finish setup before recording.": "录音前请先完成设置。",
    "Microphone access is blocked. Allow it in System Settings, then try again.": "麦克风权限被阻止。请在系统设置中允许后重试。",
    "Enter the title as plain text.": "请用纯文本输入标题。",
    "Remove control characters from the title.": "请删除标题中的控制字符。",
    "Choose whether live captions, translation, and summary start for this recording.": "请选择本次录音是否启动实时字幕、翻译和总结。",
    "A recording is already running.": "已经有录音正在进行。",
    "That privacy setting cannot be opened.": "无法打开这个隐私设置。",
    "The recording could not start. Try again.": "无法开始录音，请重试。",
    "This request did not come from the recording window.": "此请求不是来自录音窗口。",
  });

  const api = Object.freeze({
    applyRecordLocale: i18n.createStaticApplier(STATIC),
    joinSentences: i18n.joinSentences,
    messages: MESSAGES,
    staticText: STATIC,
    translateRecordMessage: i18n.createTranslator(MESSAGES),
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalObject) globalObject.meetingWikiRecordLocalization = api;
})(typeof window === "undefined" ? null : window);
