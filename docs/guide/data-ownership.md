# Data Ownership: Backup, Restore, Deletion Preview

[English](data-ownership.md) | [简体中文](../zh-CN/guide/data-ownership.md)

Your data is local files under `~/.meeting-wiki/`. None of the commands below
delete meeting data. They are CLI only for now.

## Encrypted backup

```bash
meeting-wiki backup-create
meeting-wiki backup-create --output ~/Backups/mw.mwbackup
meeting-wiki backup-verify --archive ~/Backups/mw.mwbackup
```

- The passphrase is read from a hidden prompt (asked twice), needs at least 12
  characters, and is never stored. A lost passphrase cannot be recovered.
- Included: config metadata, wiki, private meetings, transcripts, analysis,
  audio, memory and URL resources, jobs, outbox, events, and integration state.
- Never included: API keys, `secrets.json`, `.env` files, logs, and earlier
  backups. Re-enter API keys after a restore.
- `backup-verify` checks every file and writes nothing.
- In S3 mode the backup covers the local data directory only.

## Restore

```bash
meeting-wiki backup-restore --archive ~/Backups/mw.mwbackup --target ~/mw-restored
```

Restore writes only into a new or empty directory. It verifies every file and
database before moving the result into place, and never overwrites your live
data directory. To use the restored copy, point `MEETING_WIKI_DATA_DIR` at it.

## Deletion preview

```bash
meeting-wiki delete-preview --meeting wiki/meetings/<stem>.md
meeting-wiki delete-preview --meeting private/meetings/<stem>.md --allow-private
```

The preview lists every artifact tied to the meeting and what would happen to
it: delete, edit, rebuild, retain, or retain in an external task system. It
prints `deleted: false`. **There is no delete command yet.**

## Retention plan

```bash
meeting-wiki retention-plan
```

Reports counts and bytes for what the optional `[retention]` thresholds in
`config.toml` would remove. It deletes nothing.

Full detail, including the backup format: [data-ownership.md](../data-ownership.md).
