# 04: Land failure evidence shows the failing assertion, not blank panel frames

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Scans (j5b0fbe7ad17f060f F3, j2cfddd907cde7d8c F3, j52c7712b41ba4a70 F4, j632148defd832215 F10): the 8 KiB gate excerpt and the 40-line repair tail are often blank TUI frame lines (one excerpt 83 of ~100 lines blank; repair tails cut before the assertion); land failure notices say only `failed: repair 1`. Strip blank/whitespace-only and rendered-frame lines before excerpting, always include the first failing test block (`not ok`/`✖` + assertion) of each failing file, and put the failing step and test names in the failure notice.

- [ ] Excerpt and repair tail contain no whitespace-only runs; each failing test's name and assertion appear
- [ ] Failure notice names the step and up to 3 failing tests
- [ ] Unit tests over a synthetic gate log with panel frames

## Comments
