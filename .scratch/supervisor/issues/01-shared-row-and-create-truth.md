# 01: one job-row reader; `hud_create` tells the truth

**What:** extract the per-job state rule from `readThinJobs` into exported `jobRow(job, status)` (raw state, display
state, reason, blocked, open questions, report present) in `src/collectors/thin-jobs.ts`; the MCP's own `jobStatus`
is deleted and uses it. `hud_create` returns the row of the job it made; a dispatch failure returns
`ok: false, code: 'dispatch_failed', reason` (same request_key → same answer).

**Who:** imp (agy) · **Size:** ~100 lines · **Blocked by:** none · **Status:** resolved

- [x] Fake herdr shows the trust sentence → `hud_create` result has ok false, dispatch_failed, the `hud trust` reason
- [x] Retry with the same request_key returns the same failure
- [x] A table of STATUS files gives the same state through the panel reader and `hud_read`

## Comments
- 2026-11-14 (orchestrator): landed with 01–03 (2c5d7e1d, 52b21b91, 458ef06b; 489/489).
