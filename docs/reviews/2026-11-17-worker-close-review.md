# WORKER-CLOSE 01 + 02 review

Reviewed `e651befb..ab6815c8` on `wt/worker-close-02` against both tickets, `docs/spec.md`, and the milestone review rules. No scope expansion found. The normal CLI and Pi read-close paths work in the synthetic tests, but the following lifecycle defects block landing.

## Spec

1. **Blocker — `packages/hud-mcp/bin/hud-watch.mjs:273`: automatic read-close can SIGTERM a Pi worker that has resumed work.** `hud_send` can accept an unread idle-grace continuation and start an asynchronous Herdr prompt (`packages/hud-mcp/src/thin-main.ts:1086–1102`); a concurrent or already-waiting `hud_read` can stamp the old report before Pi publishes `working`. The watcher invokes the same unrestricted reaper as an explicit stop. This is not just stale observation: the installed `pi-role-reap` sees `working` in a fresh `agent get` and deliberately falls through to PID-checked SIGTERM (`pi-roles/bin/pi-role-reap:90–116`). With the real reaper, fake Herdr and a synthetic worker transitioning to `working` during reap, I observed `agent.get=working; worker exit=[null,"SIGTERM"]; STATUS=working; reaped=true`.
   **Fix:** Keep the shared reaper, but make automatic read-close conditional on the same settled turn, including any admitted continuation. It must abort rather than take the working-worker stop path if the worker has resumed; explicit `hud_close` can retain force-stop behavior.

2. **Major — `packages/hud-mcp/src/cli-judge.ts:197`: idle session-long subprocesses can prevent CLI settlement and closure indefinitely.** The installers register HUD as a user-scoped stdio MCP in Claude and Codex (`install.d/claude.sh:58`, `install.d/codex.sh:14`), and workers launch with normal MCP discovery (`packages/hud-mcp/src/thin-main.ts:655–664`). A worker that keeps its MCP connection open remains `working` even with an idle Herdr state and a stable report the caller has read. The server waits for the CLI to close its stdin; the supervisor waits for the server to exit. A synthetic worker holding a real HUD stdio connection completed `tools/list`, and at 30 minutes of simulated quiet the judge still returned `working`, `action=null`; the same facts without the child returned `closed`. Pi read-close likewise waits on any persistent child when present (`hud-watch.mjs:233`).
   **Fix:** Reconcile the all-descendants rule with supported long-lived infrastructure before landing. Either keep those processes out of worker ancestry or explicitly agree on a narrow, verifiable distinction between lifecycle helpers and job subprocesses. Do not revert to ignoring every pre-turn child.

## Simplicity and quality

3. **Major — `packages/hud-mcp/bin/hud-watch.mjs:273–276`: a transient Pi reap failure drops the read-close retry.** On an otherwise idle watcher with a healthy file watch and no CLI jobs, a temporary Herdr failure during reap leaves a read Pi worker in `idle_grace` until an unrelated event or the original Pi deadline. A synthetic fail-once reaper saw one attempt after five configured safety periods; an unrelated `job.json` rename immediately produced attempt two and closure.
   **Fix:** Keep the existing slow safety check armed after an unsuccessful read-close reap and re-evaluate eligibility on that tick. No new loop or kill path is needed.

## Optional (non-blocking)

- `packages/hud-mcp/src/cli-judge.ts:82–99` — Linux's per-thread `children` listing can omit live siblings when another child exits during the read. Consider a bounded `/proc` stat fallback if this shows up in practice; test with mixed short- and long-lived siblings rather than adding more mocks.
- `packages/hud-mcp/src/thin-main.ts:1058–1063` — The wall-clock stamp is not tied to the version returned. A replacement written between reading the body and stamping can be counted as read even though the caller got the old body. Bind the receipt to the returned file revision if tightening this race.
- `docs/reference.zh.md:101–117` — The Chinese reference still describes continuation after reading and only checks children newer than the turn. Mirror the changed English behavior.

## Verified

- Inspected the complete commit diff, clean worktree, both tickets and the installed reaper source. PID start ticks and parent PID are checked for positive child evidence. The CLI supervisor retains its existing tick and `/quit` path; the Pi watcher reuses `pi-role-reap`. No new signal path was added to HUD itself.
- `git diff --check e651befb..ab6815c8`: exit 0. `git status --short --untracked-files=all`: clean.
- `tmp/env.sh node --test --test-name-pattern='worker identity|child|read-close:|pi role tools match the real MCP tools/list|thin send records failed and successful outcomes' tests/unit/cli-judge.test.mjs tests/unit/thin-mcp.test.mjs`: **16 passed, 0 failed, exit 0** on Node 24.22.1. The tests exercise real `/proc` child detection, the CLI supervisor and a fake local Decision API; the Pi case checks reap invocation and STATUS, not an actual worker exit.
- `tmp/worker-close-02-checks.log`: both builds exited 0; earlier combined run 133/134, failing tool-description parity. `tmp/worker-close-02-recheck.log`: parity and four focused checks passed, `recheck_exit=0`; the independent run above also passed parity. Three additional synthetic `tmp/env.sh node` probes exited 0 and reproduced findings 1–3. No full-suite rerun or real Pi, CLI, or Herdr worker was launched.

