# 01: To-try rows read as briefs, counts agree, number keys leave the tabs, direct answers, no divider drag

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** `docs/spec.md` §2.2 (to-try sentence and micro-actions sentence, both changed by the owner on
2026-11-19). From the owner's UI/UX review of the live panel (Split layout, zh, 40 columns).

- [ ] To-try rows (Split hub, Progress page, Home's to-try rows, Classic too): with the model on and a brief stored,
  the list row shows the slice ID and the brief's first sentence; the preview (Split) or expanded row (Classic) shows
  the whole brief, the numbered steps and, folded below them, the original ledger text. Model off or no brief yet:
  today's whole original text, wrapped. Nothing breaks inside a word or a path.
- [ ] One count, one form: the "to try" number on the Waiting row and on the Progress row count the same thing (today
  they read `1 待试用` and `2 待试用` side by side on the same panel). The Progress row keeps one form rather than
  flipping between `· 2 待试用` and a meter. A meter's `n/m` says what it counts (today `0/2` with an empty bar).
- [ ] Number keys no longer switch tabs (←→, Tab and a click still do). Whatever `3` opened stays reachable another
  way. The tab bar's count badges no longer look like key hints (today `项目 4` reads like tab 4).
- [ ] On an expanded question slab `1`–`4` and `d` answer directly, without `r` first; `r` keeps only its other uses.
- [ ] Drop the Split divider drag and terminal mouse mode 1002; clicks and the wheel stay; `=`/`-` stay.
- [ ] Help, footer hints, EN/ZH strings, unit tests and frame snapshots follow.

## Comments
