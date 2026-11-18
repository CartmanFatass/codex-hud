# 03: HUD-run pi jobs use the HUD role text; one question rule

**Status:** ready-for-agent
**Blocked by:** 02

**What to build:** `.scratch/worker-unify/spec.md` decisions 3 and 4. Today a pi imp reads Fishpref
`pi-roles/roles/implementer.md` (helpers `call_sonic`/`call_reviewer`, helper-pane skill), while a CLI imp reads
`packages/hud-mcp/instructions/implementer.md`. Oracle report §2 A4 and §3 B3 "Pi primary" describe the gap.

- [ ] pi-roles (Fishpref, `~/Fishpref/pi-roles`; commit only these files there) gains a HUD mode passed by
      `dispatchPi`: the role body comes from the given HUD instruction file and replaces the pi-roles body (frontmatter
      tools, read-only guard, model defaults stay); `call_sonic`, `call_reviewer`, `rate_helper` and the helper-pane
      skill are not offered. Standalone pi-roles use without the HUD mode is unchanged.
- [ ] `dispatchPi` passes the HUD mode with the role's instruction file; a role without one keeps today's behaviour.
- [ ] All HUD instruction files and `hud-ask`'s printed default line say: after the wait, proceed on the default only
      when it is reversible and inside the brief; otherwise leave that part and name it as blocked in the report.
- [ ] From 02 (deferred there, 2026-11-17): in HUD mode a pi parent with an open sonic child (`parent_job` jobs not yet
      closed/failed; see `packages/hud-mcp/bin/sonic-jobs.mjs`) is not settled, not auto-reaped and keeps its session;
      when it ends a turn with sonic reports it has not collected, it gets one queued follow-up naming the job ids (the
      CLI side is `hud-cli.mjs`'s one fixed prompt; same wording).
- [ ] Tests: pi-roles HUD mode argv and tool list (no helper tools, HUD body present); standalone mode unchanged;
      `dispatchPi` passes the mode; instruction files carry the question rule.
- [ ] Live check by the main session: a pi imp job's tool list has no `call_*`, and it can still run `hud-sonic`.

## Comments
