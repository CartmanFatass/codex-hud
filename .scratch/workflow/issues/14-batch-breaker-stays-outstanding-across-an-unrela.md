# 14: Batch breaker stays outstanding across an unrelated hand-back answer

**Status:** ready-for-agent
**Live try:** Via the real stdio MCP in a temp home (tmp/env.sh): run a two-item `breaker: first` batch next to an independent `to: main` hand-back, let the pilot fail before answering, answer the hand-back, and confirm in hud_workflow status that the run pauses on the pilot failure and item 2 has no job. Also cover workflow/13's pending live try: a cheap run whose task names `../data/<3 MiB synthetic file>` from a subdirectory cwd shows the cost pause.
**Blocked by:** none
**Repairs:** workflow/13

**What to build:** Fix the one major of the workflow/13 milestone review (/home/fires/.hud/jobs/j9be4631050469330/report.md). In `tickBatch` (`src/mcp/composed-step.ts`), an item that settles as failed while the run is paused for another step's hand-back is recorded (`settleBatchItem` in `src/workflows/policy.ts` skips `settlement` when `run.state !== 'working'`), but nothing re-evaluates the breaker after `answerComposed` (`src/mcp/composed-workflow.ts`) sets the run back to `working`. Then the admission guard only checks whether the pilot is *running*, so with `breaker: first` (or a `rate` trip) the next waiting item launches after a failed pilot that main never acknowledged. Fix: a failure that settles while the run is not working stays outstanding (smallest state, e.g. one cursor marker set at settlement). On the next tick where the run is `working`, before any admission, evaluate the breaker for it and pause with the usual reason (`pilot failed — …` / `failure circuit breaker — …`). Item 2 stays `waiting` with no job. Keep the original hand-back answerable, record the failed item immediately as today, and keep the drained-batch liveness path from workflow/13. No new accounting version, no new input resolver, no Sonic ledger changes. Prefer the smallest change; reuse `settlement`/`settleBatchItem` rather than a second breaker evaluator.

- [ ] Test: extend the independent-hand-back scenario (tests/unit/workflow-composed.test.mjs ~704) to a two-item `breaker: first` batch; the pilot fails while main is deciding; after the answer, status shows the batch breaker pause and item 2 is still `waiting` with no job
- [ ] Test: after that breaker pause, `resume` / `retry_failed` behave as for a breaker pause raised while working (no double pause, tail admitted only after the control)
- [ ] Existing one-item drained-batch hand-back liveness test still passes
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
