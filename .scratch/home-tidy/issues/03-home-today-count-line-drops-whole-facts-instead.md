# 03: Home Today count line drops whole facts instead of cutting mid-label

**Status:** done
**Live try:** Run `hud panel --here --width 32` (and default width) with HUD_LANG/English settings where possible and check the Today line shows only whole count-and-label pairs, no `…`
**Blocked by:** 02

**What to build:** Milestone review jf05354b90f66a48a (major): src/render/home-cards.ts todayRow joins every nonzero Today fact and then cuts the whole line with fit(), so on narrow Home widths the line ends in an unlabeled number, a partial word or a dangling separator (EN 32 cols: `Today 29 landed · 1 failed · 3 …`; 40 cols with bounded scan: `Today ~29 landed · ~11 failed · 12 runn…`). This breaks the ARCHITECTURE §8 rule 'drop optional fields before cutting'. Fix: fit whole count-and-label pairs to the width, dropping whole facts when they do not fit, using the existing drop-before-cut pattern (sectionFacts in the same file) or a shared helper. Drop order is attention first: drop `landed` first, then `running`; keep `failed` longest. Keep the `~` marker on the kept counts. If not even `Today` + one whole fact fits, show `Today` plus whatever fits whole, or only `Today`, never a cut label. Applies to EN and ZH. Do not change the card's content, ordering at wide widths, fold behaviour or zero omission.

- [x] At 32 columns, EN with 29 landed / 1 failed / 3 running renders only whole count-and-label pairs (no `…`, no unlabeled number, no trailing separator); failed is kept
- [x] At 40 columns, bounded scan 29/11/12 renders only whole pairs with the `~` markers kept
- [x] At 56 columns all three facts still render as today, EN and ZH
- [x] Narrow-width regression tests in tests/unit/home-cards.test.mjs cover the three-count case for EN and ZH

## Comments

- Landed in this commit (replay base 06e7e2fd58d6434d217746b2e016d34cb5f70062); gate 5/5 passed.
