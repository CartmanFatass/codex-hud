# 03: Standing brief and a convention without per-harness delivery text

**Status:** done
**Blocked by:** none

**What to build:** A registered project's .hud/brief.md is referenced in every local brief after the task (never before it: the opening lines feed tab labels and panel titles) and inlined, bounded, in browser briefs through the existing context block. The convention's per-harness delivery lines (hud-convention.md about lines 23-37) move into tool results as a hint for the caller's own harness; the server remembers it already sent the convention so the model no longer passes convention_version. Proposal A4, A5.

- [x] A project with .hud/brief.md gets one reference line after the task in every local brief; tab labels are unchanged
- [x] hud_create and hud_roster results carry a delivery hint for the caller's harness only
- [x] The convention no longer describes Claude, Codex and pi delivery; a second hud_roster in the same session omits the convention without convention_version
- [x] Main-path tests pass

## Comments
