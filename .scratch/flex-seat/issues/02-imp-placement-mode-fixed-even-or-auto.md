# 02: imp placement mode: fixed, even or auto

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** none

**What to build:** Spec §2.1.4 (D-2026-11-22-30). Replace the imp routing on/off setting with a mode: `fixed` (active preset, as routing off today), `even` (rotate through owner-picked presets so each gets about the same number of imp jobs started in the last 24 h; ties go to the preset order in the role file; an unavailable preset is skipped and the result says so) and `auto` (today's routing, unchanged). Store mode and the even pool in the imp role file or Settings, wherever routing lives now; migrate an existing routing toggle (on→auto, off→fixed) on read without rewriting. Settings shows the mode and, for even, lets the owner pick the pool. Create result, card and job record show `placement: even` with the chosen preset (like the routed tier line today). Overflow to general, retry_of and land repair keep the place chosen at create.

- [ ] fixed/even/auto each pick the expected preset (unit tests, including even rotation by 24 h job count and skip of an unavailable preset)
- [ ] existing routing toggle migrates on read: on→auto, off→fixed, file not rewritten
- [ ] Settings shows and changes the mode and the even pool (EN/ZH); create result and card show the placement
- [ ] overflow, retry and repair keep the create-time place

## Comments
