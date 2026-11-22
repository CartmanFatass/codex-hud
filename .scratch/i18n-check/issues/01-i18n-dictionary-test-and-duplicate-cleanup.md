# 01: i18n dictionary test and duplicate cleanup

**Status:** done
**Blocked by:** none

**What to build:** docs/neon-proposal/12-i18n-static-check.md Slice 1 with defaults Q1 keep the words shown today (i18n.ts wins; delete the 19 overridden duplicates from workboard-i18n.ts / split-i18n.ts, zero visual change), Q2 empty allowlist, Q3 include the {placeholder} EN/ZH match check. New tests/unit/i18n-dictionaries.test.mjs: fails on keys repeated across the three dictionaries and on literal t('...') calls with no Chinese entry. No dead-key check, no dictionary merge. Run after PRUNE-OBS-04 (it edits the dictionary files).

- [x] The new test fails on the base listing the 19 duplicates, passes after cleanup
- [x] EN/ZH frame fixtures unchanged; npm test and check:fixtures pass

## Comments
