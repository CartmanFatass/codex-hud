# 01: Decouple Inspector, project view and inbox from the card components

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Spec `docs/spec.md` §5 M1 and the approved "Removed by this spec" list (D-2026-11-23-03). This slice changes nothing visible; it prepares the deletions. Extract the Inspector detail and a flat one-row-per-job renderer out of `src/render/work-card.ts` / `work-lanes.ts`, so `src/render/work-inspector.ts`, `project-view.ts`, `inbox-project.ts` and the statusline fallback `src/render/work-summary.ts` no longer import them. Move the Control preset-editor strings from `src/render/split-i18n.ts` into `src/render/i18n.ts`, so `control-page.ts` no longer depends on Split. Facts with file:line: `/home/fires/projects/MyHUD/tmp/tasks/spec-pivot/review-carbon.md` §4 and `review-astra.md` ("冲突与删除风险").

- [ ] `work-inspector.ts`, `project-view.ts`, `inbox-project.ts`, `work-summary.ts` and `control-page.ts` import neither `work-card`, `work-lanes` nor `split-i18n` (grep in the report)
- [ ] Panel, Inspector and Control render as before: existing render tests pass unchanged
- [ ] `npm test` passes

## Comments
