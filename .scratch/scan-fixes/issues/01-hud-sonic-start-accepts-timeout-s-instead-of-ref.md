# 01: hud_sonic start accepts timeout_s instead of refusing it

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Session scan (sonic j52c7712b41ba4a70): 8 pi worker calls `hud_sonic {task, timeout_s}` failed with `start or wait for sonic, not both` (src/worker/tools.ts:254) because the description says 'timeout_s defaults to 480' as if it were a start option. Make start ignore-or-accept timeout_s (it has no meaning on start: drop it silently or keep it for the later wait), and word the description so timeout_s belongs to wait. Keep `wait` + `task` together an error, naming the field.

- [ ] `hud_sonic {task, timeout_s}` starts the child
- [ ] `hud_sonic {task, wait}` still fails and the message names `wait`
- [ ] Tool description says timeout_s applies to wait
- [ ] Unit test covers both

## Comments
