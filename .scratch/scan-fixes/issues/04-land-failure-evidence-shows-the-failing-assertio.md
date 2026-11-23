# 04: Land failure evidence shows the failing assertion, not blank panel frames

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Scans (j5b0fbe7ad17f060f F3, j2cfddd907cde7d8c F3, j52c7712b41ba4a70 F4, j632148defd832215 F10): the 8 KiB gate excerpt and the 40-line repair tail are often blank TUI frame lines (one excerpt 83 of ~100 lines blank; repair tails cut before the assertion); land failure notices say only `failed: repair 1`. Strip blank/whitespace-only and rendered-frame lines before excerpting, always include the first failing test block (`not ok`/`✖` + assertion) of each failing file, and put the failing step and test names in the failure notice.

- [x] Excerpt and repair tail contain no whitespace-only runs; each failing test's name and assertion appear
- [x] Failure notice names the step and up to 3 failing tests
- [x] Unit tests over a synthetic gate log with panel frames

## Comments

- Landed in this commit (replay base f06d5d9f5e57d3725b2a27acac06bb38904a717e); gate 5/5 passed.
