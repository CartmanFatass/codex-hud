# Risk review: herdr-fork/04 (HUD adopts the fork for CLI and Pi tab workers) (2026-11-25)

Three rounds, read-only reviewers. Brief: tmp/tasks/herdr-fork/brief.md (standing brief plus the owner's blocking
bar: no path that kills a process or closes a tab that is not the job's own, fails a live job, or certifies cleanup
that did not happen). Base dc11e8d8.

| Round | Reviewer job | Head | Verdict |
|---|---|---|---|
| 1 | j9a1259330ebb663a | 47fc7f5c | changes-required (3 blockers, 6 major) |
| 2 | j008e98519f575d71 | 4f50d4dd | changes-required (4 blocking) |
| 3 | jbe3ccfcfb85f1021 | c2979466 | accept — land |

## Round 1 (47fc7f5c)

Blocking:
1. A sibling pane exit could end a live job: the fork mints one launch ID per tab, and the watcher and supervisor
   took any pane exit or close in the launch as the worker's (split Pi). Fix: match `pane.exited` by launch ID and
   root terminal ID; a sibling closing is not the tab closing.
2. Pi still started the pi-roles launch-blind reaper (`pi-role-reap`), which closes by public tab ID/label and could
   quit a resumed worker. Fix: `PI_ROLES_KEEP_TAB=1` on direct Pi launches.
3. Uncertain start reported as cleaned: a public tab ID was saved before a launch ID was proved, and a lost reply
   returned "nothing left". Fix: separate stock cleanup from direct rollback; an ambiguous direct start neither closes
   by public ID nor asserts absence.

Major: missed exits did not converge (live-only subscriptions; partial report turned a missed crash into `closed`);
split cleanup refused the expected root-only remainder and could close an occupied helper; an early crash lost its
scrollback through immediate rollback; a stock rollback could take stock inventory as proof of absence; env
forwarding overwrote a custom `CODEX_HOME` and forwarded session/control handles; Codex at a prompt with status
`unknown` timed out at readiness.

## Round 2 (4f50d4dd)

Round-1 items fixed (terminal-ID scoped events, `PI_ROLES_KEEP_TAB`, partial report no longer success, readiness
failures retain scrollback, prompt-ready unknown Codex, custom `CODEX_HOME`). New blocking:
1. Moving the only worker pane to another tab emits `tab.closed` for the old launch without an exit; supervisor and
   watcher treated it as terminal. Fix: a closed container is not a worker exit; keep a live root unresolved until a
   matching exit or verified PID death.
2. Launch rollback closed the whole tab after checking only its launch ID, bypassing the reaper's occupancy proof.
3. Unknown start was safe only in memory: no persisted state, so the worktree could be removed under a worker spawned
   before the reply was lost; every RPC error was taken as pre-spawn although the fork can return
   `agent_start_failed` after creating the tab.
4. A different socket endpoint could certify cleanup from an inventory that lacked the launch.

Optional: panel Stop passed a bare job directory to `hud-reap`; supervisor prompt/turn effects were not fenced by
session.

## Round 3 (c2979466) — accept

1. `pane.exited` matched by launch ID and root terminal ID; missed events check the recorded PID/start ticks.
2. No tab close in fork rollback: once identity is known, failures keep the receipt and record failure with the
   exact PID/start; ambiguous prompt delivery leaves the worker alone.
3. Lost/incomplete replies and unlisted RPC errors persist `launch_unknown` on create and reopen; the watcher
   excludes those jobs from worktree cleanup and archival. Only the enumerated pre-spawn errors allow fallback.
4. `reapDirect` requires the recorded endpoint and a successful fork ping before stop intent, commands or signals;
   an empty inventory is rechecked.

Also in the rework: panel Stop passes `--launch`, supervisor session fencing, Pi guard dedup.

Residual (optional, not blocking): `workerAlive` treats an unreadable `/proc/<pid>/stat` as death; returning unknown
on read errors would make "verified death" literal. Final tab close stays check-then-use (allowed by the brief). Stale
`rollbackDirectLaunch` reference in `src/mcp/dispatch/proc.ts`.

## Follow-ups

- herdr-fork/05: drop the stock-herdr path (cli-invocation shim/witness, tab-shell, tab-owner, hud-cli exec-witness,
  `retryBusyPane`, stock reap and close reconciliation) once the fork is the only supported herdr.
- `/proc` read errors as unknown in `workerAlive`.
