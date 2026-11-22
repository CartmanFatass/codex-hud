# 03: An agy main session gets job events (A+B) and the resume guard

**Status:** ready-for-human
**Blocked by:** 02

**What to build:** Proposal 25 §2.3, owner 2026-11-22: A+B.
- The main-session tools work from agy as a client without MCP tasks.
- The resume guard covers agy: `_meta` conversation_id is matched against STATUS `agent_session_id`.
- **B:** the HUD PreInvocation hook script (registered by 01) finds the caller's undelivered job events and injects one short text via `injectSteps`, marking them delivered. With no events it prints `{}`, and it stays cheap and bounded.
- **A:** an idle agy pane gets events typed through the existing herdr typed path, only while idle.
- One delivery record is shared, so an event never arrives twice.

- [x] A synthetic hook payload with a pending event gets one injection, and a second run gets `{}`
- [x] An idle fake-agy pane gets the typed event once, and a working one does not
- [x] The resume guard refuses a resumed agy worker
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22 main: landed 93471a3e. Pending file $HUD_HOME/watchers/<pane>.agy-pending (0600, 16 KiB cap, flock + rename claim). Hook: 1.5 ms empty, ~50 ms with an event. Idle flush rides the watcher's existing wakes or its 30 s rescan, so an event that lands after a turn's last model call can wait up to ~30 s. Suite 967/967, release green.
