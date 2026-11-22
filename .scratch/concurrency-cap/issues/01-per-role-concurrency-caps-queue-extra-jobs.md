# 01: Per-role concurrency caps queue extra jobs

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Owner 2026-11-22: a soft per-role cap on concurrently working jobs, adjustable in Settings; defaults imp 3, general 3, other roles uncapped (sonic children and headless sonic not counted). Counted machine-wide over jobs in a working state (not idle_grace/done/closed). hud_create for a role at its cap does not fail: the job is created as `queued` with its full brief and options, the result and notice say queued and its position, and the watcher starts the oldest queued job of that role when a slot frees (first available place at start time). The panel shows queued jobs with position; hud_close on a queued job removes it. A batch create queues the items past the cap. Spec §2.1.4 / §2.2 sentences drafted for the main session to tell the owner.

- [ ] With imp cap 3 and three working imps, a fourth hud_create returns queued and starts by itself when one settles
- [ ] Settings shows and changes the caps; a raised cap starts queued jobs at once
- [ ] npm test and check:fixtures pass

## Comments
