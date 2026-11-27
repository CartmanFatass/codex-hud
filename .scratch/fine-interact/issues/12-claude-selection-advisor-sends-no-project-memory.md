# 12: Claude selection advisor sends no project memory

**Status:** done
**Owner try:** no
**Live try:** Ask about a selection with the Claude advisor from a project that has Claude auto-memory; the captured provider input (fixture or debug log) holds the excerpt and the owner line, no MEMORY.md or CLAUDE.md content.
**Blocked by:** none

**What to build:** From fine-interact milestone review j21460b4c1de2305d (escalated by lead jd6fefb27177959fd, repair rounds used up): a Claude selection advisor still sends the source project's Claude auto-memory (MEMORY.md) to the provider, against the excerpt-only rule (Architecture §5, fine-interact/01). Main accepted the gap for now because the same provider already receives that memory in the owner's main Claude sessions; fix it here. Run the Claude advisor like the pi advisor after fine-interact/04: in a private empty temp cwd outside any project, with project instructions and auto-memory off, so only the excerpt and the owner line reach it. Prefer an existing Claude Code setting or flag over new machinery; if none disables auto-memory, the empty cwd (no project key) is enough.

- [x] Test: the Claude advisor launch cwd is a private temp dir outside the project and no project memory or instruction file is in its input
- [x] Test: the pi advisor behaviour is unchanged
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base d0995cafb79fb18a31cb14aedbbb8c879a02d804); gate 5/5 passed.
