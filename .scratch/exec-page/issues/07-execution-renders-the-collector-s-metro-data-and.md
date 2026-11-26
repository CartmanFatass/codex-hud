# 07: Execution renders the collector's metro data and Enter opens every selectable station

**Status:** ready-for-agent
**Live try:** Open the Execution tab during a live queue run with at least two independent tickets. Check that they branch in parallel from the trunk, that the detail line follows the newest landing or answer, and that Enter on a not-started ticket station opens an inspection.
**Blocked by:** 06
**Objective:** interaction

**What to build:** Repair from milestone review jf5b434ceb903e6ef (findings 1–2 and its 'what to delete'). The blocker: src/render/execution-workflow.ts:26–30 sends every open run through metroFlowFromRun. That function reads `blockers` and rebuilds waves (src/render/execution-metro.ts:1137–1180), while the collector puts the dependency edges in `deps` and already builds run.metro (stations, edges, changedAt, lastChangedId) for queue, batch, council, prewalk, land and graph runs (src/collectors/execution-runs.ts). As a result, independent landed roots are drawn in series, the newest-change detail line follows worker start rather than changedAt, and a repair always shows the failed gate as 1/1 (execution-metro.ts:1111). Render run.metro when present, including reduceMetroLanes for skip and crossing edges, the real gate index/total, and every repair round from exec-page/06. Keep wave inference only for legacy runs without metro. Then delete the renderer's duplicate six-kind projection and its dependency, overflow and lane decisions, plus the unused workflowRows wrapper. Width fitting, glyph placement and hit geometry stay in the renderer. Enter, and a second click (src/render/workboard-input.ts:269–271,329–332), must open something on every selectable station. Retained worker jobs open the worker Inspector; batch pools, future tickets, the main hand-back and folded groups open an inspection built from run facts. A retained job must stay targetable even when another flow already references it (execution-metro.ts:1056–1060). Headers still open Run Detail. Replace the test that asserts Enter does nothing (tests/unit/execution-metro-render.test.mjs:619–620). Label main hand-back as main, not 'Lead acceptance' (execution-metro.ts:1206). The Hairline look, keys and golden frames from exec-page/05 stay the same except where a frame showed the wrong graph.

- [ ] A new-format queue record (two independent landed roots, a worker depending only on the first, a failed gate at step 2 of 3, a newer landing than the latest worker start) passes through collection AND renderMonitor in one test. The frame shows the two roots as parallel branches, the worker downstream of the first root only, the failed gate as 2/3, and the default detail line on the newest change.
- [ ] Skip-a-column and crossing graphs render through reduceMetroLanes in production (the function has a production caller).
- [ ] Enter and a second click on a pool, future ticket, main hand-back or folded group open an inspection; on a retained worker they open its Inspector; on a header they open Run Detail. Input tests cover each.
- [ ] Round one and round two repairs both render and are selectable.
- [ ] Legacy runs without metro data still render through wave inference.
- [ ] The duplicate projection and the workflowRows wrapper are removed; render cost per frame is measured and reported.
- [ ] npm test, npm run test:mjs and check:fixtures pass.

## Comments
