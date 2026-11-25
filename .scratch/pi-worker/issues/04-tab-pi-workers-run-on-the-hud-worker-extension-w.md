# 04: Tab pi workers run on the HUD worker extension with HUD's footer

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 02, 03

**What to build:** `.scratch/pi-worker/spec.md` slice 4. Port the tab lifecycle from pi-roles `dispatch.ts`/`dispatch-policy.ts` (STATUS writer, session link, sync/async ask steering, Sonic child collection prompt, idle grace 2/3 cache TTL ≤ 20 min and $0.50 warm cap unchanged, stop, auto-close via hud-reap) as a tab-only lazily loaded module; consolidate QA into `src/worker/qa.ts` (fs-watch wake, in-process notify). Tab UI entry mounts HUD's own footer (`createP10kFooter`) with native t/s; attach herdr's installed `herdr-agent-state` on herdr tabs; MCP adapter only on `mcp: true` (R2), installed under `$HUD_HOME/pi-worker/optional/`; `lens` opt-in. Removed in worker tabs (approved R3): `/role`, `/brief`, `/deepseek-*` slash commands, `PI_ROLES_KEEP_TAB`.

- [ ] Ported dispatch-policy/dispatch/async-ask/autoclose tests on a fake pi with fake timers; STATUS checked against the `JobStatus` contract; tab suites pass.
- [ ] Live: one reviewer tab and one imp tab: follow-up during idle grace, stop mid-turn, sync and async question, resume.
- [ ] Land gate passes.

## Comments
