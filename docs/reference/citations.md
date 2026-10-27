# Memory citations

Every memory search result and every relation on it carries a `citation`. The
CLI (`memory-search`), the MCP tool `meeting_wiki_memory_search`, the Wiki
window, and the Claude skill all read this one shape. The legacy `source`
field stays for older consumers.

## Shape

```json
{
  "version": 1,
  "meeting_id": "meeting:9f9f5111f7b27a78",
  "meeting_title": "Rollout sync",
  "occurred_at": "2026-09-01T15:00:00+00:00",
  "privacy": "shared",
  "source_path": "wiki/meetings/2026-09-01-rollout-sync.md",
  "anchor": null
}
```

| Field | Meaning |
|---|---|
| `version` | Contract version, currently `1`. |
| `meeting_id` | Node id of the meeting, the same id `memory-search --type=meeting` returns and `memory-add-resource --meeting` accepts. |
| `meeting_title` | Title to show when quoting. |
| `occurred_at` | When the meeting happened. |
| `privacy` | `shared` or `private`. |
| `source_path` | The meeting page key. `meeting_wiki_read_page` accepts it for shared meetings. |
| `anchor` | `null`, except for transcript lines (below). |

## Transcript anchor

A `transcript_segment` result has
`{"kind": "transcript_segment", "start_seconds": 12.5, "end_seconds": 20.0, "index": 3}`.
`start_seconds` and `end_seconds` are `null` for an untimed line. `index` is
missing on rows indexed before it existed; run `meeting-wiki reindex-memory` to
add it.

## Rules

- A shared person or topic spans many meetings, so its own `citation` is
  `null`. Each of its relations carries the citation of the meeting that
  produced it.
- Private results are returned only when the caller asks for private memory.
  Never quote a private citation in shared output.
- `meeting_wiki_read_page` refuses any path with a `private` segment.
- The desktop client drops `meeting_id` and `anchor.index`, drops an anchor
  with untimed seconds, bounds anchor seconds to one day and only passes on a
  `source_path` under `wiki/meetings/` without `..`.

## Evidence

- `meeting_wiki/memory.py` (`build_citation`).
- `tests/test_memory.py`, `tests/test_citation_doc.py`.
- `desktop/memory-client.js` and `desktop/test/memory-client.test.js`.
