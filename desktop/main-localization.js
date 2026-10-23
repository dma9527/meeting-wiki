"use strict";

// Simplified Chinese for main-process text (tray, notifications, dialogs). Keys are the
// English source; a missing key falls back to English.

const i18n = require("./renderer/i18n");

const SKILL_PATH = "~/.claude/skills/meeting-wiki-memory/SKILL.md";

const MESSAGES = Object.freeze({
  // Tray menu.
  "Live captions, translation, and summary unavailable. Recording continues.": "实时字幕、翻译和总结不可用，录音继续。",
  "Show live captions": "显示实时字幕",
  "Stop and process": "停止并处理",
  "Stop and discard": "停止并丢弃",
  "Start recording": "开始录音",
  "Start with options...": "带选项开始...",
  "Import audio...": "导入音频...",
  "Processing status unavailable": "处理状态不可用",
  "Checking processing status...": "正在检查处理状态...",
  "Retry failed processing": "重试失败的处理",
  "Run self-check...": "运行自检...",
  "Open logs": "打开日志",
  "Open Wiki & Corrections": "打开 Wiki & Corrections",
  "Install Claude skill for meeting memory...": "安装会议记忆 Claude skill...",
  "Adds a data-free skill so Claude can search your meeting memory.": "添加一个不含会议数据的 skill，让 Claude 可以搜索你的会议记忆。",
  "Never overwrites files.": "不会覆盖任何文件。",
  "Install command-line tools...": "安装命令行工具...",
  "Open wiki": "打开 wiki",
  "Open private meetings": "打开私密会议",
  "Settings...": "设置...",
  "Run setup...": "运行设置向导...",
  "Edit configuration": "编辑配置文件",
  "Settings never change a hand-edited configuration.": "“设置”不会修改手动编辑的配置。",
  "Your own edits apply to live captions from the next recording and to processing after you quit and reopen Meeting Wiki.": "你自己的修改会从下一次录音的实时字幕开始生效，会议处理则在退出并重新打开 Meeting Wiki 后生效。",
  Quit: "退出",
  "Recording {elapsed} of {limit}": "录音中 {elapsed} / {limit}",
  "Saving recording...": "正在保存录音...",
  "Last recording stopped at the time limit": "上次录音已在时长上限处停止",
  "Action required: {count} failed": "需要处理：{count} 个失败",
  "Processing: {count}": "正在处理：{count}",
  "Processing: {count} ({stages})": "正在处理：{count}（{stages}）",
  ", ": "、",
  queued: "排队中",
  transcribing: "转写中",
  analyzing: "分析中",
  rendering: "生成中",
  integrating: "整合中",
  done: "已完成",
  "All meetings processed": "所有会议都已处理",
  "No meetings yet": "还没有会议",

  // Notifications.
  "Live features unavailable": "实时功能不可用",
  "The selected provider does not support live captions, translation, and summary.": "所选 provider 不支持实时字幕、翻译和总结。",
  "The Meeting Wiki engine is unavailable.": "Meeting Wiki 引擎不可用。",
  "Recording continues, but live and processing need the app to be reinstalled.": "录音会继续，但实时功能和会议处理需要重新安装 App。",
  "The provider key could not be read.": "无法读取 provider key。",
  "Recording continues, but live and processing remain paused until setup is repaired.": "录音会继续，但修复设置之前，实时功能和会议处理会保持暂停。",
  "The configured live provider is unavailable.": "配置的 live provider 不可用。",
  "Recording and batch processing continue normally.": "录音和会后处理正常进行。",
  "Live microphone audio did not become available.": "实时麦克风音频没有就绪。",
  "The live provider cannot use this microphone audio.": "live provider 无法使用这路麦克风音频。",
  "Live transcription stopped.": "实时转写已停止。",
  "Live transcription could not connect to the provider.": "实时转写无法连接 provider。",
  "Run self-check for details.": "请运行自检查看详情。",
  "Live translation and summary stopped.": "实时翻译和总结已停止。",
  "Live captions, translation, and summary could not start.": "实时字幕、翻译和总结无法启动。",
  "Recording continues normally.": "录音正常进行。",
  "The live connection ended.": "实时连接已断开。",
  "The live provider session expired and could not resume.": "live provider 会话已过期，无法恢复。",
  "Audio capture error": "音频采集出错",
  "Recording encountered an audio problem.": "录音遇到了音频问题。",
  "Open logs for details.": "请打开日志查看详情。",
  "System audio was not captured": "没有采集到系统音频",
  "Your microphone recording will continue, but Zoom or Google Meet participants were silent.": "麦克风录音会继续，但 Zoom 或 Google Meet 参会者没有声音。",
  "Check Screen & System Audio Recording permission before the next meeting.": "下次会议前请在系统设置中检查“录屏与系统录音”权限。",
  "Short meeting not kept": "短会议未保留",
  "The meeting ended within 10 seconds, so the recording was discarded and not processed.": "会议在 10 秒内结束，录音已丢弃，不会处理。",
  "Meeting processing paused": "会议处理已暂停",
  "The online API key could not be read from the macOS Keychain.": "无法从 macOS Keychain 读取在线 API key。",
  "The Gemini API key could not be read from the macOS Keychain.": "无法从 macOS Keychain 读取 Gemini API key。",
  "Run setup again.": "请重新运行设置向导。",
  "Meeting Wiki installation damaged": "Meeting Wiki 安装已损坏",
  "The bundled Python runtime is missing from the app.": "App 中缺少内置的 Python runtime。",
  "The bundled sox audio tool is missing from the app.": "App 中缺少内置的 sox 音频工具。",
  "The bundled rec audio tool is missing from the app.": "App 中缺少内置的 rec 音频工具。",
  "Reinstall Meeting Wiki.": "请重新安装 Meeting Wiki。",
  "Meeting Wiki setup required": "需要设置 Meeting Wiki",
  "Self-check did not finish": "自检没有完成",
  "Open logs or try again.": "请打开日志或重试。",
  "Meeting processing resumed": "会议处理已恢复",
  "1 failed job queued.": "已重新排队 1 个失败任务。",
  "{count} failed jobs queued.": "已重新排队 {count} 个失败任务。",
  "Retry failed": "重试失败",
  "Status command returned invalid JSON": "状态命令返回了无效的 JSON",
  "Processing action returned invalid JSON": "处理操作返回了无效的 JSON",
  "Status command returned an invalid job": "状态命令返回了无效的任务",
  "Invalid job selected": "选择的任务无效",
  "Unable to list processing jobs": "无法列出处理任务",
  "Status command returned invalid jobs": "状态命令返回了无效的任务列表",
  "Processing action could not be completed": "处理操作无法完成",
  "Processing action returned an invalid result": "处理操作返回了无效结果",
  "Unable to read processing status": "无法读取处理状态",
  "Status command returned invalid counts": "状态命令返回了无效的计数",
  "Command-line tools not installed": "命令行工具未安装",
  "Try again from the menu bar.": "请从菜单栏重试。",
  "Meeting queued": "会议已加入队列",
  "Meeting queue failed": "会议加入队列失败",
  "Saved recordings were not queued": "已保存的录音未能加入队列",
  "Meeting Wiki will try again at next launch.": "Meeting Wiki 会在下次启动时重试。",
  "Saved recordings queued": "已保存的录音已加入队列",
  "1 recording was queued for processing.": "1 个录音已加入处理队列。",
  "{count} recordings were queued for processing.": "{count} 个录音已加入处理队列。",
  "Saved recordings need attention": "已保存的录音需要处理",
  "1 saved recording could not be queued.": "1 个已保存的录音无法加入队列。",
  "{count} saved recordings could not be queued.": "{count} 个已保存的录音无法加入队列。",
  "Import the audio to process it.": "请导入音频进行处理。",
  "Recording defaults not saved": "录音默认设置未保存",
  "This recording will start, but Meeting Wiki will ask again next time.": "这次录音会开始，但下次 Meeting Wiki 还会再询问。",
  "Recording failed": "录音失败",
  "Audio capture could not start.": "无法开始音频采集。",
  "Check permissions and reinstall if the problem continues.": "请检查权限，如果问题仍然存在，请重新安装。",
  "Private recording started": "私密录音已开始",
  "Recording started": "录音已开始",
  "Automatic recording is running.": "自动录音正在进行。",
  "Meeting {time}": "会议 {time}",
  "Recording stopped at the time limit": "录音已在时长上限处停止",
  "The maximum meeting length was reached.": "已达到会议时长上限。",
  "Your recording is being saved and processed.": "正在保存并处理你的录音。",
  "Recording saved": "录音已保存",
  "The recording was saved and queued for processing.": "录音已保存并加入处理队列。",
  "The recording could not be finalized.": "录音无法完成保存。",
  "Google Meet automatic recording needs attention": "Google Meet 自动录音需要处理",
  "Open Settings to check the browser connection.": "请打开“设置”检查浏览器连接。",
  "Saving your recording": "正在保存你的录音",
  "Meeting Wiki will quit after the recording is saved and queued.": "录音保存并加入队列后，Meeting Wiki 会退出。",

  // Dialogs.
  "Meeting Wiki": "Meeting Wiki",
  "Retry 1 failed job?": "要重试 1 个失败任务吗？",
  "Retry {count} failed jobs?": "要重试 {count} 个失败任务吗？",
  "Each one is processed again with the current provider settings.": "每个任务都会用当前 provider 设置重新处理。",
  "Open Wiki & Corrections to retry jobs one at a time.": "如需逐个重试，请打开 Wiki & Corrections。",
  "Import 1 audio file?": "要导入 1 个音频文件吗？",
  "Import {count} audio files?": "要导入 {count} 个音频文件吗？",
  "Each file is processed like a recording and named from what was discussed.": "每个文件都会像录音一样处理，并根据讨论内容命名。",
  "Keep private: notes stay only in the private folder on this Mac": "保持私密：笔记只保存在这台 Mac 的私密文件夹中",
  "Import audio": "导入音频",
  Audio: "音频",
  "Claude skill installed": "Claude skill 已安装",
  [`Installed ${SKILL_PATH}.`]: `已安装 ${SKILL_PATH}。`,
  "Claude skill already installed": "Claude skill 已经安装",
  [`${SKILL_PATH} is up to date.`]: `${SKILL_PATH} 已是最新。`,
  "Claude skill not installed": "Claude skill 未安装",
  [`${SKILL_PATH} already exists with different content.`]: `${SKILL_PATH} 已存在且内容不同。`,
  "It was left unchanged.": "已保持原样。",
  [`${SKILL_PATH} or its folder is a link or not a regular file.`]: `${SKILL_PATH} 或其所在文件夹是链接或不是普通文件。`,
  "Nothing was changed.": "没有做任何更改。",
  "The skill could not be written.": "无法写入 skill。",
  "Nothing was overwritten.": "没有覆盖任何内容。",
  "Install command-line tools?": "要安装命令行工具吗？",
  "This adds meeting-wiki and meeting-wiki-mcp to ~/.local/bin, readable only by you.": "这会把 meeting-wiki 和 meeting-wiki-mcp 添加到 ~/.local/bin，只有你可以读取。",
  "It never replaces a file that is already there.": "已有的文件永远不会被替换。",
  "The commands use the app in /Applications or ~/Applications, so they keep working after you update it.": "这些命令使用 /Applications 或 ~/Applications 中的 App，所以更新 App 后仍可使用。",
  "API keys stay with the app, so terminal commands that call your provider need the key in the environment.": "API key 只保存在 App 中，所以在终端调用 provider 的命令需要在环境变量中提供 key。",
  "Command-line tools installed": "命令行工具已安装",
  "meeting-wiki and meeting-wiki-mcp are in ~/.local/bin.": "meeting-wiki 和 meeting-wiki-mcp 已在 ~/.local/bin 中。",
  "Command-line tools already installed": "命令行工具已经安装",
  "meeting-wiki and meeting-wiki-mcp in ~/.local/bin are up to date.": "~/.local/bin 中的 meeting-wiki 和 meeting-wiki-mcp 已是最新。",
  "Some command-line tools were not installed": "部分命令行工具未安装",
  "A file or link named meeting-wiki or meeting-wiki-mcp already exists in ~/.local/bin with different content.": "~/.local/bin 中已存在名为 meeting-wiki 或 meeting-wiki-mcp 的文件或链接，且内容不同。",
  "Rename or remove it, then try again.": "请重命名或删除它，然后重试。",
  "~/.local or ~/.local/bin is not a folder.": "~/.local 或 ~/.local/bin 不是文件夹。",
  "The tools could not be written.": "无法写入这些工具。",
  "Nothing was replaced.": "没有替换任何内容。",
  "If your shell cannot find meeting-wiki, add this line to ~/.zshrc and open a new Terminal window:": "如果 shell 找不到 meeting-wiki，请把下面这行添加到 ~/.zshrc，然后打开新的终端窗口：",

  // Self-check dialog.
  "Meeting Wiki self-check": "Meeting Wiki 自检",
  "1 item needs attention.": "有 1 项需要处理。",
  "{count} items need attention.": "有 {count} 项需要处理。",
  "Everything Meeting Wiki needs is ready.": "Meeting Wiki 需要的一切都已就绪。",
  "{tone}  {label}: {text}": "{tone}  {label}：{text}",
  OK: "正常",
  Note: "提示",
  "Needs attention": "需要处理",
  "Microphone permission": "麦克风权限",
  "System audio permission": "系统音频权限",
  "Batch transcription": "会后转写",
  "Meeting analysis": "会议分析",
  "Live captions": "实时字幕",
  Storage: "存储",
  "Memory index": "记忆索引",
  "Claude skill": "Claude skill",
  "The Meeting Wiki engine is missing. Reinstall the app.": "缺少 Meeting Wiki 引擎，请重新安装 App。",
  "The API key could not be read from the Keychain. Run setup again.": "无法从 Keychain 读取 API key，请重新运行设置向导。",
  "The API key is not available. Run setup again.": "API key 不可用，请重新运行设置向导。",
  "Not configured. Run setup again or fix your configuration.": "尚未配置。请重新运行设置向导，或修正配置文件。",
  "Your configuration could not be read. Run setup again or fix it by hand.": "无法读取配置文件。请重新运行设置向导，或手动修正。",
  "The self-check did not finish. Open logs or try again.": "自检没有完成。请打开日志或重试。",
  "Not checked.": "未检查。",
  "Allowed.": "已允许。",
  "Blocked. Allow Meeting Wiki in System Settings, Privacy & Security, Microphone.": "已阻止。请在系统设置的“隐私与安全性”中，于“麦克风”里允许 Meeting Wiki。",
  "Restricted by a device policy. Recording cannot use the microphone.": "受设备策略限制，录音无法使用麦克风。",
  "Not asked yet. macOS asks the first time you record.": "尚未请求。第一次录音时 macOS 会询问。",
  "macOS did not report this permission.": "macOS 没有报告这项权限。",
  "Blocked. Remote participants will be silent. Allow Meeting Wiki in System Settings, Privacy & Security, Screen & System Audio Recording.": "已阻止，远程参会者会没有声音。请在系统设置的“隐私与安全性”中，于“录屏与系统录音”里允许 Meeting Wiki。",
  "Restricted by a device policy. Remote participants will be silent.": "受设备策略限制，远程参会者会没有声音。",
  "Ready.": "已就绪。",
  "Not responding. Use Test current setup in Run setup, or check your provider.": "没有响应。请在设置向导中使用“测试当前设置”，或检查 provider。",
  "Ready. Live captions are display-only and never change saved notes.": "已就绪。实时字幕只用于显示，不会改动已保存的笔记。",
  "Not available with this provider. Recording and processing still work.": "当前 provider 不支持。录音和会议处理仍可正常使用。",
  "Not ready. Recording and processing still work without live captions.": "未就绪。没有实时字幕时，录音和会议处理仍可正常使用。",
  "The live provider rejected the connection. Recording and processing still work without live captions.": "live provider 拒绝了连接。没有实时字幕时，录音和会议处理仍可正常使用。",
  "The live provider did not answer within 20 seconds. Check the network, then try again.": "live provider 在 20 秒内没有响应。请检查网络后重试。",
  "Ready on this Mac.": "已在这台 Mac 上就绪。",
  "The data folder does not exist yet. It is created when you record.": "数据文件夹尚不存在，会在录音时创建。",
  "The data folder cannot be written. Check its permissions.": "无法写入数据文件夹，请检查它的权限。",
  "Shared files go to S3, which is not checked here. Private files stay on this Mac.": "共享文件会保存到 S3，这里不检查 S3。私密文件留在这台 Mac 上。",
  "Empty. Memory fills in as meetings are processed.": "为空。处理会议后记忆会逐渐填充。",
  "Not built yet. It is created after the first processed meeting.": "尚未建立，会在处理完第一场会议后创建。",
  "Could not be read. Run meeting-wiki reindex-memory to rebuild it.": "无法读取。请运行 meeting-wiki reindex-memory 重建。",
  "Installed and up to date.": "已安装且是最新版本。",
  "Not installed. Use Install Claude skill in the menu to add it.": "未安装。请在菜单中选择“安装会议记忆 Claude skill”。",
  "A different SKILL.md is already there. It was left unchanged.": "那里已有不同的 SKILL.md，已保持原样。",
  "The skill folder is a link or not a regular file. Nothing was changed.": "skill 文件夹是链接或不是普通文件，没有做任何更改。",
  "Could not be checked.": "无法检查。",
  "Returned an unexpected result.": "返回了意外的结果。",
  "Google Gemini": "Google Gemini",
  "an OpenAI-compatible endpoint": "兼容 OpenAI 的 endpoint",
  "MLX Whisper on this Mac": "这台 Mac 上的 MLX Whisper",
  Ollama: "Ollama",
  "text import": "文本导入",
  "Recordings are transcribed by {provider}.": "录音由 {provider} 转写。",
  "Live captions send microphone audio and all audio played on this Mac to an external provider.": "实时字幕会把麦克风音频和这台 Mac 播放的全部音频发送给外部 provider。",
  "Live captions run on this Mac.": "实时字幕在这台 Mac 上运行。",
  "close code {code}": "关闭码 {code}",
  "Live connection error: {parts}. Details are also in live.log under Open logs.": "Live 连接错误：{parts}。详情也记录在“打开日志”中的 live.log。",
});

