# 02: A failed resume does not turn a closed, reported job into failed

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** 2026-11-26: `hud_send` to closed agy job jeff4a7a7da010134 (report declared, commit on its worktree) tried to resume, agy "did not open the recorded session", and the job's state became `failed`. Its report and commit were intact, but `hud_land` now refuses it (expects idle_grace, done or closed), so main had to work around it. A resume that fails before the worker accepted any input must leave the job's prior settled state (closed with its report) unchanged and return the failure to the caller (`send_failed` with the reason), recording the failed attempt only as a diagnostic. A resume that did start a new turn keeps today's semantics.

- [x] Test: a closed CLI job whose resume fails at session open stays closed with its report, hud_send returns send_failed with the reason, and hud_land still accepts it
- [x] Test: a resume that fails after the new turn started still records failure as today

## Comments

- Landed in this commit (replay base 72d11e5b5601d4a71104ba1082d9431fb5054740); gate 5/5 passed.
