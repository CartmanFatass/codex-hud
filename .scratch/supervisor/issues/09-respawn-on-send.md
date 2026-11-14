# 09: `hud_send` restarts a dead supervisor for a live worker

**Why:** owner 2026-11-14 (design-08 question 3). After a supervisor dies with the worker alive the job is
`waiting_orchestrator`; nothing supervises it after the main session sends a continuation.

**What:** `hud_send` to such a job (supervisor pid gone, worker pid alive) writes the turn and starts a new supervisor
from the on-disk `turn.json` / `STATUS.json`. Explicit main-session action only; never an automatic restart.

**Who:** imp · **Size:** small · **Blocked by:** 08 · **Status:** resolved

- [x] Dead supervisor + live worker + hud_send → a supervisor runs and the turn settles normally
