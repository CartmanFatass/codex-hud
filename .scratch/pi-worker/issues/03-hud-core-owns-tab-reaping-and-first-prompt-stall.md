# 03: HUD core owns tab reaping and first-prompt stall recovery

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** `.scratch/pi-worker/spec.md` slice 3. Port `pi-role-reap` faithfully into `src/` plus a `hud-reap` bin (same ownership checks: exact pid + start time, protected orchestrator/foreign panes, tab names, stop marker, idle `/quit` + grace, `--after-pid`; keep the stderr text the watcher parses; no pi-roles ledger writes, R1) and switch its three callers (`operations.ts`, `watch-runtime.ts`, `panel-pane.ts`) — it also reaps CLI tab workers. Port `prompt-stall.mjs` to an in-process function used by `harness-pi.ts` (at most one Enter, only for the just-started bound pane with the exact prompt in an idle editor). This code kills processes: ask for a separate reviewer pass in your report.

- [ ] Ported reap tests (protection, renamed tab refusal, idle vs working, pid reuse refusal, --after-pid) and prompt-stall tests; existing watcher-reap, panel and close suites pass with updated command assertions.
- [ ] Land gate passes.

## Comments

- 2026-11-25 main: imp j3bd8576dccfd4ee1 committed 42e93cf9 (worktree MyHUD-wt/pi-worker-fd4ee1). Reviewer
  j689ee8785e0968d7: changes-required. Blockers: (1) CLI supervisor may stamp a replacement occupant's PID — prove
  job ownership before publishing, fail closed; (2) stale receipt can /quit or close a replacement tab (label match +
  no agent is not ownership; split-only path; session OR name) — require positive launch evidence (e.g. HUD_JOB_DIR).
  Majors: (3) stop before CLI PID discovery freezes cleanup; (4) resumed pi prompt counted delivered by a prior user
  turn — use a transcript boundary; (5) editor matcher accepts ambiguous buffers — decline Enter; (6) distinct
  ownership-refused vs verified-cleanup outcome for descendants; (7) browser receipt path not canonicalized
  (symlinked HUD_HOME). Optional: document --after-pid tightening. Repair sent to the same imp; re-review required
  before land (process-killing code).

- 2026-11-25 main: fix 072a9d7a re-reviewed by jb91504b183e4bb03: changes-required. Fixed: #3, #4, #5, #6. Still
  blocking: (1) CLI discovery proves the shell, not the agent invocation — a same-named CLI restarted in the job shell
  inherits the UUID env and can be stamped and SIGTERMed; refuse unless evidence is specific to the agent launch.
  (2) Dead-PID Pi fallback (`reap-tab.ts:125–136`) still allows `/quit` on a reopened same-transcript Pi — remove it.
  (new) `reap-tab.ts:108–118` discards the shell PID's own foreground entry, so `exec vim` in the old pane gets its tab
  closed — require the original shell at an interactive prompt or decline. Major: (7) `worker-tree.ts:58–61` compares
  `task_dir` verbatim, so an aliased older browser receipt skips both tree captures and `hud_close` can return 0 with a
  grandchild alive — one canonical receipt check at both layers, mismatch is an issue, not a no-op. Second repair round
  to the same imp; another re-review before land.

- 2026-11-25 main: repair 5abe6f23 re-reviewed by je20e15fcf0ec3567: changes-required. Fixed: Pi `/quit` (#2), tab
  close by shell identity (#3), canonical receipt check (#4). Blocker (new, reproduced with a real `sonic-run`): the
  registered-sonic exclusion in `worker-tree.ts:130–134` still compares jobs-root path strings literally, so a stop
  through a path alias captures and SIGTERMs a separately registered sonic child — use the same canonical comparison.
  Partly fixed (#1): CLI adoption is exact, but a completed contradictory foreground observation (different PGID,
  leader is the shell or another name) returns at `cli-supervisor.ts:168–169` without recording the refusal — report
  it, distinct from an aborted query. Third repair to the same imp; re-review before land.
