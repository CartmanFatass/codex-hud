# 08: Coalesce settlement notices

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Settlement lines that arrive within a few seconds become one notice in hud watch and the other delivery paths (src/cli/watch.ts:20-21), so a large main-session context is woken once; questions stay immediate. Small.

- [x] Three settlements within the window produce one notice naming all three
- [x] A question is delivered at once
- [x] Main-path test passes

## Comments
