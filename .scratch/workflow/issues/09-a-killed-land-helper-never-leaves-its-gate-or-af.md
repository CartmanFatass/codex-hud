# 09: A killed land helper never leaves its gate or after command running

**Status:** done
**Owner try:** no
**Blocked by:** none
**Objective:** engine

**What to build:** From the engine milestone review (optional, predates the migration): gate and `after` commands run in their own process groups with the timeout enforced by a timer in the land helper (`src/mcp/land-runner.ts:31–52,154–159`). If the helper is SIGKILLed the lease becomes reclaimable (dead PID+start) but the command keeps running, and an `after` command keeps operating in the main checkout while the next land starts. The next lease acquirer (or recovery) must terminate the dead holder's recorded command group, identified by exact PID+start (pi-worker/03 rules: never kill by name or by a reusable PID), before it proceeds. Process-killing code: extra review before land.

- [x] SIGKILL of the land helper during a gate command: the next land terminates that command group (exact PID+start) before starting its own gate; test proves the orphan is gone
- [x] Same for an after command in main
- [x] A reused PID with a different start time is never killed
- [x] Land gate passes

## Comments

- Landed in this commit (replay base f4c14d46431dc116ab00a0fec454488fce0a9076); gate 5/5 passed.
