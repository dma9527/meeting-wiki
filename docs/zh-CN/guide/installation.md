# 安装

[English](../../guide/installation.md) | [简体中文](installation.md)

要求：Apple Silicon Mac（M1 或更新），macOS 14 或更新。不支持 Intel Mac。

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

## 卸载

```bash
rm -rf "/Applications/Meeting Wiki.app"
```

数据保留在 `~/.meeting-wiki/`。只有在你也想删除录音、转写和 Wiki 时才删除该文件夹。API Key 保留在“钥匙串访问”中，名称为 “Meeting Wiki”。

## 常见问题

| 现象 | 处理 |
|---|---|
| “Meeting Wiki is damaged and can't be opened” | 执行第 3 步的 `xattr` 命令。 |
| “Meeting Wiki installation damaged” | 内置运行时缺失。重新构建，不要绕过检查。 |
| 录音没有系统声音 | 授予“屏幕与系统音频录制”权限，然后退出并重新打开 App。 |
| 构建报 “AUDIO TOOLS BLOCKED” | 按上文设置 `MEETING_WIKI_GPL_SOURCE_OFFER`。 |
| 构建提示 “Apple Silicon macOS only” | 不支持 Intel Mac。 |

更多细节（英文）：[install-macos.md](../../install-macos.md)。
