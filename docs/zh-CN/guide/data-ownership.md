# 数据归属：备份、恢复、删除预览

[English](../../guide/data-ownership.md) | [简体中文](data-ownership.md)

你的数据是 `~/.meeting-wiki/` 下的本地文件。下面的命令都不会删除会议数据，目前只有命令行版本。

## 加密备份

```bash
meeting-wiki backup-create
meeting-wiki backup-create --output ~/Backups/mw.mwbackup
meeting-wiki backup-verify --archive ~/Backups/mw.mwbackup
```

- 口令通过隐藏输入读取（输入两次），至少 12 个字符，且不会被保存。口令丢失后无法找回。
- 包含：配置元数据、Wiki、私密会议、转写、分析结果、音频、记忆和 URL 资源、任务队列、outbox、事件日志和集成状态。
- 不包含：API Key、`secrets.json`、`.env` 文件、日志和以前的备份。恢复后需要重新输入 API Key。
- `backup-verify` 校验每个文件，不写入任何内容。
- S3 模式下，备份只覆盖本地数据目录。

## 恢复

```bash
meeting-wiki backup-restore --archive ~/Backups/mw.mwbackup --target ~/mw-restored
```

恢复只写入新的或空的目录。它会先校验每个文件和数据库，再把结果移动到位，绝不会覆盖正在使用的数据目录。要使用恢复出的副本，把 `MEETING_WIKI_DATA_DIR` 指向它。

## 删除预览

```bash
meeting-wiki delete-preview --meeting wiki/meetings/<stem>.md
meeting-wiki delete-preview --meeting private/meetings/<stem>.md --allow-private
```

预览会列出与该会议相关的所有内容，以及每项会被如何处理：删除、编辑、重建、保留，或需在外部任务系统中处理。输出包含 `deleted: false`。**目前还没有删除命令。**

## 保留计划

```bash
meeting-wiki retention-plan
```

根据 `config.toml` 中可选的 `[retention]` 阈值，报告将被清理内容的数量和字节数，不删除任何内容。

完整说明（含备份格式，英文）：[data-ownership.md](../../data-ownership.md)。