// Button labels are kept apart because "OK" is also a self-check status word.
const BUTTONS = Object.freeze({ OK: "好", Retry: "重试", Cancel: "取消", Import: "导入", Install: "安装" });

const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

// Whole key first, then each line and sentence; untranslated sentences keep English spacing.
function localizeText(message, locale, vars = null) {
  if (typeof message !== "string" || !message) return "";
  if (locale !== "zh-CN") return i18n.fill(message, vars);
  if (has(MESSAGES, message)) return i18n.fill(MESSAGES[message], vars);
  return message.split("\n").map((line) => {
    let result = "";
    for (const sentence of line.split(/(?<=\.)\s+/)) {
      const translated = i18n.fill(has(MESSAGES, sentence) ? MESSAGES[sentence] : sentence, vars);
      const joined = !result || /[\u3000-\u303f\uff00-\uffef]$/.test(result) ? "" : " ";
      result += joined + translated;
    }
    return result;
  }).join("\n");
}

function createMainTranslator({ readChoice, systemLocale }) {
  function locale() {
    let choice = "system";
    let system = "en";
    try { choice = readChoice(); } catch (_) { /* follow macOS */ }
    try { system = String(systemLocale() || "en"); } catch (_) { /* default */ }
    return i18n.resolveLocale(choice, system);
  }

  function text(message, vars = null) {
    return localizeText(message, locale(), vars);
  }

  function buttons(options, current = locale()) {
    if (current !== "zh-CN" || !Array.isArray(options.buttons)) return options;
    return { ...options, buttons: options.buttons.map((label) => (has(BUTTONS, label) ? BUTTONS[label] : label)) };
  }

  // Message boxes and open dialogs built from English source text.
  function dialog(options, vars = null) {
    const current = locale();
    const localized = { ...options };
    for (const field of ["title", "message", "detail", "checkboxLabel"]) {
      if (typeof options[field] === "string") localized[field] = localizeText(options[field], current, vars);
    }
    if (Array.isArray(options.filters)) {
      localized.filters = options.filters.map((filter) => ({ ...filter, name: localizeText(filter.name, current) }));
    }
    return buttons(localized, current);
  }

  function menuItems(items, current = locale()) {
    return items.map((item) => {
      const localized = { ...item };
      for (const field of ["label", "sublabel", "toolTip"]) {
        if (typeof item[field] === "string") localized[field] = localizeText(item[field], current);
      }
      if (Array.isArray(item.submenu)) localized.submenu = menuItems(item.submenu, current);
      return localized;
    });
  }

  // One config read for a whole tray rebuild, so every line uses the same language.
  function snapshot() {
    const current = locale();
    return {
      buttons: (options) => buttons(options, current),
      menuItems: (items) => menuItems(items, current),
      text: (message, vars = null) => localizeText(message, current, vars),
    };
  }

  return { buttons, dialog, locale, menuItems, snapshot, text };
}

module.exports = { BUTTONS, MESSAGES, createMainTranslator, localizeText };
