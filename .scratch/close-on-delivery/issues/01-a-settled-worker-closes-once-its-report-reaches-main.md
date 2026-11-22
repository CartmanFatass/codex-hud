# 01: A settled worker closes once its report reaches main, not only on hud_read

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Owner 2026-11-22: many workers sit idle after finishing. Today (spec §2.1 line ~107, src/runtime/cli-supervisor.ts reportRead, src/mcp/pi-read-settlement.ts) a settled worker closes only when main reads its report with hud_read; otherwise it stays until its idle deadline (CLI 600 s, pi per cache lifetime). Main now mostly learns results from the MCP task notification (summary included) and lands with hud_land without a hud_read, so finished workers idle for the whole grace.

New rule: the report counts as delivered when any of these happens for the current turn: hud_read (as now), the MCP task result carrying the summary is fetched by the client, or hud_land starts on the job. hud_land closes the worker at once (its repair rounds already continue a closed job through hud_send / continued_as; check that path still works). Task-result delivery starts a short `done_grace_s` (role field, default 120 s; 0 = close at once) during which a hud_send still reaches the live worker; then it closes. Without delivery the idle deadline applies as today. A report with an open question is not delivered by the task result alone. Draft the spec §2.1 sentence replacing "Close a settled worker as soon as main reads its report; else keep it until its idle deadline." for the main session to tell the owner.

- [ ] A CLI and a pi job whose MCP task result was fetched close done_grace_s after it, without hud_read
- [ ] hud_land on a settled job closes the worker at once; a gate repair still continues it
- [ ] A hud_send inside done_grace_s reaches the live worker; jobs with open questions keep their grace
- [ ] npm test and check:fixtures pass

## Comments
