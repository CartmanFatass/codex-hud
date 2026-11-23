# 03: Home rows drop the title; marks show progress and a short summary sits under each running job

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** none

**What to build:** Owner 2026-11-22 after using Home: the title after the worker is cut to nothing anyway, so drop it. A job row becomes: state glyph · ticket id (or short brief id when no ticket) · role icon · model mark · route marks · ⚡N · progress marks · age. Progress is shown with marks, not words: the job's stage strip (e.g. read ▸ edit ▸ test ▸ report, from the activity the card already derives) and, while a land runs, its gate ▸ merge ▸ push step folded into the same strip instead of a sub-row. Under each running job, by default, one dim line (two at most on wide panels) with a very short summary of what it is doing now: the existing current sentence, cut to fit, never the ticket title. Settled jobs keep today's folds. Help (panel-polish/01's legend) gains the stage marks. Narrowing order (panel-polish/02) is redone for the shorter row.

- [ ] Home job rows carry no title; the ticket id stays; every mark appears in Help in zh/en/ASCII
- [ ] A running job shows its stage strip and, during a land, the land step on the row; no separate land sub-row
- [ ] Each running job shows a one-line summary under it by default (two lines at ≥100 columns), from the current sentence; none when there is no sentence yet
- [ ] 42/80/120-column golden frames in zh and en; npm test and check:fixtures pass; reference EN/ZH updated

## Comments
