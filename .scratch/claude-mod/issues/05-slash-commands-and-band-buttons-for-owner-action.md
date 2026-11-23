# 05: Slash commands and band buttons for owner actions without a model turn

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** 04

**What to build:** Design: oracle report j173e9f379178e359, 'Slice 3: Slash Commands & Band Buttons' and its action matrix. New `hud act answer|try|retry|land` CLI reusing panel actions (no MCP schema change). Mod registers `/jobs`, `/answer`, `/try`, `/retry`, `/land`, `/stop` (immediate) and answers `/hud` itself by running `hud panel`; band rows get buttons (answer options, accept/flag try, retry, confirmed stop). Retry and slice land record intent (spec §2.2.6). Owner decided: an explicit `/land <job>` on a settled worktree job calls `hud_land({ job })` directly via `$.mcp.call` (confirm first with `$.ui.ask` if its report is unread); slice land from a band button and `/retry` record intent (spec §2.2.6, 22.25).

- [ ] `/hud` opens the panel without a model turn; `/jobs` lists and `/jobs <id>` peeks without marking reports read; display-only output adds nothing to model requests
- [ ] Answering via `/answer` or a band button writes `qa/qN.answer.md` once, resumes headless jobs and logs a panel action so main hears it
- [ ] `/try`, `/retry`, `/land`, `/stop` (confirm on running jobs) follow spec §2.2.4/§2.2.6; no MCP schema bytes added
- [ ] `claude plugin validate`, `claude plugin test` (commands and button presses on terminal and desktop) and `tests/unit/cli-act.test.mjs` pass

## Comments

- 2026-11-23: claude-mod/04 narrowed the band to owner-needed items (Waiting + Accept all count). Band buttons follow that: Accept all, and opening a Waiting item; answer/retry/stop stay slash commands, not band rows.
