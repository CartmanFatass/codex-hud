# MCP-READ-COMPACT: show jobs the caller can still act on

Follow-up to `docs/spec.md` §2.1. This is a change to the **model-facing list returned by `hud_read`**, not a new tool, a panel change or part of the seven `mcp-next` tickets.

| Call | Result |
| --- | --- |
| `hud_read({})` or `hud_read({view:"compact"})` | A `jobs` snapshot: running jobs and outstanding attention, newest first. An empty snapshot is `jobs: []`. |
| `hud_read({view:"recent"})` | Today's list: the newest 20 jobs, same visibility, order, field names and values, including `null`, `false`, zeros and timestamps. This is the migration path for callers that want history or a full row. |
| `hud_read({job, …})` | Unchanged single-job read, including `wait_ms`, `full`, report suppression/replay and read-close. `view` is list-only; reject an unknown view or a view combined with a job using the existing argument-error convention. |

**What earns a compact row?** Use the shared job row, not a new lifecycle classifier. Keep a working job (including one waiting for the orchestrator), an unresolved block, a job with an unanswered question or unread report, or a failure not yet observed. For failure attention use the existing `observed_at`/status freshness semantics; no new acknowledgement. A settled job with no outstanding attention disappears. Do not discard a closed job whose report is unread, even a sonic job. Use the list's existing job visibility; the limit of 20 is for *history*, not a reason for 20 newer handled jobs to displace an older pending one.

**What goes in the row?** Keep the full `job` ID, `role` and one `state` (raw state when known, otherwise the shared display state). Add only applicable fields: `report_unread: true`, `blocked: true`, nonempty `question_ids` (e.g. `["q1"]`), and the existing nonempty `reason` for a block, orchestrator wait or failure. No question/report bodies, ordinary working narration, duplicate display state or history fields in the compact row. For example:

```json
{"jobs":[{"job":"j0000000000000001","role":"imp","state":"working"},{"job":"j0000000000000002","role":"sonic","state":"closed","report_unread":true}],"changes":["j0000000000000003 imp: closed | closed after report read"]}
```

`jobs` is a snapshot; `changes` is the existing per-session delta. Neither is derived from the other. A change for a hidden row is still delivered once; a still-unread report stays on the next quiet poll. Leave the response envelope (including watcher metadata when present), worker restrictions, observation stamps, storage, quota handling and worker lifecycle alone. No new cursor, pagination, tokenizer, telemetry or changes to other tools' responses in this slice.
