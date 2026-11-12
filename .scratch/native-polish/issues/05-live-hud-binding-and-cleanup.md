# 05: `/hud` binds the caller's Claude session live, and CLAUDE-BIND's leftovers are cleared

**What to build:** an ordinary `/hud` (or `! hud panel`) from a Claude Code pane opens a panel whose Home shows
`Claude · this session` with that session's subagents, verified on the owner's real herdr; the bindings in pi-roles
that the CLAUDE-BIND audit lists are fixed the same way (identity from herdr at use time); the stray pane record left
by the first attempt is removed.

**Blocked by:** CLAUDE-BIND landing (outside this feature)

**Status:** resolved

- [x] Live check: `/hud` in a Claude pane binds that session; a nested Haiku test shows on Home
- [x] pi-roles bindings from the audit fixed in Fishpref
- [x] No binding records left under the HUD home
