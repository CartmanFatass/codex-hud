# 24: Dispatch skips an exhausted first candidate

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** A live exhaustion mark in $HUD_HOME/exhausted.json does not stop the first candidate of a role's run list. 2026-11-26: `pi:mistral/deepseek-v4-1-flash-1017` was marked exhausted (402 budget) at 00:38Z, yet sonic j1fc9c73c7102143b launched on it at 00:41Z and failed with "Invalid Mistral streaming event". In src/mcp/dispatch/orchestrator.ts (~1200) the exhausted filter runs only under `if (!first)`; sonic uses fixed placement so the even planner's exhausted routing never applies. Fix: every candidate, first included, is skipped while its place key carries a live mark, for fixed and even placement and for sonic scouts; when every candidate is exhausted the job fails pre-input with a clear reason naming the marks. Also treat 402 / billing / budget-exceeded errors as quota failures (QUOTA_ERROR) if 99bbe2ad did not already cover the dispatch path.

- [x] A test: role with run [A, B], A marked exhausted, B not: the job launches on B without trying A (fixed placement and even placement, plus a prewalk scout)
- [x] A test: all candidates exhausted: pre-input failure whose reason names the exhausted keys; no launch attempted
- [x] Expired marks are ignored (launch on A again after the mark's until passes)
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 21d49f2c7082b509a8035c703ac3783cebc961b1); gate 5/5 passed.
