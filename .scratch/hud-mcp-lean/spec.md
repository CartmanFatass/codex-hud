# Lean HUD delegation: from dispatch to a usable report

Within `docs/spec.md` §1, optimize one experience: a caller hands off work, keeps working, and gets enough information to take its next action. Success means fewer unnecessary calls **and** less model-visible context across that interaction. A shorter response that forces another call to recover an ordinary fact is a regression. Deliver and judge the whole change through [one work item](issues/01-lean-delegation.md).

## The interaction

On first use in a project, the caller learns who is available, the effective assignment, which roles can continue, and the applicable convention. It need not see every preset, fallback or config path to dispatch. On a subsequent dispatch with retained valid context, it goes straight to create. If it rechecks the roster, only its explicit matching project/convention version permits omission of the unchanged text; availability is still refreshed. Missing context or a changed project, convention or source restores the full applicable text within its existing cap.

The caller creates a job with a stable request key. The tool declaration emphasizes the ordinary path without removing typed overrides or changing what the caller may authorize. With a live Monitor/native watch, no foreground wait or polling is needed. A caller choosing to look at a running job sees state and useful progress without retrieving terminal output unless it asks for lines. Without a live event channel, explicit wait remains available.

A question supplies its ID and enough text to answer directly; blocks and failures retain their actionable reason. A report-ready notice does not consume the report. One explicit read delivers it and preserves existing read-close semantics. Quiet reads should not carry launch configuration and empty diagnostics. Rich role/job diagnostics and bounded pane output remain available deliberately; they are not prerequisites for normal delegation.

## Evidence and boundaries

Use one synthetic journey covering a first and repeated monitored dispatch; measure actual model-visible MCP reply bytes (`content[0].text`) and tool-definition bytes separately. Normal successful flow, excluding optional inspection and exceptional events: **3 calls first time, 2 on repeat, zero wait polls**. This is a usability target, not a quota. On the quiet seven-role sample, the previous roster was 9,150 B, an ordinary working read 435 B, and the eight tool schemas together 5,912 B (create alone 3,206 B). Aim for roughly 4 KB initial roster, 0.6–1 KB validated roster refresh, and 60–150 B quiet read. Do not truncate required instructions, actionable changes, questions, errors, reports or requested diagnostics to achieve a byte target.

Keep eight orchestration verbs, matching MCP and pi definitions, idempotency, project/watcher scope, response `changes`, existing list/history views, report reread (`full:true`) and cleanup behavior. No generic shell, Monitor transport changes, blanket success-receipt rewrite, runtime install or user configuration edits. Work stays in this private worktree. No dependency on the separate pi-async-hud implementation.
