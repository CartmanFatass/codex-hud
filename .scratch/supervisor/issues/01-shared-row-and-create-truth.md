# 01: one job-row reader; `hud_create` tells the truth

**What:** extract the per-job state rule from `readThinJobs` into exported `jobRow(job, status)` (raw state, display
state, reason, blocked, open questions, report present) in `src/collectors/thin-jobs.ts`; the MCP's own `jobStatus`
is deleted and uses it. `hud_create` returns the row of the job it made; a dispatch failure returns
`ok: false, code: 'dispatch_failed', reason` (same request_key → same answer).

**Who:** imp (agy) · **Size:** ~100 lines · **Blocked by:** none · **Status:** ready-for-agent

- [ ] Fake herdr shows the trust sentence → `hud_create` result has ok false, dispatch_failed, the `hud trust` reason
- [ ] Retry with the same request_key returns the same failure
- [ ] A table of STATUS files gives the same state through the panel reader and `hud_read`
