# 08: One poll loop and one pure judge for CLI jobs (supersedes 06–07; replaces the loop 04–05 patched)

**Why (owner 2026-11-14):** "for agy, design the supervisor and the state judgment properly; event-by-event Monitor
interrupts are not the answer." Today a finished agy job is shown as quiet/asking (ROLE-BIND 04, SUPERVISOR 02 and
03 all finished and were marked "quiet without a report"). Root cause: `hud-cli.mjs` infers everything from herdr's
screen status through nested waits (~500 lines); a report written while agy is still printing starts idle grace,
the grace loop sees `working` and treats it as a continuation, and re-baselines the report to the finished one.
Patching each path (04–07) keeps the inference; this ticket removes it.

**What to build:** rewrite the CLI supervisor's state handling as:
1. **Explicit turns, not inferred ones.** Dispatch and every `hud_send` write `turn.json` in the job dir
   (`{seq, sent_at, report_sig}`: the report's signature, i.e. mtime, size and hash, at send time). A report
   counts for a turn when its signature differs from that turn's `report_sig`. Herdr status never starts a turn.
2. **One loop, facts every ~2 s:** pid alive (`/proc`, start time), herdr status (advisory only; errors ignored),
   newer descendants since the turn began, report signature, stop/close request files, open questions, herdr
   `blocked`, and the latest `turn.json`.
3. **A pure `judge(prev, facts, now)` → next state**, table-tested:
   - pid gone → `closed` if the turn's report is new, else `failed` ("worker exited");
   - stop or close requested → `stopped` or `closed`;
   - herdr `blocked` → `waiting_orchestrator` (blocked), as today;
   - new report and quiet (herdr not `working` and no newer descendant) for 10 s in a row → settled:
     `idle_grace` (can_continue) or close with `/quit`;
   - no new report and quiet for the idle grace → the ticket 10 decision (unchanged);
   - in `idle_grace`, a new `turn.json` seq → `working`; the deadline passes → close;
   - anything else → `working`.
4. The dead-supervisor watcher: a live worker pid → `waiting_orchestrator` ("supervisor exited; worker still
   running"), not `failed`. A dispatch rejected before input closes the tab it opened.
5. The supervisor's `notify` into the main pane and the pane quota scan on exit are deleted; `hud watch` and
   `changes` announce.

**Who:** imp (agy) · **Size:** net negative or about the same as today (the nested waits go) · **Blocked by:** none

**Status:** ready-for-agent

- [ ] Table test of `judge` covering every row above
- [ ] Fake-herdr test of today's sequences: (a) report written while still `working`, then a long summary, then
      `done` → `idle_grace` with the report, never "quiet"; (b) tests running in the background with herdr `done` → still
      `working`, then the report → settled; (c) herdr flapping `working`/`done` every second → one settle, no notices;
      (d) `hud_send` in `idle_grace` → `working` with a new baseline; a report rewritten then settles again
- [ ] herdr errors for 60 s with the pid alive → still `working`; pid gone → `failed`; pid gone with a new report → `closed`
- [ ] Supervisor killed with the worker alive → `waiting_orchestrator`; both gone → `failed`
- [ ] Real check by the orchestrator: an agy imp writes its report and then prints a summary → `idle_grace` with no notice
