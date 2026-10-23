"use strict";

// Simplified Chinese for the live sidebar: STATIC keys are live-sidebar.html selectors and
// MESSAGES keys are English strings from live-sidebar.js.

(function liveSidebarLocalization(globalObject) {
  const i18n = typeof module !== "undefined" && module.exports
    ? require("./i18n")
    : globalObject.meetingWikiI18n;

  const STATIC = Object.freeze({
    title: "Meeting Wiki 实时",
    "#live-private": "私密会话",
    "#live-summary-heading": "总结",
    "#live-summary-empty": "说了几句话之后会出现总结。",
    "#live-transcript-heading": "转写与翻译",
    "#live-transcript-empty": "最终转写会显示在这里。",
    ".live-foot p:nth-child(1)": "实时字幕包括你的麦克风（标记为 You）和这台 Mac 播放的全部音频（包括其他参会者，标记为 Others）。",
    ".live-foot p:nth-child(2)": "实时文本只用于显示。保存的会议（包括系统音频）会在停止录音后处理。",
    ".live-foot p:nth-child(3)": "关闭这个窗口只会隐藏它。可以在菜单栏选择 Show live captions 再次显示。",
  });

  const MESSAGES = Object.freeze({
    "Starting live view.": "正在启动实时视图。",
    "Listening.": "正在聆听。",
    "Live view stopped.": "实时视图已停止。",
    "Live view is unavailable. Recording continues normally.": "实时视图不可用，录音正常进行。",
    "The recording audio is no longer available.": "录音音频已经不可用。",
    "The recording audio format is not supported for live view.": "实时视图不支持这种录音音频格式。",
    "The live provider is not ready. Check system health in the menu.": "live provider 尚未就绪。请在菜单中检查系统状态。",
    "Live transcription skipped a moment of audio.": "实时转写跳过了一小段音频。",
    "Live transcription could not connect to the provider. Recording continues normally.": "实时转写无法连接 provider，录音正常进行。",
    "Reconnecting to the live provider. Recording continues normally.": "正在重新连接 live provider，录音正常进行。",
    "Your microphone is no longer captioned. Other participants still are.": "你的麦克风已不再显示字幕，其他参会者仍在显示。",
    "Other participants are no longer captioned. Your microphone still is.": "其他参会者已不再显示字幕，你的麦克风仍在显示。",
    "No audio from other participants yet. If they are speaking, check System Audio Recording permission in System Settings.": "还没有收到其他参会者的声音。如果他们正在说话，请在系统设置中检查 System Audio Recording 权限。",
    "Translation or summary is temporarily unavailable.": "翻译或总结暂时不可用。",
    "Renewing the live provider session. Recording continues normally.": "正在续接 live provider 会话，录音正常进行。",
    "The live provider session expired and could not be renewed.": "live provider 会话已过期，无法续接。",
    "Live view could not start.": "实时视图无法启动。",
    "Live view lost its connection.": "实时视图连接已断开。",
    "External provider": "外部 provider",
    "Local only": "仅本机",
    You: "你",
    Others: "其他人",
  });

  const api = Object.freeze({
    applyLiveLocale: i18n.createStaticApplier(STATIC),
    messages: MESSAGES,
    staticText: STATIC,
    translateLiveMessage: i18n.createTranslator(MESSAGES),
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalObject) globalObject.meetingWikiLiveLocalization = api;
})(typeof window === "undefined" ? null : window);
