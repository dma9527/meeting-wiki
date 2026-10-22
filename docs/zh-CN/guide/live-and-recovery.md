# 实时侧栏与恢复

[English](../../guide/live-and-recovery.md) | [简体中文](live-and-recovery.md)

## 实时侧栏

录音开始时，Meeting Wiki 会在会议旁打开 **Meeting Wiki Live** 窗口，显示：

- 状态行和实时问题提示；
- 私密录音的 **Private session** 标记；
- 实时字幕是在本机运行还是由外部服务处理的标记；
- **Summary**：滚动摘要，在最初几句话之后出现；
- **Transcript and translation**：最终转写行，以及翻译成 Settings 中所设语言的译文。

需要了解的行为：

- 实时文本只用于显示，不会改变保存的笔记。停止录音后，会基于完整录音处理并保存会议。
- 实时字幕使用麦克风音频。选择在线服务时，这部分音频会发送给该服务。
- 如果实时字幕无法启动，菜单会显示 “Live captions unavailable. Recording continues.”，录音和处理仍然正常。
- 关闭实时窗口会停止本次录音的实时字幕，录音本身继续。
- 实时相关设置从下一次录音开始生效，已打开的实时窗口保持原设置。
- 私密会话不会加载共享 Wiki 的上下文。

## 处理状态

菜单栏会显示会议是否正在处理或需要处理。

**Run self-check...** 会报告麦克风和系统音频权限、批量转写与分析、实时字幕、存储、记忆索引和 Claude Skill 的状态。每一行都是根据状态码选出的固定文本，不会显示服务报错原文、路径或 Key。

**Open logs** 打开本地日志文件夹。

## 恢复失败的处理

- 有任务失败时，菜单栏会出现 **Retry failed processing**。
- **Open Wiki & Corrections > Processing recovery** 列出失败的任务。可以只重试选中的任务，也可以点 **Retry all**。
- **Dismiss** 只是隐藏失败任务，不会删除录音、转写、Wiki 页面或本地诊断记录。可以在 **Dismissed jobs** 中恢复。

命令行：

```bash
meeting-wiki status --summary
meeting-wiki status --state dead
meeting-wiki retry 12
meeting-wiki self-check
```

默认状态输出不包含会议标题、源文件路径、转写内容或服务报错细节。只在你自己的机器上使用 `status --verbose`。
