# Project layouts: Board and Inbox beside Timeline

Owner, 2026-11-20: bring back PROJECT-UX directions B (Board) and C (Inbox), consistent with the PANEL-UX round.
Design: `docs/design/project-ux/` (README, `b-*` / `c-*` images, `tools/dir-b.mjs`, `tools/dir-c.mjs`). The images date
from 2026-11-14 and show the Classic hub with the old tab bar and keys: build their structure, not their dated details.

## What it is

Settings → Panel → **Project layout**: Timeline (today's Project tab, PROJECT-UX A plus its transplants; the default) |
Board (B) | Inbox (C). Stored as `projectLayout` in hud-settings beside `panelLayout`. Works in both panel layouts
(Split is the one the owner uses: the list rows and the preview of the selected row change; Classic: the page rows).
Home is untouched in every layout (the owner deleted panel-v8's Home Inbox on 2026-11-18; C is Project-tab only).

| Page | Timeline (today) | Board (B) | Inbox (C) |
|---|---|---|---|
| Hub | Now, Latest, page rows | milestone map (one row per milestone, one cell per slice, `n/m` and age) with a `latest` line and one legend row; In flight; page rows as gauges | Needs you (ranked, the reason as a word on the right), Running, `last accepted` line, page rows |
| Progress | dated feed, milestone folds | current milestone open into its slices in cell order, older milestones as map rows, jobs outside the ledger, Next | To try (every milestone, newest first), Blocked, Working, Next, Done folded to one row |
| Control plane | attention first, Healthy folded (stays) | one chain row per role (`✗pi › ◉agy › ○claude`); the selected role's places in the preview (Split) or expanded under it (Classic) | same as Timeline (it already is C's) |
| Projects list | last event per project | one table row per project (`ms`, ledger strip, `?`, `◉`, age) | groups Needs you / Running / Quiet |
| Tickets | lanes by state with For you | same | same |

## Consistency rules (from PANEL-UX 01/02; every layout keeps them)

1. **Counts.** A layout arranges; it never counts differently. The to-try number is `tryCount` everywhere; the tab
   badge `?N` and the Waiting figures are today's. Inbox's Needs-you header shows the same `N · M 待试用` figures
   as Timeline's Waiting row, with the other kinds (blocked, at limit, tickets asking) as their own words, not a new total.
2. **To-try rows.** Wherever a to-try slice is a row (Inbox's Needs you and To try, Board's open milestone), it is the
   slice ID plus its brief's first sentence (`trySentence`/`briefStack`), the brief, steps and folded ledger line in
   the preview / expanded row (`tryDetailRows`); model off or no brief: today's whole text. `Space`, `y`, `n` work on
   them as on Timeline's.
3. **Keys.** No new key. Digits do not switch tabs; `n` only flags; `> <` move between cards; `i`/Del, `K J`, `p m e`,
   `c C`, `x`, `r` keep their Control plane meanings; the footer shows the selected row's keys. Board's place rows are
   the preview of the selected role (Split) or its Enter expansion (Classic), not a new mode.
4. **Rows at 40 columns.** A state word appears once per row; cuts end at a word (`cutWords`; Chinese at a
   character); model names through `shortModel`/`placeRows`; a row is one line except where wrapping is today's rule.
   Board's milestone map and chain rows must fit 40 columns: when a milestone has more slices than cells, the row
   says `+N` rather than overflowing.
5. **Words.** Every new label has EN and ZH (`待试用`, `已验收`, `用量` style); no English left in a zh panel.
6. **Data.** No new collector, no model call, no network (the README's cost notes hold).
