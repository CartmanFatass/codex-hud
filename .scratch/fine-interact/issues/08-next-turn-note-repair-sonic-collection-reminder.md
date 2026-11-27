# 08: Next-turn note repair: Sonic collection reminder must not consume a note

**Status:** done
**Live try:** Save a "Note for next turn" for a pi tab worker that has an outstanding Sonic; when HUD sends the Sonic collection reminder the card stays pending; then send the next question (fresh or Alt+Enter): the note arrives once with it and the card shows delivered.
**Blocked by:** none

**What to build:** Milestone review j65cc7a44c3a0636f finding 2 (~/.hud/jobs/j65cc7a44c3a0636f/report.md). In `src/harness/pi/worker/tab-lifecycle.ts` settleTurn (~437-463), when a completed Sonic child is uncollected HUD itself calls `pi.sendUserMessage(sonicCollectPrompt(...), {deliverAs:'followUp'})`. pi represents that as a role-user message, so it is recorded by the `Agent.prototype.followUp` wrap (queuedUserFollowUps, ~:26-35) or starts a turn with messageType 'user' in before_agent_start (~:519-522); the pending note is attached to the reminder and acknowledged (~:575-585), so the card says delivered before the owner sent another prompt. Exclude this HUD-generated wake by provenance (e.g. mark the reminder message / set a one-shot flag around HUD's own sendUserMessage so neither the followUp path nor before_agent_start stages notes for it), not by comparing prompt text. Fresh user prompts and Alt+Enter queued follow-ups keep delivering exactly once; steers and custom-role messages stay excluded.

- [x] A pending note survives a HUD Sonic collection reminder (both the queued-followUp path and the idle-agent new-turn path) and the card stays pending
- [x] After the reminder, a real fresh prompt or Alt+Enter follow-up delivers the note exactly once and the card shows delivered
- [x] Exclusion is by provenance, not text matching; unit tests in tests/unit/pi-worker-tab.test.mjs cover reminder, then fresh prompt, and reminder, then queued follow-up

## Comments

- Landed in this commit (replay base 3c7d344fa591da30880697a2393f31db6a232c05); gate 5/5 passed.
