---
name: meeting-wiki-memory
description: Query a local Meeting Wiki memory (meetings, people, topics, decisions, action items, transcript lines, and user-attached URL resources) through its read-only MCP tools or the meeting-wiki CLI. Use when the user asks what was decided, who owns an action item, what was said about a topic, or which links were attached to a meeting. Never edits memory files directly.
---

# Meeting Wiki memory

Meeting Wiki keeps a local, owner-only memory of processed meetings. This skill
explains how to read that memory safely. It contains no meeting data; everything
you learn comes from the user's own machine at query time.

## Golden rules

1. Read through the supported interfaces only: the MCP tools or the
   `meeting-wiki` CLI. Never open, edit, copy, or delete files under the data
   directory yourself (for example `memory.db`, `wiki/`, `private/`, `audio/`,
   `transcripts/`, `config.toml`, `secrets.json`). Direct writes can corrupt the
   index or leak private meetings.
2. Shared memory is the default. Private memory (one-on-ones and meetings the
   user marked private) is returned only when the user explicitly asks for it in
   the current conversation. Do not add `--include-private` on your own
   initiative, and do not carry private results into shared documents, tickets,
   chat messages, or commits.
3. Do not fetch, open, or summarize resource URLs unless the user asks you to.
   Resources store a URL plus the user's own title and summary; Meeting Wiki
   never fetches them.
4. Quote sources. Each result names the meeting it came from; cite that title
   and date instead of presenting facts as your own.

## Option A: MCP (preferred, shared memory only)

If the `meeting_wiki_mcp` server is connected (command `meeting-wiki-mcp`), use:

- `meeting_wiki_memory_search` with `query` (2 to 300 characters), optional
  `node_type` (`meeting`, `person`, `topic`, `decision`, `action_item`,
  `transcript_segment`, `resource`), and `limit` (1 to 30). Shared memory only.
- `meeting_wiki_search` for full-text search over shared wiki pages.
- `meeting_wiki_read_page` to read one shared page by path from a search result.
- `meeting_wiki_list_recent` and `meeting_wiki_action_items` for overviews.

All MCP tools are read-only. They cannot return private memory.

## Option B: CLI

Run the commands as separate arguments (no shell string building, no pipes into
other tools that write files). Pass user text as a single `--flag=value`
argument so it can never be read as another option.

Search shared memory:

```bash
meeting-wiki memory-search --query="canary rollout" --type=decision --type=topic --limit=12
```

Search including private memory, only after the user explicitly asks:

```bash
meeting-wiki memory-search --query="career plan" --include-private
```

List URL resources attached to meetings (shared only by default):

```bash
meeting-wiki memory-resources --limit=50
meeting-wiki memory-resources --meeting=meeting:0123456789abcdef
```

Attach a resource only when the user asks you to and supplies the URL, title,
and optional summary. The target must be a meeting node id from a search
result. URLs must be https, without credentials, secret query tokens, or a
`#fragment`, and must point at a public host:

```bash
meeting-wiki memory-add-resource --meeting=meeting:0123456789abcdef \
  --url=https://docs.example.com/rollout --title="Rollout spec" \
  --summary="Canary plan" --relation=design_doc
```

Relations: `reference`, `design_doc`, `ticket`, `code_review`, `notes`,
`follow_up`. Do not pass `--allow-private` or `--allow-loopback` unless the user
explicitly requests it for that specific resource.

Output is JSON. On failure the CLI prints a short error code such as
`invalid_memory_query`, `https_required`, or `meeting_unavailable`; report the
code to the user rather than retrying with weaker settings.

## Reindexing

If results look stale or empty after an upgrade or restore, suggest:

```bash
meeting-wiki reindex-memory
```

It rebuilds `memory.db` from local meeting artifacts in one transaction, keeps
user-attached resources, and prints counts only. Ask before running it. It
requires local storage and refuses otherwise; do not work around that refusal.
Never delete `memory.db` to force a rebuild.

## What not to do

- Do not read or write memory files directly, including with SQLite tools.
- Do not run `ingest`, `correct --reprocess`, `retry`, `dismiss`, or
  `cleanup-dismissed` unless the user asks for that exact action.
- Do not include private results, transcript lines, or attendee names in output
  that leaves the user's machine without the user's explicit approval.
