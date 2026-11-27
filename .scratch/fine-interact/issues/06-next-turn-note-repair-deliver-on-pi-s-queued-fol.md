# 06: Next-turn note repair: deliver on pi's queued follow-up boundary

**Status:** ready-for-agent
**Live try:** Save a "Note for next turn" for a pi worker while it is answering, then queue the next question with Alt+Enter in its tab: when pi drains the queued question the note arrives with it once and the card shows delivered.
**Blocked by:** none
**Objective:** interaction

**What to build:** Milestone review jd24d8862257fc92b finding 4 on fine-interact/03. Notes are staged only in `before_agent_start` (`src/harness/pi/worker/tab-lifecycle.ts:499-512`). A follow-up queued with Alt+Enter while the worker is answering is drained by pi after the current response would stop (installed pi `dist/modes/interactive/interactive-mode.js` ~3838-3843, `dist/core/agent-session.js` ~1758-1770, agent-core `dist/agent-loop.js` ~191-203) without another `before_agent_start`, so the worker answers it without the note and the card stays pending. Cover that queued follow-up boundary (a new user prompt) while still excluding steers, tool steps and custom wakes. Delivered still means pi incorporated the note into that prompt, exactly once.

- [ ] Test: a note saved mid-turn is delivered once with a queued follow-up prompt and marked delivered
- [ ] Test: a steer or tool step still does not consume the note; a fresh prompt still delivers it once

## Comments
