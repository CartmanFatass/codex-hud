# 01: Land jobs of another registered project and survive a moved base

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Live 2026-11-23: a ticket-queue land in toktrack (registered, run with hud_tickets cwd) failed at fast-forward with "Main checkout is not at the recorded base tip" after gate passed twice, because the main session pushed unrelated commits to toktrack main during the gate. The failed queue then could not be resumed from the main session: hud_land refuses with "hud_land requires a managed worktree job in the caller project" since the MCP server's project is MyHUD and hud_land has no cwd. Fix: (1) hud_land accepts a managed worktree job of any registered project (resolve the project from the job record, as the ticket queue does), and a failed ticket queue can be resumed with hud_tickets op run for the same feature without re-dispatching tickets whose job already settled; (2) when fast-forward finds the base moved, rebase onto the new tip and rerun the gate, up to the existing rerun budget, instead of failing; report how many base moves were absorbed.

- [x] hud_land lands a settled worktree job of another registered project; a job of an unregistered project is still refused
- [x] a fixture where main gains an unrelated commit during the gate lands after one automatic rebase and gate rerun
- [x] hud_tickets op run on a failed queue re-lands settled jobs and does not dispatch their tickets again
- [x] docs/reference.md (EN/ZH) updated

## Comments

- 2026-11-24 (main session): already implemented by earlier work; verified by a sonic lookup and spot-checked. hud_land resolves the project from the job and refuses an unregistered one (`src/mcp/land.ts:15-31`, test `tests/unit/thin-mcp-land.test.mjs:113`); base moves are replayed and re-gated up to two times (`src/mcp/land-runner.ts:286-340`, tests `thin-mcp-land.test.mjs:1028`, `:1074`); `run` on a failed queue re-lands without re-dispatch (`src/mcp/ticket-queue.ts:64-76`, test `thin-mcp-ticket-queue.test.mjs:161`); `docs/reference.md:339,372-376,529` and the zh counterparts.
