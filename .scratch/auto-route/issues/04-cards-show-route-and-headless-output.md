# 04: Cards show the route and a headless job's output

**Status:** done
**Blocked by:** 01, 03
**Owner try:** yes

**What to build:** On Home and in the Inspector, a job's card shows its route compactly: a tier mark (light, standard or hard) and a headless mark, with the reason in the Inspector. A headless job has no tab, so the focus action on its card opens its output log in the Inspector, showing the last lines and following live, instead of failing. Statusline zones stay unchanged. Follow the home-compact design's mark grammar.

- [x] Tier and headless marks render within panel width rules in both languages
- [x] Focus on a headless card shows its live output; stop still works

## Comments

- Landed 1b01dca83ac0801dca118a93b5e51984048989af; gate 5/5 passed.
