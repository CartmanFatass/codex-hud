# 37: Recent lists a cancelled queue run as cancelled, not landed

**Status:** ready-for-agent
**Owner try:** no
**Live try:** Cancel a run with a landed item and check its Recent row
**Blocked by:** none

**What to build:** 2026-11-27 live try: after main cancelled 20 superseded paused runs, Execution's Recent section showed them as `队列 workflow · 3 张工单 · 已落地` (landed) because some of their tickets had landed. A cancelled or superseded run must show its own end state (`已取消` / `cancelled`, or `已被取代` / `superseded` once chores/33 lands) with the landed count as a detail (e.g. `3 张工单 · 已取消 · 2 已落地`), never the bare landed word.

- [ ] Test: a cancelled run with landed items renders the cancelled state word in EN and ZH in Recent, with the landed count as a detail
- [ ] Test: a completed run still renders landed
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
