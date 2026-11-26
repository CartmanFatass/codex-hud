# 26: Fork: the agent sidebar groups panes by two metadata tokens, foldable

**Status:** ready-for-agent
**Owner try:** no
**Live try:** after install and HUD 27, workers of two projects and two features show as two big groups with small groups beneath; fold one and it stays folded after reattaching the client
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner 2026-11-26: the left sidebar should sort workers automatically into big groups (project) and small groups (task) that fold, so the logical relation is visible at a glance. Generic fork feature: when any agent pane's metadata tokens (pane.report_metadata, herdr-fork/19) carry `hud_group`, the expanded agent sidebar renders group header rows `▾ name N` (big) and, inside, `▾ name N` (small, from `hud_subgroup`, indented one cell), with the agent rows beneath in today's order; panes without `hud_group` stay ungrouped above the groups as today; panes with a group but no subgroup sit directly under the big group. A header shows the count and the strongest state colour of its hidden rows when folded. Click or Enter on a header folds/unfolds; fold state is a client preference keyed by group (and group/subgroup) name, kept across restarts like the worktree collapsed_groups, and pruned when a name has not been seen for 7 days. Without any hud_group token the sidebar is byte-identical to today. The collapsed (narrow) sidebar orders rows by group but draws no headers. Hit map, keyboard navigation and agent focus keep working across headers. Document in HUD-FORK.md. Fork worktree on its own branch from `hud`; do not merge, push or install.

- [ ] Panes with hud_group/hud_subgroup render under foldable big and small group headers with counts; ungrouped panes unchanged; no tokens = identical output (tests)
- [ ] Fold by click and Enter; folded header shows count and strongest state colour; fold state persists across client restart and prunes after 7 days unseen (tests)
- [ ] Collapsed sidebar orders by group without headers; navigation and focus skip headers correctly (tests)
- [ ] fmt, clippy, isolated sidebar/client tests, release build pass

## Comments

- Owner 2026-11-26 (clarification, binding): draw the hierarchy as a tree so belonging is visible at a glance, e.g.
  ```
  ▾ MyHUD            3
  ├─▾ nav-redesign   2
  │ ├ ● imp  Execution tab
  │ └ ◐ imp  Recently ended
  └─▸ herdr-fork     1
  ▸ herdr-hud        1
  ```
  Box-drawing connectors (`├─ └─ │`) tie each row to its parent; `▾`/`▸` mark open/folded; folded nodes show their
  count and strongest state colour. Keep the agent row's icon and title as today after the connector prefix; at narrow
  widths connectors take at most 4 cells and the title truncates first. With `ui.ascii`/no box-drawing glyphs, fall back
  to `|- \- |`.
