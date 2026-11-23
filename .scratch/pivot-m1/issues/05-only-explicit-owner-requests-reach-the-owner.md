# 05: Only explicit owner requests reach the owner

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 03, 04

**What to build:** Spec §2.2 owner requests; removal items 15–18. Routine worker completions and notices stop being owner alerts (orchestrator delivery stays). Worker questions, blocked tickets and exhausted roles stop being automatic owner Inbox items, including "Needs you" in the static export (`src/render/html-board.ts:165-181`). The bar's per-role worker icon counts, individual HUD job reminders and `!asking` stop counting as owner load (real native permission prompts stay). The Ticket Inbox with Running/last-accepted rows stops being Project's landing page (keep ticket and worktree diagnostics). Owner requests are explicit (STATE Waiting and orchestrator-written requests), ordered waited-on first, then project priority, then age. Keep `hud_respond`, answer delivery and task continuation (`src/mcp/mcp/operations.ts:711-748`).

- [ ] Test (M1 Try): a routine worker question reaches the main session but not "Needs you", the band or the export; an explicit owner request is visible; the worker's original question stays findable in Jobs → Inspector
- [ ] Test: request ordering is waited-on, then priority, then age
- [ ] `npm test` passes; reference.md (EN/ZH) updated

## Comments
