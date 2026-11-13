# 01: A bad role file is skipped, not fatal

**What to build:** `roleRegistry` (`src/roles/roster.ts`) stops throwing `invalid_role` for one bad file. A file that
fails validation (bad JSON, unknown harness, missing keys, wrong types) is left out of the roles and returned in an
`invalid` list `{ path, reason }`. `hud_roster` shows that list; `hud_create` for a role that exists only as an invalid
file answers `unknown_role` naming the file. The Project tab's control plane lists invalid files with their reason.
This also stops an older MCP from losing every tool when a newer harness kind's role file appears.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] One bad file in `$HUD_HOME/roles` leaves every other role and tool working
- [ ] `hud_roster` lists `invalid: [{ path, reason }]`; reason is short and has no file contents
- [ ] Project tab control plane shows invalid files (fixtures updated)
- [ ] Unit tests for each reason class
