# 01: Project layout setting and the Board layout

**Status:** done (accepted by the owner; see STATE ledger)
**Blocked by:** none

**What to build:** `.scratch/project-layouts/spec.md` (the setting, the Board column, the consistency rules);
design `docs/design/project-ux/` direction B.

- [ ] Settings → Panel → Project layout: Timeline | Board | Inbox (Inbox may render as Timeline until ticket 02),
  `projectLayout` in hud-settings, default Timeline, applied live like `panelLayout`.
- [ ] Board hub: milestone map rows (cell per slice, `n/m`, age; `+N` when the row is full), `latest` line, one legend
  row, In flight, page rows as gauges; Split list and preview, and Classic.
- [ ] Board Progress: the current milestone open into its slices in cell order (to-try slices as ID + brief sentence),
  older milestones as map rows, jobs outside the ledger, Next.
- [ ] Board Control plane: one chain row per role; the selected role's places in the preview (Split) / under it on
  Enter (Classic); all place keys work there as today.
- [ ] Board Projects list: one table row per project.
- [ ] Consistency rules 1–6 of the spec hold; EN/ZH strings; docs/reference.md; unit tests (40 columns EN and ZH: rows
  exactly 40 wide, no mid-word cut, counts equal Timeline's, place keys work from Board's preview); snapshots.

## Comments
