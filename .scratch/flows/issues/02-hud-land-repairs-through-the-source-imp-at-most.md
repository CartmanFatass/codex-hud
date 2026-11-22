# 02: hud_land repairs through the source imp, at most twice

**Status:** done
**Blocked by:** 01

**What to build:** On conflict or a red gate, send the failing step and log tail to the source job when it is continuable and in grace (else hud_create the same role with retry_of), with the instruction to rebase onto the current base and commit; when that job settles, re-run the land from the gate. Stop after two repairs or on a question the worker asks (the question goes to the main session as usual). The notice reports each attempt in one line.

- [ ] A red first gate goes to the imp, its fix lands without a main-session call
- [ ] After two failed repairs the flow stops and hands back once
- [ ] npm test and check:fixtures pass

## Comments
