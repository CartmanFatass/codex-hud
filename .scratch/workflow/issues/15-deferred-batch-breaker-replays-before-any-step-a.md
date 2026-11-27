# 15: Deferred batch breaker replays before any step admission

**Status:** needs-triage
**Live try:** Via the real stdio MCP in a temp home (tmp/env.sh): build -> approve(to: main) -> job, plus a later-declared two-item breaker-first batch; let the pilot fail before answering approve; after the answer hud_workflow status shows the breaker pause and neither the job nor item 2 has a job id.
**Blocked by:** none

**What to build:** Follow-up from the workflow/14 milestone review (/home/fires/.hud/jobs/j4cb7ad13080159e0/report.md, one major; accepted by lead as a narrow ordering edge). workflow/14 (f23f8995) replays `cursor.pending_settlements` only inside `tickBatch` (`src/mcp/composed-step.ts` ~226-236). `advance` (`src/workflows/engine.ts` ~54-80) visits steps in declaration order and returns on the first staged effect, so after `answerComposed` sets the run back to `working`, a step declared before the batch and unblocked by the answer (e.g. `build -> approve -> land` with `land` staging `startLand`) can be admitted before the batch's deferred pilot failure pauses the run. The batch tail stays protected; only the earlier-declared step slips through. Fix: move the existing deferred-settlement replay so it runs under the run lock before any new effect is selected in the pass (reuse `settleBatchItem`/`applySettlement`; no second breaker evaluator, no per-dispatch guards, no Sonic ledger change). Keep the original hand-back answerable and the drained-batch liveness path.

- [ ] Test: graph with an ordinary job unblocked by an independent `to: main` hand-back, declared before a two-item `breaker: first` batch; the pilot fails while main decides; after the answer both the unblocked job and batch item 2 have no receipt and the run is paused with `pilot failed — …`
- [ ] Existing workflow/14 and one-item drained-batch hand-back tests still pass
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
