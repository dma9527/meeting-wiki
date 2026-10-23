"use strict";

(function settingsLocalization(globalObject) {
  const ZH = Object.freeze({
    title: "Meeting Wiki 设置",
    ".wordmark-sub": "设置",
    "#settings-loading": "正在加载设置。",
    "#bridge-missing": "Settings 无法连接 App。请关闭窗口并重新打开 Meeting Wiki。",
    "#unsupported-heading": "设置不可用",
    "#unsupported-rerun": "重新运行设置向导",
    "#identity-settings-heading": "会议中的姓名",
    "#panel-identity-settings > .lede": "麦克风声道始终归属于这个姓名。别名用于合并其他称呼和转写写法。",
    "label[for='primary-profile-name']": "主要姓名",
    "label[for='profile-aliases']": "别名",
    "#identity-save": "保存姓名",
    "#language-settings-heading": "语言",
    "#panel-language-settings > .lede": "分别选择语音识别、实时翻译、实时总结、记忆内容和设置界面的语言。更改设置不会自动重写已有会议或已完成的分析；明确执行更正重处理时会使用当前 memory 语言。",
    "#language-migration-notice": "当前配置使用旧版自定义语言值。请为每个空白字段选择支持的值后再保存。",
    "label[for='transcript-language']": "会议语音",
    "#transcript-language-hint": "用于实时转写和录音完成后的转写。",
    "label[for='live-translation-language']": "实时翻译",
    "label[for='live-summary-language']": "实时总结",
    "label[for='memory-language']": "记忆与 Wiki 内容",
    "#memory-language-hint": "影响之后生成的内容。稳定的 Markdown 标题仍使用英文。",
    "label[for='ui-language']": "设置界面语言",
    "#ui-language option[value='system']": "跟随 macOS",
    "#ui-language option[value='en']": "English",
    "#ui-language option[value='zh-CN']": "简体中文",
    "#transcript-language option[value='auto']": "自动检测",
    "#language-save": "保存语言",
    "#recording-settings-heading": "录音默认值",
    "#panel-recording-settings > .lede": "普通开始操作直接使用这些设置。Start with options 只覆盖当前一次，会议标题不会保存为默认值。",
    "#recording-defaults-notice": "请先选择 privacy 和 live 默认值。保存前，普通开始会打开选项面板，自动录音不会启动 live 功能。",
    "label[for='max-duration-minutes']": "最长会议时长（分钟）",
    "#default-privacy-mode > legend": "默认保存位置",
    "label[for='default-privacy-shared']": "Shared wiki，除非日历或标题规则判定为私密",
    "label[for='default-privacy-private']": "这台 Mac 上的 Private 文件夹",
    "label[for='recording-live-enabled']": "自动启动实时字幕、翻译和滚动总结",
    "#recording-live-enabled-hint": "Provider 支持时会自动打开 live sidebar。外部 provider 会收到麦克风音频和转写文本，包括 Private 录音。Live 不可用时，录音和 batch processing 仍会继续。",
    "#recording-save": "保存录音默认值",
    "#integration-settings-heading": "自动录音",
    "#panel-integration-settings > .lede": "开启后，Meeting Wiki 会在你加入会议时立即开始录音，离开时停止、保存并处理。录音开始前没有倒计时。录音时托盘图标会切换为录音状态，并显示通知。10 秒内结束的会议会被丢弃，不会处理。Zoom 和 Google Meet 默认关闭。",
    "#auto-record-privacy > legend": "自动录音的保存位置",
    "#auto-record-privacy-notice": "旧版本会把所有自动录音保存到 Shared wiki。在你选择下面的选项并保存之前，仍会沿用该行为。",
    "label[for='auto-record-privacy-private']": "Private：只保存在这台 Mac 的私密文件夹",
    "label[for='auto-record-privacy-calendar']": "跟随日历：只有匹配且非私密的日历会议才共享",
    "label[for='auto-record-privacy-shared']": "Shared wiki，除非日历或标题规则判定为私密",
    "#auto-record-privacy-hint": "Private 是默认值。跟随日历会在录音开始时检查匹配的日历事件，只决定一次，并在重试时保持该决定。没有日历或没有匹配事件时保持私密。手动录音使用已保存的默认值。选择 Start with options 可以只覆盖当前一次。",
    "label[for='zoom-auto-record']": "自动录制 Zoom 会议",
    "#zoom-heading": "Zoom App",
    "#zoom-auto-record-boundary": "Meeting Wiki 每 3 秒只在这台 Mac 上检查 Zoom 进程、音频连接和显示唤醒状态。它不读取窗口、聊天、参会者或会议标题，不使用辅助功能权限，也不打开网络端口。无法检测浏览器中的 Zoom。",
    "label[for='google-meet-auto-record']": "自动录制 Google Meet 会议",
    "#google-meet-heading": "Chrome、Edge、Brave 或 Chromium 中的 Google Meet",
    "#google-meet-auto-record-boundary": "需要 Meeting Wiki Google Meet extension。它只检查 meet.google.com 标签页是否显示 Leave call 按钮，并发送 joined 或 left 以及 meeting code。它不读取字幕、转写、聊天、参会者或浏览历史。开启后会安装一个仅供该 extension 使用的浏览器连接。事件只通过这台 Mac 上的私密文件夹传递，不会打开网络端口。",
    "#show-meet-extension": "显示 extension 文件夹",
    "#meet-load-instructions": "在浏览器中打开 extensions 页面，开启 Developer mode，选择 Load unpacked，然后选择刚才打开的文件夹。每个浏览器只需设置一次。",
    "#integration-save": "保存自动录音",
    "#gemini-settings-heading": "Gemini 功能",
    "#panel-gemini-settings > .lede": "选择 Gemini 模型和 live 参数。API key 保存在 macOS Keychain，不会在这里显示或修改。",
    "#gemini-models-heading": "模型",
    "#gemini-live-heading": "Live",
    "label[for='batch-audio-model']": "录音转写模型",
    "label[for='live-model']": "实时转写模型",
    "label[for='language-model']": "总结与翻译模型",
    "label[for='summary-context-characters']": "总结上下文字符数",
    "#settings-rerun": "重新运行设置向导",
    "#settings-save": "保存 Gemini 设置",
    "#gemini-rerun-hint": "更换 API key 或 provider 请重新运行设置向导。",
  });

  const APPLIES_ZH = Object.freeze({
    immediate: "立即应用于当前 Settings 窗口和之后打开的窗口。",
    processing: "应用于之后处理的会议，包括队列中尚未处理的会议。Processing 会自动重启，已有 Wiki 内容不会改变。",
    liveSession: "从下一次录音的 live 功能开始应用。当前已打开的 live view 保持原设置。",
    processingAndLive: "应用于之后处理的会议和下一次录音的 live 功能。Processing 会自动重启。",
    nextRecording: "从下一次录音开始应用。正在进行的录音保持原设置。",
    integration: "立即应用。关闭监控不会停止正在进行的录音。",
    autoRecordPrivacy: "从下一次自动录音开始应用。正在进行的录音保持开始时的 privacy。",
    setupFinish: "通过检查并完成设置向导后应用。在此之前继续使用当前 provider。",
  });
  const MESSAGE_ZH = Object.freeze({
    "Saved.": "已保存。",
    "Saved. Nothing changed.": "已保存，没有变化。",
    "Fix the highlighted fields.": "请修正标出的字段。",
    "Fix the highlighted field.": "请修正标出的字段。",
    "Saving your name.": "正在保存姓名。",
    "Saving languages.": "正在保存语言。",
    "Saving recording defaults.": "正在保存录音默认值。",
    "Saving automatic recording.": "正在保存自动录音。",
    "Saving settings.": "正在保存设置。",
    "Choose a supported value for every language.": "请为每种语言选择支持的值。",
    "Choose where automatic recordings go.": "请选择自动录音的保存位置。",
    "The app did not respond. Try again.": "App 没有响应，请重试。",
    "Settings cannot reach the app. Close this window and reopen Meeting Wiki.": "Settings 无法连接 App。请关闭窗口并重新打开 Meeting Wiki。",
    "Settings could not complete this step.": "Settings 无法完成此操作。",
    "This request did not come from the settings window.": "此请求不是来自 Settings 窗口。",
    "Automatic recording is not available in this build.": "当前 build 不支持自动录音。",
    "Run setup again to manage settings here.": "请重新运行设置向导后再管理这些设置。",
    "The settings could not be saved.": "设置无法保存。",
    "Open Languages and choose supported values before saving Gemini settings.": "请先在语言设置中选择支持的值，再保存 Gemini 设置。",
    "Open Settings and choose supported languages before switching providers.": "切换 provider 前，请先打开 Settings 并选择支持的语言。",
    "Enter a valid model name.": "请输入有效的模型名称。",
    "Enter a name.": "请输入姓名。",
    "Use letters, numbers, spaces, and . , ' - _ ( ) starting with a letter or number.": "请使用字母、数字、空格和 . , ' - _ ( )，并以字母或数字开头。",
    "Each alias must differ from your name and the other aliases.": "每个别名必须与主要姓名和其他别名不同。",
    "Names may use letters, numbers, spaces, and . , ' - _ ( ) and must start with a letter or number.": "姓名只能使用字母、数字、空格和 . , ' - _ ( )，并且必须以字母或数字开头。",
    "Enter aliases one per line.": "请每行输入一个别名。",
    "An alias repeats your primary name.": "别名与主要姓名重复。",
    "Each alias must be different.": "每个别名必须不同。",
    "Choose private or shared as the recording default.": "请选择 Private 或 Shared 作为录音默认值。",
    "Choose whether live captions, translation, and summary start automatically.": "请选择是否自动启动实时字幕、翻译和总结。",
    "Choose on or off for each integration.": "请为每个 integration 选择开启或关闭。",
    "Choose private, calendar, or shared for automatic recordings.": "请为自动录音选择 Private、Calendar 或 Shared。",
    "The recording settings file could not be read, so it was left unchanged.": "无法读取录音设置文件，因此未作修改。",
    "The recording settings could not be saved.": "录音设置无法保存。",
    "The integration settings could not be saved.": "Integration 设置无法保存。",
    "Recording defaults changed. Close and reopen Settings before saving.": "录音默认值已经改变。请关闭并重新打开 Settings 后再保存。",
    "Choose one of the available language options.": "请选择可用的语言选项。",
    "Shown on your microphone channel and owned action items.": "显示在你的麦克风声道和分配给你的 action items 中。",
    "Taken from the older user_name setting. Save to keep it as your primary name.": "当前值来自旧版 user_name 设置。保存后会作为主要姓名。",
    "Not set yet, so your microphone is labeled User.": "尚未设置，因此麦克风声道会显示为 User。",
    "These settings cover Gemini only. Run setup again to configure another provider.": "这些设置只适用于 Gemini。要配置其他 provider，请重新运行设置向导。",
    "Your configuration was not created by setup or was edited by hand. Run setup again to manage it here.": "当前配置不是由设置向导创建，或已经被手动修改。请重新运行设置向导。",
    "Finish setup first. Your name and aliases can be edited here once setup is complete.": "请先完成设置向导，然后再修改姓名和别名。",
    "Finish setup first. The recording length limit can be changed here once setup is complete.": "请先完成设置向导，然后再修改录音默认值。",
    "Finish setup first. Automatic recording can be turned on here once setup is complete.": "请先完成设置向导，然后再开启自动录音。",
    "Zoom app found in Applications.": "已在 Applications 中找到 Zoom App。",
    "Zoom app not found in Applications.": "未在 Applications 中找到 Zoom App。",
    "macOS process tools available.": "macOS 进程工具可用。",
    "macOS process tools are missing, so Zoom meetings cannot be detected.": "缺少 macOS 进程工具，因此无法检测 Zoom 会议。",
    "No supported browser found.": "未找到支持的浏览器。",
    "Extension included with this app.": "App 中已包含 extension。",
    "Extension missing from this build.": "当前 build 缺少 extension。",
    "Extension not seen since Meeting Wiki started. After loading it, open or reload a Meet tab.": "Meeting Wiki 启动后尚未收到 extension 的连接。加载后请打开或重新加载 Meet 标签页。",
  });

  function translateSettingsMessage(message, choice, systemLocale = "en") {
    if (resolveSettingsLocale(choice, systemLocale) !== "zh-CN") return message;
    if (MESSAGE_ZH[message]) return MESSAGE_ZH[message];
    if (message.startsWith("Saved. ")) {
      return `已保存。${message.slice("Saved. ".length)}`;
    }
    let match = /^From (\d+) to (\d+) minutes\.$/.exec(message);
    if (match) return `范围为 ${match[1]} 到 ${match[2]} 分钟。`;
    match = /^From (\d+) to (\d+)\. Recent transcript text kept for live summaries\.$/.exec(message);
    if (match) return `范围为 ${match[1]} 到 ${match[2]}。用于 live summary 的最近转写文本会保留在这个范围内。`;
    match = /^One per line, up to (\d+)\./.exec(message);
    if (match) return `每行一个，最多 ${match[1]} 个。可以填写昵称或日历中的姓名写法。`;
    match = /^Enter a whole number from (\d+) to (\d+)\.$/.exec(message);
    if (match) return `请输入 ${match[1]} 到 ${match[2]} 之间的整数。`;
    match = /^Enter a whole number of summary context characters from (\d+) to (\d+)\.$/.exec(message);
    if (match) return `总结上下文字符数必须是 ${match[1]} 到 ${match[2]} 之间的整数。`;
    match = /^Enter a whole number of minutes from (\d+) to (\d+)\.$/.exec(message);
    if (match) return `会议时长必须是 ${match[1]} 到 ${match[2]} 之间的整数分钟。`;
    match = /^Enter a valid (recording transcription|live transcription|summary and translation) model name\.$/.exec(message);
    if (match) {
      const labels = {
        "recording transcription": "录音转写",
        "live transcription": "实时转写",
        "summary and translation": "总结与翻译",
      };
      return `请输入有效的${labels[match[1]]}模型名称。`;
    }
    match = /^Keep names? to (\d+) characters or fewer\.$/.exec(message);
    if (match) return `姓名不能超过 ${match[1]} 个字符。`;
    match = /^Keep each name to (\d+) characters or fewer\.$/.exec(message);
    if (match) return `每个姓名不能超过 ${match[1]} 个字符。`;
    match = /^Add at most (\d+) aliases\.$/.exec(message);
    if (match) return `最多添加 ${match[1]} 个别名。`;
    match = /^Enter (your name as it should appear in meeting notes|each alias)\.$/.exec(message);
    if (match) return match[1] === "each alias" ? "请输入每个别名。" : "请输入要显示在会议记录中的姓名。";
    match = /^Extension last checked in at (.+)\.$/.exec(message);
    if (match) return `Extension 上次连接时间：${match[1]}。`;
    match = /^(.{1,40}): (.+)$/.exec(message);
    if (match) {
      const translatedDetail = translateSettingsMessage(match[2], choice, systemLocale);
      if (translatedDetail !== match[2]) return `${match[1]}：${translatedDetail}`;
    }
    if (message.startsWith("Settings never change a hand-edited configuration.")) {
      return "Settings 不会修改手动编辑的配置。你的修改会从下一次录音和重新打开 App 后的 processing 开始生效。";
    }
    return message;
  }

  function localizedApplies(code, fallback, choice, systemLocale = "en") {
    return resolveSettingsLocale(choice, systemLocale) === "zh-CN"
      ? APPLIES_ZH[code] || fallback
      : fallback;
  }

  function isChinese(choice, systemLocale = "en") {
    return resolveSettingsLocale(choice, systemLocale) === "zh-CN";
  }

  function microphonePermissionLine(status, choice, systemLocale = "en") {
    if (!isChinese(choice, systemLocale)) return null;
    if (status === "granted") return "麦克风权限：已允许。";
    if (status === "denied") return "麦克风权限：已拒绝。允许之前录音无法开始。";
    if (status === "restricted") return "麦克风权限：受到设备策略限制。允许之前录音无法开始。";
    if (status === "not-determined") return "麦克风权限：尚未询问。第一次录音时 macOS 会请求权限。";
    return "麦克风权限：状态未知。请在 System Settings 中检查。";
  }

  function systemAudioPermissionLine(choice, systemLocale = "en") {
    return isChinese(choice, systemLocale)
      ? "系统音频权限无法提前检查。如果其他参会者没有声音，请在 System Settings 的 System Audio Recording 中允许 Meeting Wiki。"
      : null;
  }

  const ZOOM_STATE_ZH = Object.freeze({
    off: "未监控 Zoom 会议。",
    starting: "正在启动 Zoom 会议监控。",
    "zoom-closed": "正在监控，Zoom 未打开。",
    "zoom-open": "正在监控，Zoom 已打开但当前不在会议中。",
    "in-meeting": "正在监控，Zoom 会议正在进行。",
    unavailable: "正在监控，但上一次检查没有完成，几秒后会重试。",
  });
  const MEET_STATE_ZH = Object.freeze({
    off: "未监控 Google Meet。",
    watching: "正在监控，当前没有 Google Meet 通话。",
    "in-meeting": "正在监控，Google Meet 通话正在进行。",
  });

  function detectorLine(kind, state, fallback, choice, systemLocale = "en") {
    if (!isChinese(choice, systemLocale)) return fallback;
    const catalog = kind === "zoom" ? ZOOM_STATE_ZH : MEET_STATE_ZH;
    return catalog[state] || fallback;
  }

  function browserConnectionLine(name, connected, choice, systemLocale = "en") {
    if (!isChinese(choice, systemLocale)) {
      return `${name}: ${connected ? "connection installed." : "found, connection not installed. Turn this on and save."}`;
    }
    return connected
      ? `${name}：连接已安装。`
      : `${name}：已找到浏览器，但连接未安装。请开启自动录音并保存。`;
  }

  function resolveSettingsLocale(choice, systemLocale = "en") {
    if (choice === "zh-CN" || choice === "en") return choice;
    return String(systemLocale).toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  const originalText = new WeakMap();
  const originalTitles = new WeakMap();

  function applySettingsLocale(documentObject, choice, systemLocale = "en") {
    const locale = resolveSettingsLocale(choice, systemLocale);
    documentObject.documentElement.lang = locale;
    if (!originalTitles.has(documentObject)) originalTitles.set(documentObject, documentObject.title);
    documentObject.title = locale === "zh-CN" ? ZH.title : originalTitles.get(documentObject);
    for (const [selector, text] of Object.entries(ZH)) {
      if (selector === "title") continue;
      const node = documentObject.querySelector(selector);
      if (!node) continue;
      if (!originalText.has(node)) originalText.set(node, node.textContent);
      node.textContent = locale === "zh-CN" ? text : originalText.get(node);
    }
    return locale;
  }

  const api = Object.freeze({
    applySettingsLocale,
    browserConnectionLine,
    detectorLine,
    isChinese,
    localizedApplies,
    microphonePermissionLine,
    resolveSettingsLocale,
    systemAudioPermissionLine,
    translateSettingsMessage,
    zh: ZH,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalObject) globalObject.meetingWikiSettingsLocalization = api;
})(typeof window === "undefined" ? null : window);
