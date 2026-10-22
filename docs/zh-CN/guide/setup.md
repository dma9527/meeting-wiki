# 设置与 API Key

[English](../../guide/setup.md) | [简体中文](setup.md)

首次启动 Meeting Wiki 会打开设置向导。之后可以在菜单栏选择 **Run setup...** 重新运行。

## 选择处理方式

| 方式 | 使用什么 | 会议数据去向 |
|---|---|---|
| **Gemini, recommended** | 你的 Google Gemini API Key，用于转写、实时字幕、翻译和摘要 | 音频和转写文本发送给 Google |
| **Other online API key** | OpenAI 兼容的 endpoint、转写模型、摘要与翻译模型 | 音频和转写文本发送给你填写的 endpoint |
| **Local only** | 下载到本机的模型 | 留在本机；模型装好后可离线使用，需要磁盘空间 |

选择在线方式时，必须先确认数据外发说明，才会运行服务检查。向导会展示一份数据边界摘要，说明哪些数据会离开本机。

## API Key 的处理

- Key 通过 macOS 钥匙串机制加密保存。
- 不会写入 `config.toml`，也不会写入应用日志。
- **Show key** 显示 Key，20 秒后自动隐藏。**Paste** 只把剪贴板内容粘贴到遮罩输入框中，粘贴内容不会被记录。

## 权限

系统询问时授予 **麦克风** 和 **屏幕与系统音频录制** 权限（系统设置，隐私与安全性）。授予系统音频权限后，退出并重新打开 Meeting Wiki。然后运行连接测试，并做一次简短的测试录音。

## 切换服务

重新运行设置是事务性的：

- 新服务先用临时配置检查。
- 只有检查通过并点击 **Finish setup** 后，当前 Key、配置和设置状态才会改变。
- 检查失败或关闭窗口时，当前服务继续可用。
- Key 输入框留空，会检查并继续使用该类型服务已保存的 Key。
- **Test current setup** 只检查当前服务，不做任何修改。

## Settings

菜单栏的 **Settings...** 包含不需要更换 Key 的选项：

- Gemini 模型，包括实时转写模型。
- 实时翻译语言（例如 `zh` 这样的代码，或 Japanese 这样的名称）和摘要上下文长度。
- 最长录音时长。
- Zoom 与 Google Meet 自动录音。

Settings 不会改动你手动编辑过的 `config.toml`。更换 API Key 或切换服务，请使用 **Run setup again**。

## 数据位置

会议、Wiki、任务队列、日志和私密会议默认保存在 `~/.meeting-wiki/`。删除 App 不会删除这个文件夹。
