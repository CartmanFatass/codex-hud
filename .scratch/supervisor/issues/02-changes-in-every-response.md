# 02: `changes` in every MCP response; `hud_read` wakes on any change

**What:** `jobChanges(prev, rows)` in `thin-jobs.ts`; the MCP server (one process per main session) keeps an in-memory
cursor and adds `changes` (one line per changed job of this session since its last call) to every `hud_*` response.
`hud_read wait_ms` returns on any change of the job, including `waiting_orchestrator`.

**Who:** imp (agy) · **Size:** ~80 lines · **Blocked by:** 01 · **Status:** ready-for-agent

- [ ] STATUS turns `waiting_orchestrator` → a waiting `hud_read` returns
- [ ] The next `hud_roster` carries that change once, and not again
