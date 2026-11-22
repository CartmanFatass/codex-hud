# 01: Sonic runs headless as a one-shot query

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Owner 2026-11-22: sonic is its own kind, not a herdr worker. Census (157 sonic jobs): 97.5% had no interaction, 0 hud_ask, 2 messages in, 1 lease use, 1 repair; startup 7 s median. Sonic runs headless (pi print/JSON mode, no herdr tab or pane) with a normal job record under $HUD_HOME/jobs: brief in, report out, progress and nesting under its parent still shown in the panel. No hud_ask, no continuation, no idle grace; a failure is final and the caller re-dispatches. hud_lease stays available. Spec: §2.1 says sonic is a headless query role outside the herdr worker rules (draft the sentences; the main session tells the owner).

- [x] hud_create role sonic (main session or a worker child) settles with a report and opens no herdr tab
- [x] The panel shows a running and a settled headless sonic under its parent with progress
- [x] npm test and check:fixtures pass

## Comments

Verified headless print mode with local pi and a synthetic provider. The rebased change passes the full test suite and fixture checks, including a regression test that a legacy Sonic at its role cap does not queue a headless query.

- Landed 23610ad0fb3935aa9ddb895ab01bab90192a1144; gate 5/5 passed.
