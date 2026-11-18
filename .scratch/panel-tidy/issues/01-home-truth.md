# 01: Home tells the truth and uses its spare rows

**Status:** done (565022bc)
**Blocked by:** none

**What to build:** Home's first screen agrees with the Project tab and does not sit blank. Owner, 2026-11-17, from a
live read of a 38 × 46 panel: Home said "✓ 没有需要你处理的事 · 0 运行中" while Project showed "等你处理 5"; Home's
progress block was titled "里程碑 0.1.4" but counted the whole ledger (60 to try / 38 accepted / 4 dropped, against 0.1.4's
4 to try); about 37 of 46 rows were blank; the summary was cut after one row; the bottom said "✓ 0 今日完成".

- [ ] Home's top line counts STATE's "Waiting for the owner" items as well as job questions, e.g. `? 5 项等你处理 · 0 运行中`;
      ✓ shows only when both are zero. Enter (or a click) on it opens the Project hub's Waiting block.
- [ ] Home's progress block counts the current milestone's slices exactly as the Project hub does (`currentRows` in
      `src/render/project-view.ts`); with no current milestone it is titled as the whole ledger, not a milestone.
- [ ] The progress summary wraps to up to three rows when spare rows allow; it shrinks before the bar does.
- [ ] A "done today" count of 0 is not shown.
- [ ] When cards and decisions leave most of Home empty, the spare rows show the waiting items (one row each) and the
      newest landed slices above the progress block; with live cards these shrink first, cards keep priority as today.
- [ ] Main-path frame tests (synthetic STATE) for the top line, the milestone counts and an idle Home.

## Comments
