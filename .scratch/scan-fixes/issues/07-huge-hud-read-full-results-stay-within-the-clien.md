# 07: Huge hud_read full results stay within the client's tool-result limit

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Main session: `hud_read {job, mode: full}` on a 57 KB oracle report exceeded Claude Code's tool-result limit and was spilled to a file; scan j632148defd832215 F9 saw ~40 KB cuts needing a second read. Return full report text up to a safe size (e.g. 24 KB) and for longer reports return the first part plus `report_path`, byte size and an offset/next hint so the rest can be read in pages (hud_read accepts an offset).

- [x] Report > limit returns a bounded first page, total size and a way to get the next page
- [x] Paging to EOF reproduces the report exactly
- [x] Reports under the limit are unchanged

## Comments

- Landed in this commit (replay base f2e905892dcbcb8be349b5722c7e1788417d0971); gate 5/5 passed.
