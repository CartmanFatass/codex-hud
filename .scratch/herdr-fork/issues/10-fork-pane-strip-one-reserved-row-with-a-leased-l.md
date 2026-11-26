# 10: Fork: pane strip (one reserved row with a leased line)

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** herdr-fork/07
**Objective:** herdr-fork

**What to build:** D-2026-11-26-01 step 1b. A pane can reserve one row at its top or bottom, outside the PTY (the PTY gets one row less). A client pushes one pre-rendered line (ANSI styled) with a lease; herdr clips, never wraps; when the lease expires or the client clears it, the row returns to the PTY. Reserving at start is allowed on direct-exec `agent.start`. HUD needs the pane's exact inner width after every resize: emit it on an event (or include it on an existing pane event). Capability flag in ping. Own module, thin call sites. Branch hud-10 from `hud`, merge into `hud`; never push; never install or touch the running server.

- [ ] Tests: reserved row reduces PTY rows by one; pushed line renders clipped at width; lease expiry returns the row; resize emits the new width
- [ ] Top and bottom strips; survives live-handoff with lease semantics documented in HUD-FORK.md
- [ ] ping capability; release build; full suite no new failures; merged on `hud`

## Comments
