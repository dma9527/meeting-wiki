# Meeting Wiki 中文文档

[English](../README.md) | [简体中文](README.md)

Meeting Wiki 是一个本地优先的 macOS 会议记忆工具。它录下会议，把内容整理成一个持续更新的纯 Markdown 知识库，包括人物、话题、决策和待办事项，而不是一堆互不相关的单次摘要。文件不依赖 App 也能阅读，可直接用 Obsidian、VS Code、Git 等工具打开。

## 当前状态

**早期 alpha 版本（0.1.x），仅支持 Apple Silicon 上的 macOS 14.2 及以上。**

目前没有签名发布版。所有构建都是未签名的**本地测试产物**，只供维护者自己的 Mac 使用。不要把它们作为 GitHub Release 发布，也不要发给其他人。公开发布需要 Developer ID 签名、公证，以及确定内置音频工具的许可证方案。详见[已知限制](guide/limitations.md)。

## 快速开始

1. 在 Apple Silicon Mac 上从源码**构建 App**。见[安装](guide/installation.md)。
2. **打开 Meeting Wiki** 完成设置：选择 Gemini、其他 OpenAI 兼容服务或纯本地模式，并授予麦克风和“屏幕与系统音频录制”权限。见[设置与 API Key](guide/setup.md)。
3. **开始录音**：在菜单栏选择 **Start recording...**（Cmd+Shift+0），选择 Shared wiki 或 Private，会议结束后停止。处理完成后，会议出现在 `~/.meeting-wiki/wiki/` 下。见[录音](guide/recording.md)。

## 用户指南

1. [安装](guide/installation.md)：构建、安装、卸载。
2. [设置与 API Key](guide/setup.md)：服务选择、密钥存储、权限、切换服务。
3. [录音](guide/recording.md)：手动录音、私密会议、导入音频、Zoom 与 Google Meet 自动录音。
4. [实时侧栏与恢复](guide/live-and-recovery.md)：实时字幕、自检、重试失败任务。
5. [记忆、URL 资源与 Claude Skill](guide/memory.md)：Wiki 窗口、记忆搜索、附加链接、MCP、说话人更正。
6. [数据归属](guide/data-ownership.md)：加密备份、恢复、删除预览、保留计划。
7. [已知限制](guide/limitations.md)：发布状态与当前不足。

## 参考资料（英文）

- [CLI 与配置](../reference/cli-and-config.md)
- [数据归属详细说明](../data-ownership.md)
- [集成信号说明](../integrations.md)
- [架构](../architecture.md)
- [隐私说明](../../PRIVACY.md)
- [已知问题与发布阻塞项](../known-issues.md)
