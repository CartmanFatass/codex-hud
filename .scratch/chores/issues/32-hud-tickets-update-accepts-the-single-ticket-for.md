# 32: hud_tickets update accepts the single-ticket form again

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-27: `hud_tickets {op: update, feature: "herdr-fork", ticket: 31, status: "done", tick: [1,2,3,4]}` returned `invalid_arguments: ticket`, while the same edit through `updates: [{feature, ticket: 31, …}]` succeeded. The single form worked earlier the same day (herdr-fork/30), so a recent ticket-store change (likely 02/07/08) broke it. Restore the single form for Markdown and JSON features with the same validation and result as `updates`.

- [ ] Test: single-form update with feature + numeric ticket + status/tick succeeds for a Markdown and a JSON feature
- [ ] Test: single form and updates[] produce identical files
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
