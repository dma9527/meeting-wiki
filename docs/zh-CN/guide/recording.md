# 录音

[English](../../guide/recording.md) | [简体中文](recording.md)

Meeting Wiki 录制你的麦克风和 macOS 系统声音。你有责任告知参会者，并取得法律、公司政策或会议平台要求的同意。请阅读 [PRIVACY.md](../../../PRIVACY.md)（英文）。

## 手动录音

1. 在菜单栏选择 **Start recording...**，或按 Cmd+Shift+0。
2. 弹出确认面板。选择 **Shared wiki** 或 **Private**，可选填写标题。面板还会显示录音权限、音频在哪里处理、时长上限和实时字幕是否就绪。确认之前不会录音。

   以下情况 **Start recording** 会被禁用，并提供修复按钮：
   - 设置尚未完成（**Open setup**）；
   - 麦克风权限被拒绝或受限（**Open Microphone settings**）。

   macOS 不允许 Meeting Wiki 提前检查系统音频权限，所以面板不会显示它已就绪。如果之前其他参会者没有声音，点击 **Open System Audio settings** 会打开对应的设置页面。
3. 录音过程中，菜单显示已录时长和上限。
4. 用以下任一方式结束：
   - **Stop and process**（Cmd+Shift+0）：保存音频并加入转写和分析队列。
   - **Stop and discard**：停止并删除本次录音。

### 时长上限

到达最长时长时会自动停止，然后像手动停止一样保存并处理。默认 120 分钟，可在 **Settings... > Recording length** 中修改（15 到 480 分钟）。

### 导入已有音频

**Import audio...** 把已有音频文件加入队列。每次导入都会询问 Shared 还是 Private。

## 私密会议

私密会议：

- 只写入 `private/`；
- 不更新共享的人物、话题、决策、待办、索引或日志；
- 不会同步到 S3；
- 不会被 MCP 返回；
- 不会触发任务集成。

## 自动录音（Zoom 与 Google Meet）

在 **Settings... > Automatic recording** 中开启。两个集成默认都是关闭的。

- 加入会议时开始录音，离开时停止、保存并处理。
- 没有倒计时。托盘图标会切换为录音图标，并弹出 “Recording started” 通知。
- 10 秒内结束的会议会被丢弃，不做处理。
- 自动录音使用与录音面板相同的设置检查，设置未完成时不会开始。

**自动录音的去向**：在 Settings 中选择一项：

| 选项 | 结果 |
|---|---|
| **Private**（新安装默认） | 始终为私密。 |
| **Follow my calendar** | 只有当日历事件与录音开始时间匹配，且日历未标记为私密时才共享。没有日历或没有匹配事件时为私密。该决定在写入 Wiki 之前做出一次，重试时保持不变。 |
| **Shared wiki** | 共享，除非日历或标题把会议标记为私密。这是之前版本的行为。 |

如果在这个设置出现之前你已经开启了自动录音，Meeting Wiki 会保持之前的行为（共享），并在 Settings 中显示提示，直到你选择一项并保存。不会替你更改之前的选择。

**Zoom App**：每 3 秒在本机检查一次 Zoom App 是否在运行、是否打开了会议音频连接、是否阻止显示器休眠（`ps`、`lsof`、`pmset`）。不读取 Zoom 窗口、聊天、参会者或标题，也不使用辅助功能权限。网页版 Zoom 无法检测。

**Google Meet**（Chrome、Edge、Brave 或 Chromium）需要内置扩展：

1. 在 Settings 中点击 **Show extension folder**。
2. 在浏览器扩展页面打开开发者模式，选择 **Load unpacked**，选中该文件夹。每个浏览器只需操作一次。

扩展只检查 meet.google.com 标签页是否显示 “Leave call” 按钮，并报告加入或离开以及会议代码。它无法读取字幕、转写、聊天、参会者或浏览记录。事件通过 native messaging host 和本机私有文件夹传给 Meeting Wiki，不使用网络端口。

完整信号说明（英文）：[integrations.md](../../integrations.md)。
