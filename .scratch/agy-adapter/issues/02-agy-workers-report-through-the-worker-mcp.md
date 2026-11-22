# 02: agy workers report through the worker MCP

**Status:** done
**Blocked by:** test-split/04

**What to build:** Proposal 25 §2.2.
- `cliWorkerTools('agy')` is true: the brief's finishing line asks for `hud_report` with the turn token, and agy workers can use `hud_ask`, `hud_sonic`, `hud_progress` and `hud_lease`.
- The finishing prompt keeps the shell fallback `hud-progress.mjs --done … [--summary] [--file]` for a first turn where the tools are not loaded yet. agy loads plugin and global MCP lazily, and in the 2026-11-22 probe the first turn did not see the tool.
- Verify whether `eager: true` in mcp_config.json makes the tools available on turn one. Record the result; if it works, the 01 installer sets it.
- The MCP side reads `_meta["antigravity.google/conversation_id"]` as the session id.

- [x] A fake-agy CLI worker test settles through hud_report; another settles through the shell fallback; both bind to the right turn
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22 main: landed 9ce1fd81. agy workers finish with hud_report; shell fallback line kept. No launch change needed (HUD_JOB_DIR inherited). eager not tested live (needs an authenticated isolated HOME). herdr agent_session_id = _meta conversation_id by code reading. Suite 959/959.
