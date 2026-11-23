# 01: Help explains every Home mark; reference Hide-after default fixed

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Acceptance pass 2026-11-22 (report jc717a3cd4c2ba5b3, frames tmp/tasks/ACCEPT/frames/42-43): Help has no entry for ⚡N (running sonic children), the route tier marks ▂▄▆ and the headless mark ∅; ◷ means both 'stalled' and the '◷ queued N' fold; Help says `g job: go to its herdr tab` without the headless Inspector output. docs/reference.md:1047 says Hide after defaults to 15 while line 500, src/settings.ts and the tests say 5. Fix: Help lists each mark (zh+en, ASCII fallbacks), give stalled and queued distinct glyphs (pick one already in the icon table; update Home, docs and fixtures), Help's g line covers headless, reference says 5.

- [ ] Help shows ⚡N, ▂▄▆, ∅, queued and stalled entries in zh and en, ASCII mode too
- [ ] stalled and queued no longer share a glyph on Home
- [ ] reference.md/zh Hide-after default reads 5
- [ ] npm test and check:fixtures pass

## Comments
