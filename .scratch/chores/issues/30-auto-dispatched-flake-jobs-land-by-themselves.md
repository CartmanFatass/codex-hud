# 30: Auto-dispatched flake jobs land by themselves

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** The flake collector (chores/01) promotes a full flake list and dispatches its imp automatically, but the settled job just sits in idle_grace until main calls hud_land: test-flakes/22 (ja1d6db839e689f0a) and test-flakes/23 (jb1845189b28cf985) on 2026-11-27 both waited for main. A promoted flake job is unattended work with fixed acceptance (each case passes 20 consecutive parallel runs, no weakened assertions): when it settles with a report and a commit, HUD starts its land through the project's land block itself and notifies main only on land failure. A report with Blockers or a scope assumption still goes to main instead of landing.

- [x] Test: a promoted flake job settling with a commit and a clean report gets a land flow without any main call
- [x] Test: a flake report with a Blockers line or scope assumption does not land and notifies main
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 0648f094ab621e21de39ac0f1a668f305f34d411); gate 5/5 passed.
