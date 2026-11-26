# 02: Home's Today card is one count line

**Status:** ready-for-agent
**Owner try:** no
**Live try:** open /hud panel Home and check the Today card is a single count line
**Approved removals:** Today card's per-item landing list; Today card's per-role done/failed counts; Today card's gate first-pass/retry line
**Blocked by:** none
**Objective:** interaction

**What to build:** Owner 2026-11-26: the Today card's landing list is not useful on Home (attention first). Today it lists today's landed tickets one per row (`MyHUD Gate flakes collect… 4分`, `另 26 个`), then per-role done and failed counts (`完成 34 1 15 5 •2 87`, `失败 1 •2`) and the gate line (`闸门 一次过 13 · 重试 15`). Owner choice: the card becomes one line, e.g. `今天 29 落地 · 1 失败 · 3 在跑` (EN `Today 29 landed · 1 failed · 3 running`), zero parts omitted, the whole card omitted when all are zero. Remove the per-item list, per-role counts and gate line from the card and delete the collection/render code and tests only they use (keep whatever `hud day` and `hud stats` use; those commands stay the place for detail). Spec §2 Home keeps 'a Today card', so no spec change. Update docs/reference.md's Home section. The card keeps its fold-first behaviour when rows are short.

- [ ] Home's Today card renders as one line with landed, failed and running counts (zero parts omitted; card omitted when all zero), EN/ZH
- [ ] The per-item landing list, per-role counts and gate line are gone from Home, with their now-unused collection code and tests
- [ ] `hud day` and `hud stats` output unchanged; docs/reference.md updated

## Comments
