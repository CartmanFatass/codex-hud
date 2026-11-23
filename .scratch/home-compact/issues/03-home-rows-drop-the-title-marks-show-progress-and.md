# 03: Home rows drop the title; marks show progress and a short summary sits under each running job

**Status:** done
**Owner try:** yes
**Blocked by:** none

**What to build:** Owner 2026-11-22 after using Home: the title after the worker is cut to nothing anyway, so drop it; the row should tell at a glance where the job is, whether it is healthy and whether it needs the owner. Design agreed with the owner (2026-11-22, "可以"):

```
◉ auto-route/08  ●●◐○○  ⚒◎◕ ▆∅ ⚡2   12m
   正在给 ask 路径补 sonic 存活测试
? panel-pol/02   问：参考文档冲突怎么合？     3m
◉ land-log/03    ●●●●◐  ⚒◎◕ ▄∅      8m 静4m
```

1. State glyph + ticket id (short brief id when no ticket). No title.
2. Stage strip, 5 fixed cells read ▸ edit ▸ test ▸ report ▸ land (● passed, ◐ current, ○ not reached), aligned in one column across rows. Derive stages from the activity the card already collects; during a land the 5th cell is current and gate/merge/push detail moves to the Inspector (no land sub-row on Home).
3. Needs-the-owner overrides: asking, failed, unread report replace the strip with a short reason (`问：…`, `✗ gate 红`, `● 报告未读`) and colour the row.
4. Executor as one short group: role icon + provider glyph + effort, then route tier and headless marks (`⚒◎◕ ▆∅`); full model only in the Inspector.
5. `⚡N` running sonic children.
6. Time: total age, plus silence (`静4m` / `quiet 4m`) only after 3 minutes without output, dim then amber past the stalled threshold.
Narrowing drops, in order: route marks → model → role → ⚡N → silence; ticket id, override reason, stage strip and age stay.
Under each running job, by default, one dim summary line (two at ≥100 columns): the current sentence cut to fit, never the ticket title; none when there is no sentence yet. Settled jobs keep today's folds. Help (panel-polish/01's legend) gains the stage and silence marks. Not on the row: title, full model, provider text, worktree name.

- [x] Home job rows carry no title; ticket id, stage strip, executor group, ⚡N and time as above; every mark in Help in zh/en/ASCII
- [x] Stage strips align in one column; a land shows on the strip's 5th cell, no land sub-row
- [x] Asking/failed/unread rows show the reason in the strip's place and are coloured
- [x] Silence shows only after 3 min, amber past the stalled threshold
- [x] Running jobs show the one-line summary (two at ≥100 columns)
- [x] 42/80/120-column golden frames in zh and en; npm test and check:fixtures pass; reference EN/ZH updated

## Comments

- Landed in this commit (replay base 93484a33feb45750744bd936275e756e180f5d1e); gate 5/5 passed.
