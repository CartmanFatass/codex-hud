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
