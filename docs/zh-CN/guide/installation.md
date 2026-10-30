# 安装

[English](../../guide/installation.md) | [简体中文](installation.md)

要求：Apple Silicon Mac（M1 或更新），macOS 14.2 或更新。不支持 Intel Mac。

目前没有签名发布版，所有构建都是未签名的本地测试产物。只在你自己控制的 Mac 上安装，不要再分发。

## 构建 App

先安装一次构建工具：

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install uv node sox
```

在仓库根目录创建构建环境并打包：

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -e '.[dev,gemini]'
printf '%s\n' 'Personal build, not distributed.' > /tmp/meeting-wiki-source-offer.txt
MEETING_WIKI_GPL_SOURCE_OFFER=/tmp/meeting-wiki-source-offer.txt \
  bash scripts/build-macos.sh
```

构建会内置 SoX，其中包含 GPL 和 LGPL 组件，所以没有 `MEETING_WIKI_GPL_SOURCE_OFFER` 时构建会拒绝执行。上面的说明文字只适用于留在你自己 Mac 上的构建。给任何人之前，请先阅读 [portable runtime](../../portable-runtime.md)。

产物位于 `desktop/dist/`：DMG、ZIP、`SHA256SUMS` 和 `mac-arm64/Meeting Wiki.app`。

## 安装

1. 如果把构建复制到了你的另一台 Mac，先校验：

   ```bash
   grep 'Meeting Wiki-.*-arm64\.dmg$' SHA256SUMS | shasum -a 256 -c -
   ```

   必须输出 `OK`。
2. 打开 DMG，把 **Meeting Wiki** 拖到“应用程序”。
3. 如果不是在构建它的那台 Mac 上，需要移除下载隔离标记：

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Meeting Wiki.app"
   ```

4. 打开 Meeting Wiki，继续[设置](setup.md)。

App 自带 Python 运行时、Meeting Wiki 组件、`rec` 和 `sox`。目标 Mac 不需要 Homebrew、Python、Node.js 或源码。

## 命令行工具与 MCP

App 内置了 `meeting-wiki` 命令行和 `meeting-wiki-mcp` 服务，但全新的 Mac 上没有对应的命令。在菜单栏选择 **Install command-line tools...** 并确认即可添加。

- 它会在 `~/.local/bin` 写入两个小脚本 `meeting-wiki` 和 `meeting-wiki-mcp`，只有你本人可以读取和运行。
- 不会替换已有文件。如果同名文件已存在且内容不同，或者是链接，会保持不变并提示。
- 每个脚本每次运行时都会重新查找 `/Applications/Meeting Wiki.app`（或 `~/Applications/Meeting Wiki.app`）里的 Python，所以替换成新构建后仍然可用。找不到 App 时，脚本会输出错误并以状态码 127 退出。

macOS 默认的 `PATH` 不包含 `~/.local/bin`。如果提示找不到 `meeting-wiki`，把下面这一行加入 `~/.zshrc`，然后打开新的终端窗口：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

在 MCP 客户端中，把完整路径 `~/.local/bin/meeting-wiki-mcp`（展开为你的主目录）作为命令。

API Key 只留在 App 中。`memory-search`、`status` 等读取命令和 MCP 服务不需要 Key。在终端中调用服务的命令（例如 `ingest --now` 或 `worker`）需要在环境变量中提供 Key；正常的处理在 App 内完成。

## 卸载

1. 退出 Meeting Wiki，然后删除 App：

   ```bash
   rm -rf "/Applications/Meeting Wiki.app"
   ```

2. 如果安装过命令行工具，删除它们：

   ```bash
   rm -f ~/.local/bin/meeting-wiki ~/.local/bin/meeting-wiki-mcp
   ```

3. 如果开启过 Google Meet 自动录音，先在 Settings 中关闭；或者从 `~/Library/Application Support/` 下每个浏览器的 `NativeMessagingHosts` 文件夹中删除 `dev.meetingwiki.meet.json`。
4. 如果安装过 Claude Skill，删除 `~/.claude/skills/meeting-wiki-memory/`。

数据保留在存储文件夹（默认 `~/.meeting-wiki/`）。该文件夹中还有 `secrets.json`，即加密后的 API Key。只有在你也想删除录音、转写、Wiki 和已保存的 Key 时才删除该文件夹。

用于解密 `secrets.json` 的密钥保留在 macOS 钥匙串中。如需删除，打开“钥匙串访问”，搜索 “Safe Storage”，删除 Meeting Wiki 的条目（通常是 “Meeting Wiki Safe Storage”）。删除该条目后，保留下来的 `secrets.json` 无法再解密，设置向导会重新要求输入 Key。

## 常见问题

| 现象 | 处理 |
|---|---|
| “Meeting Wiki is damaged and can't be opened” | 执行第 3 步的 `xattr` 命令。 |
| “Meeting Wiki installation damaged” | 内置运行时缺失。重新构建，不要绕过检查。 |
| 录音没有系统声音 | 在“屏幕与系统音频录制”下方的“仅系统录音”里允许 Meeting Wiki，然后退出并重新打开 App。本地构建没有固定的签名身份，所以每次安装新构建后，请先把 Meeting Wiki 从这个列表中移除，再重新添加。 |
| 构建报 “AUDIO TOOLS BLOCKED” | 按上文设置 `MEETING_WIKI_GPL_SOURCE_OFFER`。 |
| 构建提示 “Apple Silicon macOS only” | 不支持 Intel Mac。 |

更多细节（英文）：[install-macos.md](../../install-macos.md)。
