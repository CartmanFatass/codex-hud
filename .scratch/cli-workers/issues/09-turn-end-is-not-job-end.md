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
- If the agent stays quiet with no report for the role's idle grace (default 10 minutes), send one nudge: "Your turn
  ended without a report at <path>. If work remains, finish it; then write the report there."
- If it is still quiet with no report after another idle grace, the job turns `waiting_orchestrator` with one notice
  line to the main session ("stopped without a report; hud_send to continue or hud_close to stop"). The HUD never
  quits an agent because a report is missing; only stop, close, tab closed, agent exit or the post-report grace end it.
- `instructions/implementer.md` (and reviewer.md once it exists): write the report as the last step; never end a turn
  while a command still runs in the background; wait for it in the foreground.

**Who:** agy-imp (gemini-4-hydrogen-high) · **Size:** about 60 source lines; fake-herdr tests in thin-mcp

**Blocked by:** ROLE-BIND 01 (same files: hud-cli.mjs, thin-mcp.test.mjs)

**Status:** ready-for-agent

- [ ] done without report → still open; a later report settles it (fake herdr: done → working → done + report)
- [ ] quiet past grace → one nudge prompt; report after the nudge settles normally
- [ ] still quiet → waiting_orchestrator + one notice line; no `/quit` was sent
- [ ] agent exit or tab closed still fail as today; the existing CLI tests keep passing (with the new expectations)
