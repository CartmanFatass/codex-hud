# 01: Project keeps only the Inbox layout

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Owner approved removal (D-2026-11-22-27). Remove Project layouts Timeline and Board (Classic and Split both); Inbox becomes the only Project layout, the Settings → Panel → Project layout option goes, a saved timeline/board value loads as inbox. Delete their renderers, i18n strings, fixtures and tests; keep everything Inbox uses. Update spec §2.2.4 lines (Timeline hub, Project layout setting, reference to docs/design/project-ux A/B) and docs/reference*.md. Before deleting, list in the report every user-visible element that disappears.

- [ ] Project shows Inbox only, in Classic and Split; no layout setting
- [ ] Old saved values load as inbox
- [ ] Removed code, strings, fixtures and tests; panel tests pass
- [ ] Spec and reference updated; report lists the removed visible elements
- [ ] Frames at 40/80/120 EN/ZH unchanged for Inbox

## Comments
