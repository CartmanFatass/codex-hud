# SUPERVISOR 08 design: event-driven CLI supervisor (oracle, Fable, 2026-11-14; owner decisions applied)

Keeps 08's explicit turns, pure judge and facts-only endings. Replaces the 2 s loop with pushed events, judge-computed
deadlines and one 30 s safety tick. At rest: no spawns, no STATUS.json writes.

## Signals (measured: herdr 0.9.5, protocol 22)
- herdr push stream: `events.subscribe` on `$HERDR_SOCKET_PATH` (newline JSON; `herdr api schema --json`). Per-pane
  filter `{type:'pane.agent_status_changed', pane_id}`; unfiltered `pane.exited`, `pane.closed`, `tab.closed`,
  `pane.agent_detected` (filter client-side). Ack ~100 ms; a live `done` push was observed. `hud-watch.mjs` already uses
  this socket for `tab.closed`. A subscribed connection takes no other requests; one-shot requests (`agent.get`) go on
  a separate connection (no process spawn).
- Files: `fs.watch(jobDir)` (report.md, turn.json, stop/close request files) and `fs.watch(qa/)`.
- Process exit: no pidfd in Node, no inotify on procfs. Fact = `/proc/<pid>/stat` + start time (~8 µs). The status
  push on exit is the fast wake; the tick catches a silent exit (guess: exit emits a status event).
- Descendants: full `/proc` scan ~2 ms (185 procs); sampled lazily only (below). `spawnSync herdr` ~3 ms.

## Shape
One process per job: `wake(reason) → collect facts → judge → write STATUS only if the row changed (ignoring
updated_at) → arm one timer`.
Wakes (250 ms trailing debounce): (1) herdr push for this pane; (2) fs.watch events, ignoring STATUS.json, *.tmp,
supervisor.pid; (3) one setTimeout at `judge(...).wakeAt` (quietSince+10 s settle, quietSince+grace decision, idle
deadline, errorsSince+60 s); (4) a 30 s safety tick (owner: 30 s).

| Fact | Source | Cost |
|---|---|---|
| herdr status | cached from pushes; seeded by one one-shot `agent.get` at start and after reconnect; socket down → null; reconnect 5 s→30 s backoff | 0 at rest |
| pid alive | /proc stat + start time on every wake | 3 syscalls |
| report signature | stat on every wake; hash only when mtime/size changed | 1 syscall |
| turn, stop, close, questions | re-read when the watch names the file, and on the tick | 0–4 |
| newer descendant | lazy /proc scan only when the judge is about to act on quiet (herdr not working 10 s, idle deadline, or tick while not working); else null = not sampled | ~2 ms |
| session id, pid identity | one-shot socket requests at start, retried on events/ticks until known | 0 after |

Budget per job: worker thinking → 2 wakes/min, ~6 syscalls, 0 spawns, 0 writes; herdr done + background tests → plus
one scan per tick; flapping → ≤4 wakes/s after debounce, no scan, no writes; idle grace → tick + one deadline timer.
Spawns only for effects: `/quit`, the ticket 10 pane read, the fixed report prompt.
Hard rule with its own test: STATUS.json is written only when the row changes.

## Judge (keep `packages/hud-mcp/src/cli-judge.ts` and its shape)
(a) returns `wakeAt`. (b) `newerChild: boolean | null`; null never settles or decides — the shell samples and
re-judges. (c) carries `reportSig`; a signature change resets quietSince (a half-written report never settles).
(d) idle deadline while herdr working or a newer child → stay idle_grace, re-check later (advisory status may delay a
quit, never cause one). (e) owner: a newer child does not hold a report back: report + herdr quiet 10 s → idle_grace
(output_written true); children hold only `/quit` and the no-report quiet clock. (f) owner: pid unknown and herdr
`agent_not_found` on three consecutive ticks → waiting_orchestrator ("worker not found"), not failed.
herdr errors with the pid alive: status null → working; with a new report, 60 s of errors counts as quiet for
settling — the 10 s window runs inside the 60 s, not after it.

## Sequences
Report then long summary → stays working until the `done` push, then 10 s stable → idle_grace; only turn.json opens a
turn. Background tests with herdr done → no report, tick scan finds the child, quiet clock held; self-wake arrives as
a working push. Flapping → each working push clears quietSince; one settle after the last done. Continuation in grace
→ hud_send writes turn.json first; the watch sees a new seq → working, new baseline. pid gone → closed with a new
report, else failed ("worker exited"). Supervisor death → hud-watch's 30 s check: worker alive → waiting_orchestrator;
both gone → closed/failed by report. Dispatch stall → turn written before the prompt; a stall after submit still
supervises; a pre-input rejection closes the tab.

## Delete
From hud-cli.mjs at HEAD: every `herdr agent wait` and the nested loops (blocked-resume, grace), sliceMs, skipQuiet*,
pollMs, baseline, turnEnded, turnDescendants, herdrMissing/agentExited/herdrMisses as an exit test, notify,
enrichFailure's pane quota scan, leave. From the 08 draft: `await sleep(2000)`, the per-loop agent get spawn, the
unconditional write, the unconditional child scan, the test preload faking the clock per agent get.

## Owner decisions (2026-11-14)
30 s tick; rule (e); hud_send respawns a dead supervisor for a live worker (follow-up ticket 09); no-pid case (f).
Per-job supervisor process kept (no daemon).
