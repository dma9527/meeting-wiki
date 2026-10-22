# 记忆、URL 资源与 Claude Skill

[English](../../guide/memory.md) | [简体中文](memory.md)

## Wiki 窗口

菜单栏的 **Open Wiki & Corrections** 打开一个本地窗口，包含最近会议、全文搜索、页面阅读、未完成待办、记忆搜索、更正收件箱和处理恢复。

窗口不加载任何远程内容，只能读取 `wiki/`，无法访问 `private/`。唯一的例外是记忆搜索，并且只在你勾选 “Include private memory on this Mac” 之后。

## 规范记忆（Canonical memory）

每个处理完的会议都会被索引到 `memory.db`：人物、话题、决策、待办和转写行，每条都链接回来源会议。

在窗口中，**Memory search** 提供类型筛选，以及默认不勾选的 “Include private memory on this Mac” 选项。

命令行：

```bash
meeting-wiki memory-search --query "canary rollout" --type decision --type topic
meeting-wiki memory-search --query "canary rollout" --include-private
meeting-wiki reindex-memory   # 升级或恢复后重建索引，只输出数量
```

## URL 资源

可以给会议附加一个链接，并写上你自己的标题和摘要。Meeting Wiki 只把它保存在本地 `memory.db` 中，从不打开、抓取或发送这个 URL。

```bash
meeting-wiki memory-add-resource --meeting=meeting:<id> --url=https://docs.example.com/spec \
  --title="Rollout spec" --summary="Canary plan" --relation=design_doc
meeting-wiki memory-resources
```

- 会议 id 来自 `memory-search --type=meeting` 的结果。
- URL 必须是指向公网主机的 https，不能带用户名或密码，不能带疑似密钥的查询参数（例如 `token`），不能带 `#fragment`。
- 私有、链路本地和单段主机名会被拒绝。`--allow-loopback` 允许本地工具使用 localhost 地址。
- 资源继承所属会议的隐私属性。附加到私密会议需要 `--allow-private`。
- 在窗口中，每个共享会议结果都有 **Add resource** 表单，只接受 https 链接。

## MCP 服务

`meeting-wiki-mcp` 是只读的本地 MCP 服务，只覆盖共享内容：`meeting_wiki_search`、`meeting_wiki_memory_search`、`meeting_wiki_read_page`、`meeting_wiki_list_recent` 和 `meeting_wiki_action_items`。它从不返回私密会议或私密记忆。

使用已安装的 App 时，在菜单栏选择 **Install command-line tools...**，然后在 MCP 客户端中使用 `~/.local/bin/meeting-wiki-mcp`。参见[安装](installation.md#命令行工具与-mcp)。

## Claude Skill

菜单栏的 **Install Claude skill for meeting memory...** 会把一个不含任何会议数据的内置模板复制到 `~/.claude/skills/meeting-wiki-memory/SKILL.md`。它教 Agent 通过 MCP 或 CLI 查询记忆、私密记忆需要显式开启、不要直接写入记忆文件。

安装器不会覆盖内容不同的已有文件，结果会显示为 installed、already installed、conflict、unsafe path 或 error。

## 说话人更正

更正收件箱列出仍使用模糊说话人标签（例如 `Remote participant` 或 `spk_1`）的共享会议。重命名说话人，查看计划，然后重新处理。

会议页面会被重写，但旧标签会保留在只追加的位置，例如人物时间线和待办表格。确认前，计划会列出这些条目。

重新处理不会再次创建外部任务。已发送的任务在任务系统中保留旧标签；计划会报告数量和所在主机。如果同一更正已经应用过，或其任务已失败停止或被忽略，则不会排队，命令会说明原因。可在处理恢复中重试失败停止的任务。

```bash
meeting-wiki correct-inbox
meeting-wiki correct --meeting wiki/meetings/<page>.md --speaker "Remote participant=Sam Rivera"
meeting-wiki correct --meeting wiki/meetings/<page>.md --speaker "Remote participant=Sam Rivera" --reprocess
```
