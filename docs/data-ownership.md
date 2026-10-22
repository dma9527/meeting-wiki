# Data Ownership: Backup, Restore, Deletion Preview, Retention

All commands below are local and never delete meeting data automatically.

## Encrypted backup

```bash
meeting-wiki backup-create                       # hidden passphrase prompt, asked twice
meeting-wiki backup-create --output ~/Backups/mw.mwbackup
meeting-wiki backup-verify --archive ~/Backups/mw.mwbackup
meeting-wiki backup-restore --archive ~/Backups/mw.mwbackup --target ~/mw-restored
```

The passphrase is read from a hidden TTY prompt, or from one stdin line with
`--passphrase-stdin` (for app integration). It is never accepted as an
argument or environment variable, never written to disk or logs, and never
stored in the archive. A lost passphrase cannot be recovered. New backups
require at least 12 characters.

### What is included

| Category | Contents |
|---|---|
| `config` | `config.toml` (environment variable names only), `desktop-settings.json` |
| `wiki` | `wiki/**`, `private/meetings/**`, `private/briefs/**` |
| `transcripts` | shared and private transcript text and structured JSON |
| `analysis` | shared and private analysis JSON |
| `audio` | `audio/**`, `private/audio/**` |
| `databases` | consistent SQLite snapshots of `memory.db` (including URL resources), `jobs.db`, `outbox.db`, `events.db` |
| `integration_state` | `integrations/**`, except transient browser spool events |

Never included: `secrets.json`, `.env*`, key and certificate files, logs, `tmp/`
live chunks, the runtime and virtual environment, earlier backups, and any
unrecognized file. A `config.toml` whose webhook URL carries credentials, a
query string, or a fragment is skipped and reported as
`config_contains_credential`. API keys must be re-entered after a restore.

In S3 mode, shared artifacts live in the bucket. The backup covers the local
data directory only and reports `remote_shared_storage: true`.

### Format

`MWBKUP01` magic, a plaintext header with only KDF and cipher parameters,
then AES-256-GCM frames of 1 MiB. The key comes from scrypt (N=2^17, r=8,
p=1, random 16-byte salt). Each frame authenticates the header digest, its
index, and a final-frame flag, so tampering, reordering, and truncation fail.
The encrypted payload is a tar stream whose last member, `manifest.json`,
records the SHA-256 and size of every member.

### Verification and restore

`backup-verify` decrypts and hashes every member in memory and compares the
result with the manifest. It writes nothing.

`backup-restore` only writes into a new or empty directory. It extracts into
a private staging directory beside the target, verifies every hash, runs
`PRAGMA integrity_check` on each restored database, and only then renames the
staging directory into place. Any failure removes the staging directory and
leaves the target absent or untouched. The live data directory is never
overwritten. To use a restored copy, point `MEETING_WIKI_DATA_DIR` at it and
check that `data_dir` in the restored `config.toml` matches.

## Meeting deletion preview

```bash
meeting-wiki delete-preview --meeting wiki/meetings/<stem>.md
meeting-wiki delete-preview --meeting private/meetings/<stem>.md --allow-private
```

The preview opens databases read-only and lists, with an `effect` per item:

- `delete`: meeting page, transcript text and JSON, analysis, decision pages
  recorded by the meeting, managed audio, job rows, memory nodes and URL
  resources owned by the meeting, and local outbox rows.
- `edit`: person and topic timeline entries, action item rows, briefs, and
  decisions superseded by this meeting.
- `rebuild`: meeting and decision indexes.
- `retain`: imported source files outside the data directory, shared person
  and topic memory nodes, event journal rows (codes only), and existing backups.
- `retain_external`: delivered task links. Only the scheme and host are shown,
  with a short digest reference, never the URL path or action text. Remove
  them in the task system.

Private meetings require `--allow-private`, and a shared preview never lists
private artifacts. The output has `deleted: false` and a `plan_digest` over
the enumerated plan. There is no delete command yet; execution will be a
separate command that requires the matching `plan_digest`.

## Retention planning

```toml
[retention]
audio_days = 90
dismissed_jobs_days = 30
live_tmp_hours = 24
backups_keep = 5
```

```bash
meeting-wiki retention-plan
```

The plan reports counts and bytes only, and deletes nothing. Audio is
eligible only when it is traceable to finished work: shared audio referenced
solely by completed jobs, or private audio whose private transcript exists.
Audio referenced by pending, failed, or dead jobs is reported as protected,
and untraceable audio is retained. Dismissed queue rows can be removed with
the existing explicit `cleanup-dismissed` command.
