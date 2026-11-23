# 09: Same-brief jobs are distinguishable on Home

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Three general jobs dispatched from one brief with different models all show `Open review: ho…` on Home and cannot be told apart (Home no longer shows the model, D-2026-11-22-24). When two or more visible rows share a title, append a short distinguishing tag (preset or model short name) to those rows only.

- [x] Rows with identical titles show a short model/preset tag; unique titles unchanged
- [x] Frames updated EN/ZH at 42 and 80 columns

## Comments

- Landed in this commit (replay base 4aa19e07ec25753949fb942d1ba01f9e15ee4a91); gate 5/5 passed.
