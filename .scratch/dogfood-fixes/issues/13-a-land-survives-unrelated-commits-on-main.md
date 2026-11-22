# 13: A land survives unrelated commits on main

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Found 2026-11-22: the main session committed a one-line ticket claim (8f6887a3) while EVENT-WAITS-02's land (flow f97322bb2f1896697) was in its gate; land-runner's checkMain(base) before the fast-forward fails on any move of main, so the whole gate is lost to an unrelated commit. The orchestrator commits tickets and STATE all day, so "never commit during a gate" is a constraint we keep breaking. When main has moved by the fast-forward step and none of the new main commits touch a path the landing touches, the runner replays its tested and records commits onto the new main (cherry-pick, no conflicts allowed) and fast-forwards without rerunning the gate; any overlap or conflict still stops with the current error. The notice names the replay.

- [ ] A main commit on unrelated paths during the gate still lands, without a second gate run
- [ ] A main commit on an overlapping path during the gate still stops before the fast-forward
- [ ] npm test and check:fixtures pass

## Comments
