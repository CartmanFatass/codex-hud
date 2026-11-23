# State of the universal-hud effort (2026-11-23)

Milestone: 0.2.0 · MCP orchestration & Panel V2 (mcp-next + panel-v2)

[Archived slice rows](archive/STATE-slices-2026-11-22.md); current progress lives in the tickets and land records.

Older handoffs: [2026-11-03 to 11-14](archive/STATE-2026-11-03-to-11-14.md), [2026-11-18](archive/STATE-2026-11-18-now.md). Other history: [documentation archive](../archive/).

## Now

- Imp defaults to the `sol` preset with routing off; the owner configures placement and uses `even` to balance subscriptions (D-2026-11-22-30). Reviewer runs on `astra`.
- The Claude mod (wake, band, slash commands, convention hooks) is in daily use; the owner accepted its band and Accept all on 2026-11-23.

## Waiting for the owner

(none — the main session verifies work and flags only issues the owner needs to judge)

## Next

- Follow-ups: `panel-polish/01–04`, `native-statusline/04` and `land-log/02`. Control's Dispatch today counts only the newest 200 job directories; not ticketed yet.
- Compare one real MCP orchestration day with the 2026-11-21 study. For gate races in sonic-process and fs-wait, use the failure excerpts when they recur.
- Neon proposals 01–16 handled; 17–25 not picked (20 is the global `hud doctor` environment check). Automatic ticket-queue advancement is deferred.
- 0.2.0 released 2026-11-23 (main fast-forwarded, tag v0.2.0, notes `docs/releases/0.2.0.md`). Next ticket: `review-next/08` (ticket queue).
