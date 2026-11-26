# 02: Unattended trial fixes: Blockers none, trust preflight, one run per Objective, lead failures, Sonic in runs

**Status:** done
**Owner try:** no
**Blocked by:** none
**Objective:** unattended

**What to build:** Main's live trial 2026-11-26 on a synthetic project (~/projects/hud-unattended-trial, Objective `trial`, run qaf94214f1780d1cd then q4ff95ad0b2742523; `hud unattended status` there shows the hand-backs) found: (1) a report line `Blockers: none` paused the run as a blocker (job jbecb068eeb099552); `none` (any case, optional punctuation) means no blocker, same for `Removes: none`. (2) Claude and agy were not trusted for the project, so the lead and an agy imp failed to dispatch; `hud unattended on` must check up front that the project is trusted for every harness the run's roles (imp places, reviewer, lead) can use and refuse with the exact `hud trust <dir>` line, and the scheduler must hold, not retry, an item whose dispatch failed for trust. (3) After run 1 paused, the service started run 2 for the same Objective and re-admitted greet/03, whose job in run 1 had failed: a paused or waiting run still counts as the Objective's active run; never admit a ticket that already has a job in any open run. (4) A lead that never started made closeLeadJob fail with `hud-reap: ENOENT ... SESSION.txt` (lead jbb775b1dc9b944f5): closing a never-started lead is a no-op success. (5) The imp reported `Sonic lookup could not start (herdr_required)` inside the run: workers started by a pane-less run must keep the herdr env they need for Sonic (find what is stripped, e.g. HERDR_PANE_ID removal in src/workflows/wake.ts, and keep the worker's own tab env). (6) The ticket check rejected `- [ ] Live try: none` in the acceptance list; accept a `Live try:` line anywhere in the ticket body, and make the refusal show the expected `**Live try:** none` line. (7) The land-config refusal `expected base, gate, after, push...` must name the missing or invalid field.

- [x] Tests for each of (1)-(7) with fake herdr/CLIs and temp homes
- [x] Live try: main reruns the synthetic trial: one run for the Objective, greet/01 lands, greet/02 starts after it and is accepted by the lead, greet/03 is held as a spec change on Home, exactly one reviewer and one lead acceptance

## Comments

- Landed in this commit (replay base dd87722e9ca8bd0bc48d859e7976bc54ad333d84); gate 5/5 passed.
