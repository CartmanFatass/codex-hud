# 05: Open an Objective's evidence from Home and Project

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 03

**What to build:** Spec §5 M3 Try ("open its evidence"). Objective rows on Project and Home expose their Evidence entries as files: repo paths open with the existing `open-files` action (`src/render/workboard-input.ts:307`, `src/panel/actions.ts:70-75`, `src/cli/panel-pane.ts` → `$EDITOR` in a herdr tab); a commit hash opens `git show <hash>` in a herdr tab the same way; a URL is shown in full on the detail line (no browser launch). A report under `$HUD_HOME/jobs/<id>/report.md` named as evidence opens like a path. Enter on an Objective row opens a small detail (id, title, state, next, result, evidence list with focusable entries; Esc closes) as other detail pages do; `o` opens the selected entry. Missing paths show as missing, not as errors. EN and ZH strings. Size budget about 300 lines incl. tests.

- [ ] Input test: Enter on an Objective row opens its detail; `o` on a path entry emits open-files with the absolute path; on a commit emits the git-show action
- [ ] Render test: detail with a missing path, a commit and a URL at 120 columns
- [ ] `npm test` passes

## Comments
