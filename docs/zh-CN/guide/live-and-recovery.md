# 实时侧栏与恢复

[English](../../guide/live-and-recovery.md) | [简体中文](live-and-recovery.md)

## 实时侧栏

为某次录音启用实时字幕后，如果 provider 支持 live 功能，Meeting Wiki 会在会议旁打开 **Meeting Wiki Live** 窗口。这个选择可以来自已保存的默认值，也可以来自 **Start with options...** 的本次覆盖。保存录音默认值之前，自动录音的 live 功能保持关闭。自动录音会在 10 秒短会议丢弃窗口结束后启动 live。如果所选服务没有实时适配器（例如 Other online API key），不会打开实时窗口，也不会启动实时字幕。provider、audio、启动或连接出现问题时，固定通知会说明原因，录音和 batch processing 继续运行。Key 缺失会暂停 provider processing，runtime 缺失时录音无法进入队列，直到 App 被修复。窗口显示：

- 状态行和实时问题提示；
- 私密录音的 **Private session** 标记；
- 实时字幕是在本机运行还是由外部服务处理的标记；
- **Summary**：使用 Settings 中选择的 live summary 语言生成滚动总结；
- **Transcript and translation**：最终转写行，以及使用 Settings 中选择的 live translation 语言生成的译文。

需要了解的行为：

- 实时文本只用于显示，不会改变保存的笔记。停止录音后，会基于完整录音处理并保存会议。
- 实时字幕同时转写两路音频：你的麦克风标记为 **现场**（它会录到你身边的所有人），这台 Mac 播放的全部音频（包括线上参会者）标记为 **线上**。滚动总结覆盖两路内容。选择在线服务时，两路音频和转写文本都会发送给该服务，包括 Private 录音。每路音频各用一个 provider 连接，因此 live 用量约为单路的两倍。
- 如果系统音频不可用，live 会继续转写你的麦克风。系统音频连续 30 秒完全无声时，live 窗口会提示检查 System Audio Recording 权限。会议安静时也可能出现这个提示。
- Live provider 连接中断时会自动重试几次，之后才停止。Live 失败的原因会写入 Meeting Wiki 日志目录中的 `live.log`，其中不包含任何会议内容。
- **Run self-check...** 会用静音音频打开一次很短的 live 会话。如果 provider 拒绝连接，对话框会显示错误代码，例如 WebSocket close code 和 provider status。
- 如果 live 功能无法启动，菜单会显示 “Live captions, translation, and summary unavailable. Recording continues.”。Provider、audio、启动和连接失败不会停止录音或 batch processing。Key 缺失会暂停 provider processing，runtime 缺失时录音无法进入队列，直到 App 被修复。
- 关闭实时窗口只是隐藏它。实时字幕继续运行，可在菜单栏选择 **Show live captions** 重新显示。录音停止时实时字幕才会停止。
- 使用手动编辑的配置时，只有在实时进程报告正在监听后才会打开窗口。
- 实时相关设置从下一次录音开始生效，已打开的实时窗口保持原设置。
- 私密会话不会加载共享 Wiki 的上下文。

## 处理状态

菜单栏图标始终不变。录音时，图标旁边会显示已录时长。处理状态显示在菜单里。

**Run self-check...** 会报告麦克风和系统音频权限、批量转写与分析、实时字幕、存储、记忆索引和 Claude Skill 的状态。每一行都是根据状态码选出的固定文本，不会显示服务报错原文、路径或 Key。macOS 无法读取“仅系统录音”权限，所以只有授予了完整的“录屏与系统录音”权限时，系统音频才显示为已允许；否则显示一条提示，而不是错误。

**Open logs** 打开本地日志文件夹。

## 恢复失败的处理

- 有任务失败时，菜单栏会出现 **Retry failed processing**。
- **Open Wiki & Corrections > Processing recovery** 列出失败的任务。每张卡片显示一个标签和录音时间。只有隐私已确定的共享会议才显示会议标题，其他情况显示固定标签，例如 “Private recording” 或 “Recording”。私密标题从不显示。
- 每次打开该视图都会刷新，并显示最后更新时间。如果加载或操作失败，错误会一直显示，并提供 **Retry** 按钮。
- 可以只重试选中的任务，也可以点 **Retry all**。无论在窗口还是菜单栏，Retry all 都会先让你确认任务数量。
- **Dismiss** 只是隐藏失败任务，不会删除录音、转写、Wiki 页面或本地诊断记录。可以在 **Dismissed jobs** 中恢复。
- 每张卡片会说明任务停止的原因和下一步。原因来自固定的错误代码，不读取 provider 返回的原文，Gemini 和 OpenAI 兼容 provider 用同一套规则：

  | 原因 | 是否自动重试 | 你需要做什么 |
  |---|---|---|
  | 余额或配额用完（HTTP 402，或 `insufficient_quota`） | 是，每 30 分钟一次，不消耗重试次数 | 充值或开启付费。Wiki 窗口顶部的横幅会显示下次重试时间；点 **立即重试** 可以马上重试 |
  | API key 不被接受（HTTP 401 或 403） | 否 | 用可用的 key 重新运行设置向导，然后重试 |
  | 限流（HTTP 429，或不是 402 的 `RESOURCE_EXHAUSTED`） | 是，依次等 1、4、16、60 分钟 | 等待 |
  | 请求被拒绝（其他 4xx） | 一次 | 重试；再失败就导出诊断 |
  | 服务器问题（5xx）或连不上 | 是 | 等待或检查网络 |

  实时字幕遇到余额不足或 key 不被接受时，会直接停止，不再重连，录音照常进行。遇到原因不明的关闭码 1011 时，会先发一个极小的请求确认是否余额不足，再决定是否重连。

命令行：

```bash
meeting-wiki status --summary
meeting-wiki status --state dead
meeting-wiki retry 12
meeting-wiki self-check
```

默认状态输出不包含会议标题、源文件路径、转写内容或服务报错细节。只在你自己的机器上使用 `status --verbose`。

## 用量与 live 预算

Meeting Wiki 在这台 Mac 上统计 provider 用量：按天、模型和操作记录 token 数、实时音频秒数和调用次数。只保存数字，位置是 `~/.meeting-wiki/usage.db`，不会保存文字、音频或 key。

- **设置 > Gemini 功能 > 本月用量** 显示本月（按 UTC 计算）到目前为止的估算费用，按官方标价计算。没有已知标价的模型只计数不计价，并会提示估算偏低。实际金额以 provider 账单为准。
- **每月 live 预算**（整数美元，`0` 表示不限制）是软限制。本月估算达到预算后，新的录音不再启动实时字幕、翻译和总结，实时侧栏会说明原因。已经在运行的 live view 不会被中断。录音和 batch processing 始终照常进行。
- `meeting-wiki usage [--month YYYY-MM]` 以 JSON 输出同样的数字。
