# 03: Opening the panel does not show finished Claude subagents as blocked

**What to build:** opening `/hud` in a long Claude session no longer shows long-finished subagents as blocked or
stalled for the first minute while their transcripts are replayed; they keep their finished state (and hide by age)
and cost no model call until replay catches up.

**Blocked by:** None (in LIVE-FIX, running)

**Status:** resolved

- [x] A finished agent whose transcript needs several passes is never shown running/unknown/blocked
- [x] No model call for a card whose replay has not caught up
