# State of the universal-hud effort (2026-11-22)

Milestone: 0.2.0 · MCP orchestration & Panel V2 (mcp-next + panel-v2)

[Archived slice rows](archive/STATE-slices-2026-11-22.md); current progress lives in the tickets and land records.

Older handoffs: [2026-11-03 to 11-14](archive/STATE-2026-11-03-to-11-14.md), [2026-11-18](archive/STATE-2026-11-18-now.md). Other history: [documentation archive](../archive/).

## Now

- On 2026-11-22 the main session verified the ready-for-human batch (agy orchestration, MCP behaviours and the panel/statusline pass). SONIC-AUTO-THINKING and FANOUT-TASK were verified live.
- The owner is trying agy Gemini 4 Neon High as the default implementer; astra remains available for hard slices (D-2026-11-22-17/20).

## Waiting for the owner

(none — the main session verifies work and flags only issues the owner needs to judge)

## Next

- Follow-ups: `panel-polish/01–04`, `native-statusline/04` and `land-log/02`. Control's Dispatch today counts only the newest 200 job directories; not ticketed yet.
- Compare one real MCP orchestration day with the 2026-11-21 study. For gate races in sonic-process and fs-wait, use the failure excerpts when they recur.
- Neon proposals 01–16 handled; 17–25 not picked (20 is the global `hud doctor` environment check). Automatic ticket-queue advancement is deferred.
- Release after the follow-ups land: fast-forward main to universal-hud, tag and publish (owner approved 2026-11-22). Last release: v0.1.4 (2026-11-14).
