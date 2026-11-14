# 09: A CLI turn that ends without a report is not a failed job

**Why:** herdr's `done` is a screen heuristic for "the turn looks finished". A CLI agent waiting on a background
command (agy, 2026-11-14: tests in the background, "Waiting for the test run to complete") shows `done` too. The
supervisor treated `done` without a report as the end of the job, failed it and sent `/quit`, killing 18 minutes of
work in progress (ROLE-BIND 01, job j2341a54f3f7c0e5d).

**What to build:** in `packages/hud-mcp/bin/hud-cli.mjs` the report is the completion signal; herdr's status only says
whether the agent is busy.
- A turn that ends without a new report keeps the job open (`working`, card detail "turn ended, no report yet"); the
  supervisor keeps waiting. A report that appears at any time (also while herdr says working or done) settles the
  turn as today (idle grace or closed).
- Background work counts as busy (owner 2026-11-14: Claude Code and agy park background processes and wake themselves
  when they finish). At the start of each turn the supervisor records the CLI process's descendants (MCP servers and
  other long-lived helpers); while any newer descendant is alive, or herdr says working, the job is busy and the
  no-report clock does not run. A self-wake (herdr back to working) simply continues the turn.
- If the agent stays quiet (herdr not working, no new descendants) with no report for the role's idle grace
  (default 10 minutes), the job turns `waiting_orchestrator` with one notice line to the main session ("quiet without
  a report; hud_send to continue or hud_close to stop"). If the agent wakes by itself afterwards, the job is working
  again.
- The HUD only observes here (owner 2026-11-14: do not interfere with the model's run): it sends the worker nothing
  on its own (no nudge) and does not change the worker instructions for this; the main session decides what to say.
  It never quits an agent because a report is missing; only stop, close, tab closed, agent exit or the post-report
  grace end it.

**Who:** agy-imp (gemini-4-hydrogen-high) · **Size:** about 50 source lines; fake-herdr tests in thin-mcp

**Blocked by:** ROLE-BIND 01 (same files: hud-cli.mjs, thin-mcp.test.mjs)

**Status:** resolved

- [x] done without report → still open; a later report settles it (fake herdr: done → working → done + report)
- [x] a live background child keeps the job busy: the no-report clock starts only when it ends
- [x] quiet past grace → waiting_orchestrator + one notice line; no prompt or `/quit` was sent; a self-wake returns to working
- [x] agent exit or tab closed still fail as today; the existing CLI tests keep passing (with the new expectations)

## Comments

- 2026-11-14 orchestrator: landed as 6f4afa7c. The first imp-on-agy job (j8874939f037d8c0f) was itself quit by this bug while agy
  ran the tests in the background; the orchestrator ran them (65 pass) and reviewed the diff. Full suite 533 green.
  Real check with a 150 s command: see below.
