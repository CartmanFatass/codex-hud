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
