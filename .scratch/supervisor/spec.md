# SUPERVISOR: only facts end a CLI job; the session hears what the panel shows

**Owner, 2026-11-14:** "the supervisor misjudging and killing workers is the obvious bottleneck"; "why can I see the
failure on the panel and statusline but you don't know". Spec §2 (amended 2026-11-14): only facts end a CLI job;
whatever the panel shows about a job reaches the session that dispatched it; `hud watch`; `changes` in every MCP
response; no typing into the main session's pane; one shared reader for panel and MCP.

Design opinion (Fable, 2026-11-14), facts at f171c595:
- Heuristics still end jobs: one failed `herdr agent get` = "agent exited" (`hud-cli.mjs` `agentMissing`); a stalled
  dispatch prompt marks the job failed while the worker runs unsupervised (`thin-main.ts` `dispatchCli`); a partial
  report write sends `/quit` mid-turn; idle grace ignores background children; supervisor death = job failed
  (`hud-watch.mjs`); a crash in the supervisor fails the job.
- Terminal states have six writers and no announcer; the supervisor's `notify` covers two events.
- The display (`readThinJobs`, `src/collectors/thin-jobs.ts`) and the MCP (`jobStatus` in `thin-main.ts`) derive state
  separately; `hud_create` returns the same receipt whatever dispatch did; `hud_read wait_ms` ignores
  `waiting_orchestrator`.

The design:
1. `failed` needs a fact: the recorded pid gone (or start time changed), the tab closed, or dispatch rejected before
   input. Exit with a report on disk → `closed`. Everything else → `waiting_orchestrator` with a reason.
2. The report settles at turn end: new, herdr not working, no newer background child alive.
3. A dead supervisor with a live worker → `waiting_orchestrator` ("supervisor exited; worker still running").
4. One `jobRow(job, status)` + `jobChanges(prev, rows)` in `src/collectors/thin-jobs.ts`, used by the panel,
   statusline, pi footer, every MCP response and `hud watch`.
5. Dispatch: a stall after the prompt was submitted still starts the supervisor; only a pre-input rejection fails.

Delete: `agentMissing()` as an exit test (pid check; herdr only when pid is null, three misses), the
`turn !== 'done'` → leave branch, the pane quota scan once ticket 10 reads the screen, `supervisor exited → failed`,
the supervisor's `notify`. Not added: nudges, restarts, a new store, a daemon.

Tickets: `issues/01`–`07`, in order; 01–03 are independent of `hud-cli.mjs`; 04–07 after QUIET-DECIDE lands.
