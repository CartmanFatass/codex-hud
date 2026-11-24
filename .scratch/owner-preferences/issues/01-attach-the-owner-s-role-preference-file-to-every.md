# 01: Attach the owner's role preference file to every dispatch of that role

**Status:** wontfix
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-24: low-stakes but reusable taste (e.g. dark by default, colour on elements, attention first) should be settled once and reused across projects, not re-asked per job. Store: `$HUD_HOME/preferences/<instructions>.md`, keyed by the job's instructions name (`frontend-implementer` covers frontend-imp and general jobs that borrow `instructions: "frontend-imp"`; `implementer`, `reviewer`, `oracle` work the same way). In `src/mcp/dispatch/context.ts`, next to the project standing brief (`.hud/brief.md`, around line 108), attach the matching preference file the same way: inlined for browser roles within the same byte budget, a `Read the owner's preferences: "<path>".` reference line for local workers, placed before the project standing brief so the project brief and the task win on conflict. Missing file = nothing attached, no error; a file that is not a regular readable file is skipped with a diagnostic, never a dispatch failure. Record the attached path in the job metadata like the standing brief. docs/reference.md: one short paragraph (what the file is, the key, precedence: task > project brief > owner preferences). No UI, no MCP tool, no new settings.

- [ ] A frontend-imp dispatch and a general dispatch with instructions frontend-imp both carry the frontend-implementer preference reference; an imp dispatch carries implementer's (when present) and not frontend's
- [ ] Missing or unreadable preference file never fails a dispatch
- [ ] Precedence note in the reference line or docs: task > project brief > owner preferences
- [ ] Focused unit tests in the existing dispatch-context tests; the land gate passes

## Comments
