# 01: Receive actionable HUD events while pi keeps working

**Status:** done (accepted by the owner; see STATE ledger)
**Blocked by:** none

**What to build:** In the dispatching pi main session, provide the experience of Claude Code watching `hud watch`. Use native HUD messages, not a foreground wait, editor input, or generic shell. Keep reads and replies explicit through the existing HUD tools.

- [ ] A question, block, or report-ready event is available at the next supported model boundary during a run; idle sessions wake and no active tool is cancelled. Routine progress is quiet.
- [ ] Notices leave drafts untouched and reports unread, belong to the original live session, and retain existing catch-up and shutdown behavior. Claude/Codex delivery is unchanged.
- [ ] Exercise busy/idle delivery and stale-session filtering in an isolated test and update the pi-specific convention.

## Comments
