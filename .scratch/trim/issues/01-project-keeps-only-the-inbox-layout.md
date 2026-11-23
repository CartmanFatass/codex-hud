# 01: Project keeps only the Inbox layout

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner approved removal (D-2026-11-22-27). Remove Project layouts Timeline and Board (Classic and Split both); Inbox becomes the only Project layout, the Settings → Panel → Project layout option goes, a saved timeline/board value loads as inbox. Delete their renderers, i18n strings, fixtures and tests; keep everything Inbox uses. Update spec §2.2.4 lines (Timeline hub, Project layout setting, reference to docs/design/project-ux A/B) and docs/reference*.md. Before deleting, list in the report every user-visible element that disappears.

- [x] Project shows Inbox only, in Classic and Split; no layout setting
- [x] Old saved values load as inbox
- [x] Removed code, strings, fixtures and tests; panel tests pass
- [x] Spec and reference updated; report lists the removed visible elements
- [x] Frames at 40/80/120 EN/ZH unchanged for Inbox

## Comments

- Landed in this commit (replay base 081bf883731119a16c228790084410d1ab4b384c); gate 5/5 passed.
