# 04: Tab pi workers run on the HUD worker extension with HUD's footer

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 02, 03

**What to build:** `.scratch/pi-worker/spec.md` slice 4. Port the tab lifecycle from pi-roles `dispatch.ts`/`dispatch-policy.ts` (STATUS writer, session link, sync/async ask steering, Sonic child collection prompt, idle grace 2/3 cache TTL ≤ 20 min and $0.50 warm cap unchanged, stop, auto-close via hud-reap) as a tab-only lazily loaded module; consolidate QA into `src/worker/qa.ts` (fs-watch wake, in-process notify). Tab UI entry mounts HUD's own footer (`createP10kFooter`) with native t/s; attach herdr's installed `herdr-agent-state` on herdr tabs; MCP adapter only on `mcp: true` (R2), installed under `$HUD_HOME/pi-worker/optional/`; `lens` opt-in. Removed in worker tabs (approved R3): `/role`, `/brief`, `/deepseek-*` slash commands, `PI_ROLES_KEEP_TAB`.

- [ ] Ported dispatch-policy/dispatch/async-ask/autoclose tests on a fake pi with fake timers; STATUS checked against the `JobStatus` contract; tab suites pass.
- [ ] Live: one reviewer tab and one imp tab: follow-up during idle grace, stop mid-turn, sync and async question, resume.
- [ ] Land gate passes.

## Comments

- 2026-11-25 main: context since herdr-fork/04 (26350ad3). Tab Pi now starts through the herdr fork's direct-exec `agent.start` (pi is the tab's PTY root; `src/mcp/dispatch/harness-pi.ts`, `direct-exec.ts`). Tab close after a clean exit belongs to the fork (`on_exit: close_on_zero`) plus HUD's `reapDirect` (`src/runtime/reap-tab.ts`) for retention and crashes. Do not port `pi-role-reap` or any tab-close logic from pi-roles; "auto-close" here means the worker extension ends pi cleanly when the job settles (native shutdown, exit 0). `PI_ROLES_KEEP_TAB=1` exists only to stop pi-roles' launch-blind reaper; drop it together with the pi-roles dispatch extension, and make sure no launch-blind reaper remains. herdr-fork/06 changes `waitDirectReady` in `direct-exec.ts` in parallel; leave that function alone. Live checks run on the installed fork (`herdr --version` ends `-hud.<sha>`); until herdr-fork/05+06 land, a fresh tab may lose its first prompt (main rescues it).
