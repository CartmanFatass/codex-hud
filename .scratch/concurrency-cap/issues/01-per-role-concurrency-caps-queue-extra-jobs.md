# 01: Per-role concurrency caps queue extra jobs

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Owner 2026-11-22: a soft per-role cap on concurrently working jobs, adjustable in Settings; defaults imp 3, general 3, other roles uncapped (sonic children and headless sonic not counted). Counted machine-wide over jobs in a working state (not idle_grace/done/closed). hud_create for a role at its cap does not fail: the job is created as `queued` with its full brief and options, the result and notice say queued and its position, and the watcher starts the oldest queued job of that role when a slot frees (first available place at start time). The panel shows queued jobs with position; hud_close on a queued job removes it. A batch create queues the items past the cap. Overflow (owner 2026-11-22): an `imp` create at its cap starts as `general` instead when general has a free slot (the general role is the backup implementer, so Gemini and GPT load stay balanced and at most 6 implementers run); the result says it overflowed. Only when both are full does it queue. Overflow is a Settings toggle, on by default, mapping imp→general only. Spec §2.1.4 / §2.2 sentences drafted for the main session to tell the owner.

- [x] With imp cap 3 and three working imps, a fourth hud_create returns queued and starts by itself when one settles
- [x] With three working imps and fewer than three generals, an imp hud_create starts a general and says so
- [x] Settings shows and changes the caps and the overflow toggle; a raised cap starts queued jobs at once
- [x] npm test and check:fixtures pass

## Comments
