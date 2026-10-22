# 已知限制

[English](../../guide/limitations.md) | [简体中文](limitations.md)

## 发布状态

- 目前没有签名或公证的发布版。现有构建是未签名的本地测试产物，只供维护者自己的 Mac 使用。
- 不要把它们上传为 GitHub Release，也不要发给其他人。
- 公开发布的阻塞项：Developer ID 证书与公证、与内置运行时一致的 `NOTICE`、Python 包的许可证文本、内置 GPL 和 LGPL 音频工具的源码提供方案，以及嵌套运行时二进制文件签名的验证。

维护者详情（英文）：[known-issues.md](../../known-issues.md) 和 [releasing-macos.md](../../releasing-macos.md)。

## 平台

- 仅支持 Apple Silicon 上的 macOS 14.2 及以上，不支持 Intel Mac。
- 未签名构建在构建机以外的 Mac 上需要移除隔离标记。

## 产品不足

- 删除预览和保留计划只做报告，目前没有删除命令。
- 备份、恢复和删除预览只有命令行版本。
- 自动录音无法检测网页版 Zoom。
- Google Meet 扩展需要在每个浏览器中以 “Load unpacked” 方式加载一次。
- 说话人更正后，旧标签仍保留在只追加的位置（人物时间线、待办表格），以及更正前已发送的外部任务中。
- 实时字幕只用于显示，并且只使用麦克风。没有实时适配器的服务（Other online API key）没有实时字幕。
- 当前构建不提供 Local only 设置。
- 录音前无法检查系统音频权限；缺少权限时表现为其他参会者没有声音，并会弹出通知。
- 命令行工具只在 `/Applications` 或 `~/Applications` 中查找 App。在终端中调用服务的命令需要在环境变量中提供 API Key，因为 App 保存的 Key 在 App 之外无法读取。
- 加密密钥在钥匙串中的条目名称由 Electron 决定，并未在每个构建上核实；请在“钥匙串访问”中搜索 “Safe Storage”。
- API Key 不在备份中，恢复后需要重新输入。
- 首次设置、卸载，以及 Zoom 和 Google Meet 自动录音都是在第二台 Mac 上人工验证的，已安装 App 路径没有自动化端到端测试。
