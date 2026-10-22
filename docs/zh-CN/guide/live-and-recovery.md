# 实时侧栏与恢复

[English](../../guide/live-and-recovery.md) | [简体中文](live-and-recovery.md)

## 实时侧栏

使用支持实时字幕的服务开始录音时，Meeting Wiki 会在会议旁打开 **Meeting Wiki Live** 窗口。如果所选服务没有实时适配器（例如 Other online API key），不会打开实时窗口，也不会启动实时字幕。窗口显示：

- 状态行和实时问题提示；
- 私密录音的 **Private session** 标记；
- 实时字幕是在本机运行还是由外部服务处理的标记；
- **Summary**：滚动摘要，在最初几句话之后出现；
- **Transcript and translation**：最终转写行，以及翻译成 Settings 中所设语言的译文。

需要了解的行为：

- 实时文本只用于显示，不会改变保存的笔记。停止录音后，会基于完整录音处理并保存会议。
- 实时字幕只使用你的麦克风。通过系统音频传入的其他参会者不会出现在实时文本中，但会出现在保存的会议里。选择在线服务时，麦克风音频会发送给该服务。
- 如果实时字幕无法启动，菜单会显示 “Live captions unavailable. Recording continues.”，录音和处理仍然正常。
- 关闭实时窗口只是隐藏它。实时字幕继续运行，可在菜单栏选择 **Show live captions** 重新显示。录音停止时实时字幕才会停止。
- 使用手动编辑的配置时，只有在实时进程报告正在监听后才会打开窗口。
- 实时相关设置从下一次录音开始生效，已打开的实时窗口保持原设置。
- 私密会话不会加载共享 Wiki 的上下文。

## 处理状态

菜单栏会显示会议是否正在处理或需要处理。

**Run self-check...** 会报告麦克风和系统音频权限、批量转写与分析、实时字幕、存储、记忆索引和 Claude Skill 的状态。每一行都是根据状态码选出的固定文本，不会显示服务报错原文、路径或 Key。

**Open logs** 打开本地日志文件夹。

## 恢复失败的处理

- 有任务失败时，菜单栏会出现 **Retry failed processing**。
- **Open Wiki & Corrections > Processing recovery** 列出失败的任务。每张卡片显示一个标签和录音时间。只有隐私已确定的共享会议才显示会议标题，其他情况显示固定标签，例如 “Private recording” 或 “Recording”。私密标题从不显示。
- 每次打开该视图都会刷新，并显示最后更新时间。如果加载或操作失败，错误会一直显示，并提供 **Retry** 按钮。
- 可以只重试选中的任务，也可以点 **Retry all**。无论在窗口还是菜单栏，Retry all 都会先让你确认任务数量。
- **Dismiss** 只是隐藏失败任务，不会删除录音、转写、Wiki 页面或本地诊断记录。可以在 **Dismissed jobs** 中恢复。

命令行：

```bash
meeting-wiki status --summary
meeting-wiki status --state dead
meeting-wiki retry 12
meeting-wiki self-check
```

默认状态输出不包含会议标题、源文件路径、转写内容或服务报错细节。只在你自己的机器上使用 `status --verbose`。
