# Memory, URL Resources, and Claude Skill

[English](memory.md) | [简体中文](../zh-CN/guide/memory.md)

## Wiki window

**Open Wiki & Corrections** in the menu bar opens a local window with recent
meetings, full-text search, page reads, open action items, memory search, the
correction inbox, and processing recovery.

The window loads no remote content and can read only `wiki/`. `private/` is
unreachable from it. The one exception is memory search, and only when you
tick "Include private memory on this Mac".

## Canonical memory

Each processed meeting is indexed into `memory.db`: people, topics, decisions,
action items, and transcript lines, each linked to its source meeting.

Choose **Memory and wiki content** under **Settings... > Languages** for new
processing. The default, **Same as the meeting**, keeps generated text in the
language the speakers used and never translates it, so translation cannot
introduce errors. English or 简体中文 translates instead. This changes generated summaries, decision details, action text,
topic insights, questions, and risks. Meeting titles, topic names, decision
titles, people, due values, identifiers, dates, URLs, and stable Markdown
headings keep their source form. Changing the setting does not rewrite existing
meetings or completed analysis snapshots. An explicit correction reprocess uses
the current memory language.

In the window, **Memory search** has type filters and an "Include private
memory on this Mac" checkbox that starts unchecked.

From the CLI:

```bash
meeting-wiki memory-search --query "canary rollout" --type decision --type topic
meeting-wiki memory-search --query "canary rollout" --include-private
meeting-wiki reindex-memory   # rebuild after an upgrade or restore; prints counts only
```

## URL resources

Attach a link to a meeting with your own title and summary. Meeting Wiki stores
it locally in `memory.db` and never opens, fetches, or sends the URL.

```bash
meeting-wiki memory-add-resource --meeting=meeting:<id> --url=https://docs.example.com/spec \
  --title="Rollout spec" --summary="Canary plan" --relation=design_doc
meeting-wiki memory-resources
```

- Take the meeting id from a `memory-search --type=meeting` result.
- URLs must be https to a public host, with no user name or password, no
  secret-looking query parameters (such as `token`), and no `#fragment`.
- Private, link-local, and single-label hosts are rejected.
  `--allow-loopback` permits localhost URLs for local tools.
- A resource inherits its meeting's privacy. Attaching to a private meeting
  needs `--allow-private`.
- In the window, each shared meeting result has an **Add resource** form for
  https links.

## MCP server

`meeting-wiki-mcp` is a local, read-only MCP server over shared content:
`meeting_wiki_search`, `meeting_wiki_memory_search`, `meeting_wiki_read_page`,
`meeting_wiki_list_recent`, and `meeting_wiki_action_items`. It never returns
private meetings or private memory.

On an installed app, choose **Install command-line tools...** in the menu bar,
then point your MCP client at `~/.local/bin/meeting-wiki-mcp`. See
[installation](installation.md#command-line-tools-and-mcp).

## Claude skill

**Install Claude skill for meeting memory...** in the menu bar copies a bundled
template with no meeting data to
`~/.claude/skills/meeting-wiki-memory/SKILL.md`. It teaches agents to query
memory through MCP or the CLI, keep private memory opt-in, and never write
memory files directly.

The installer refuses to overwrite a file with different content and reports
installed, already installed, conflict, unsafe path, or error.

## Speaker corrections

The correction inbox lists shared meetings that still use an unclear speaker
label such as `Remote participant` or `spk_1`. Rename the speaker, review the
plan, then reprocess.

The meeting page is rewritten, but the old label stays on append-only surfaces
such as people timelines and the action-item table. The plan lists those
entries before you confirm.

Reprocessing does not propose external tasks again. Tasks already sent keep the
old label in the task system; the plan reports how many and on which host. If
the same correction was already applied, or its job is dead or dismissed,
nothing is queued and the command says so. Retry a dead job from processing
recovery.

```bash
meeting-wiki correct-inbox
meeting-wiki correct --meeting wiki/meetings/<page>.md --speaker "Remote participant=Sam Rivera"
meeting-wiki correct --meeting wiki/meetings/<page>.md --speaker "Remote participant=Sam Rivera" --reprocess
```
