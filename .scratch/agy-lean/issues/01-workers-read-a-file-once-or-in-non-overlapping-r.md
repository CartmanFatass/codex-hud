# 01: Workers read a file once or in non-overlapping ranges

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Survey 2026-11-22 (sonic jd85b0ef85a0e5505): in agy worker conversations 67-70% of read bytes went to files read several times with overlapping ranges (thin-main.ts 12×). Add one line to the shared worker role text (spec: one role text across harnesses, so it applies to all workers): read a file whole once, or in ranges that do not overlap; re-read only after the file changed. Keep it one sentence; no other wording changes.

- [x] One sentence added to the shared worker instructions (implementer, frontend-implementer, general; reviewer/oracle if they read code)
- [x] No other role text changes; tests that pin role text updated

## Comments