**Verdict: fix first — 1 (active Pi worker killed), 2 (idle MCP subprocess pins a finished worker), 3 (read-close does not retry).**

---

# WORKER-CLOSE 03 re-review · `4c264954`

**Verdict: fix first.** Findings 1 and 2 are fixed within the agreed design. Finding 3 is fixed only when the failed reap leaves the worker idle and still registered with Herdr.

## Spec

- **Finding 1 — fixed.** Pi records the send before prompting. The watcher requires settlement, a newer report and a read receipt for that turn. It checks fresh Herdr status, then rereads the job and STATUS and checks for current-turn descendants before reaping. A read of the previous report after a continuation does not reap; a fresh `working` response prevents an automatic reap. Explicit `hud_close` still force-stops. The agreed window between preflight and the external reaper remains.
- **Finding 2 — fixed.** Pre-turn helpers no longer block CLI settlement, the quiet decision or automatic closure, or Pi read-close. The child check traverses older helpers and still finds an in-turn grandchild. The Chinese reference mirrors the English rules. No scope expansion found.

## Simplicity and quality

1. **Major — `packages/hud-mcp/bin/hud-watch.mjs:282–295`: a partial read-close failure still loses the reap retry.** The timer depends on the job remaining an `idle_grace` candidate and Herdr continuing to report `idle` or `done`. If Pi quits and publishes `closed` but Herdr temporarily fails to close the tab, the STATUS event triggers an immediate terminal-state attempt. If the same outage outlasts that attempt, the watcher cancels the safety tick and exits with the tab unreaped. If the worker is gone but STATUS stays `idle_grace`, the tick instead queries Herdr indefinitely: `agent_not_found` prevents a second reap. I reproduced both with the production watcher and fake Herdr/reaper: the first case made exactly two attempts (`idle_grace`, `closed`) before exiting; the second made one attempt followed by six `agent_not_found` responses despite the recorded fake worker having exited. Neither stamped `reaped_at`.
   **Fix:** Keep failed read-close cleanup pending on the existing slow tick until cleanup succeeds or the turn changes. For a still-live worker, keep the fresh idle and child checks; when Herdr explicitly reports the agent missing and the recorded PID is confirmed gone, allow cleanup without requiring `idle` or `done`. Don't drop the retry just because the first attempt published terminal STATUS.

## Verified

- Reviewed the complete `git show 4c264954`, the previous review, the ticket, the product spec, both reference diffs and the installed reaper source. The reaper can stop a worker before a later inventory or tab-close operation returns an error. The new fail-once fixture exercises the real watcher and safety timer, but exits before changing worker or job state, so it does not cover partial cleanup.
- `tmp/tasks/WORKER-CLOSE-03/checks/suites.log`: both builds completed; CLI judge and thin MCP suites **139 passed, 0 failed**, `exit=0`. The log postdates the edited source.
- `tmp/env.sh node --test` (focused worker identity, child, read-close, continuation, tool parity and send outcomes in `tests/unit/{cli-judge,thin-mcp}.test.mjs`): **22 passed, 0 failed**, exit 0 on Node **24.22.1**. Focused watcher, retention and Pi send checks in `tests/unit/{thin-mcp,job-retention}.test.mjs`: **7 passed, 0 failed**, exit 0.
- `tmp/env.sh node --input-type=module -e …` synthetic probes: both partial-reap reproductions exited 0 after asserting the failures above. The `/proc` probe exited 0: old helper alone `false`, with an in-turn grandchild `true`, after grandchild exit `false`. No real Pi, CLI or Herdr worker was launched.
- `git diff --check ab6815c8..4c264954`: exit 0. `git status --short --untracked-files=all`: clean.

Report: `/home/fires/.hud/jobs/j10ebe798f551f836/report.md` — 1 finding.

**Orchestrator, 2026-11-17:** landed anyway. The remaining finding needs a Herdr failure during cleanup and leaves a tab whose worker already quit; below the blocking bar, kept as a follow-up note on ticket 03.
