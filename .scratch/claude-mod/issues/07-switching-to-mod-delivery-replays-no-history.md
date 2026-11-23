# 07: Switching to mod delivery replays no history

**Status:** done
**Owner try:** no
**Blocked by:** 03

**What to build:** Live check of claude-mod/03 (2026-11-23): after /reload-plugins the mod's first wake submitted ~30 old settled events (hours old, already handled via MCP tasks), and the next hud_create (no task, mod live, watcher_alive true) carried 36 `changes` lines of the same history. Both cost the main session's context and attention (spec §4, 22.28). Fix: (1) when a connection switches to mod delivery, start its changes cursor at the switch (events before it were delivered by tasks) and, while the mod watch is live, return no `changes` on tool results (the mod delivers them); (2) `hud watch --mod`'s first start in a session catches up only on items that still need action (open questions, unobserved failures) plus at most one summary line `N older unread reports — hud_read view:compact`, never one line per old settled job.

- [x] Reload with 30 old unread settled jobs: first wake has ≤1 summary line plus any open questions/failures
- [x] With the mod watch live, hud_* results carry no `changes`; with it dead, changes resume from the switch point, not from the start
- [x] Unit tests for both; `claude plugin test` passes
- [x] Live: reload the mod in a session with old unread jobs; one short wake

## Comments
