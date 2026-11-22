# 02: CLI workers start with role text and brief in the first message

**Status:** claimed
**Blocked by:** none

**What to build:** docs/llm/post-change-load-2026-11-22.md Rank 5: agy neon imps still spend turn 1 reading instructions/implementer.md and .hud/brief.md, and every worker reads docs/ARCHITECTURE.md for the §8 rules. dispatchCli puts the role instructions and the project's .hud/brief.md into the first message for CLI agents that have no system-prompt flag (agy; keep --append-system-prompt / --rules where they exist), and the project's .hud/brief.md carries a short copy of ARCHITECTURE §8's rules (or a tight summary with the link) so routine slices need not open ARCHITECTURE.md.

- [ ] A dispatched agy worker's first message contains its role instructions and the project brief; no turn-1 read of either
- [ ] MyHUD .hud/brief.md states the §8 rules
- [ ] npm test and check:fixtures pass

## Comments
