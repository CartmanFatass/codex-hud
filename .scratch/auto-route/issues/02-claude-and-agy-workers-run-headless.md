# 02: Claude and agy workers run headless

**Status:** done
**Blocked by:** 01
**Owner try:** no

**What to build:** Extend 01's headless mode to the claude and agy CLI harnesses (owner 2026-11-22: Codex and Grok deferred) using their non-interactive modes (survey 2026-11-22): claude `-p --output-format stream-json` with `--resume`/`--session-id`; agy `-p --output-format stream-json` with `--conversation`. Each run is one turn per process. The session id is recorded and every resume (answer, send, repair) starts a new process on that session. The worker MCP config is passed as for tab CLI workers (claude `--mcp-config`; agy as its tab launch does). Roles with only a CLI place (general on agy, frontend-imp on claude) can then run headless.

- [x] Each harness: synthetic fake-bin headless job runs, reports, and resumes on hud_respond and hud_send with the recorded session id
- [x] Worker MCP tools are available in each headless run
- [x] Targeted CLI launch/turn tests pass

## Comments

- Landed b6df17f1f59edceb8ad3609565ebd4d5a98a8a3a; gate 5/5 passed.
