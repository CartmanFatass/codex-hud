# 08: Ticket queue runs a feature's ready tickets and lands clean settles

**Status:** done
**Owner try:** no
**Blocked by:** 05, 07

**What to build:** Reviews (fable #3, carbon #3, astra #3) and spec § MCP tasks fixed flows (ticket queue). `hud_tickets({op:'run', feature, max_parallel})` claims ready-for-agent tickets with no open blockers, dispatches imp/frontend-imp in worktrees within role caps, starts hud_land when a job settles cleanly (declared report, no open question, checks green, no Blockers: line, ticket not marked for main review), releases dependents after each land, and hands back to the main session once at the first judgement point (question, failed job, red check, land failing after two repairs) or when the batch is done, with one summary notice. Changes spec §2.1.5 'Main decides each step' for this authorized batch (owner approved A–G 2026-11-23; main session updates spec at dispatch).

- [x] A synthetic feature with 3 tickets (one blocked by another) runs, lands and releases in order with one final notice
- [x] A question or red check stops the batch and hands back at once
- [x] Cancel stops new dispatches; running jobs keep going
- [x] Live run on a small real feature

## Comments

- Landed in this commit (replay base 151cb005a0af2afc7cfbd64b8ec9a9bab6a8f7d8); gate 5/5 passed.
