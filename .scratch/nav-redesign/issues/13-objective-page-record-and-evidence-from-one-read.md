# 13: Objective page record and evidence from one read; job Inspector → child keeps the Feature/Tickets return chain; Unlinked rows keyed by slug

**Status:** done
**Live try:** on 项目 Tickets (t), filter to nav-redesign, Enter → a ticket with a job → its Inspector → a Sonic child (if any): child shows; Esc walks back to the filtered list on the same row; an open Objective page picks up a newly added result together with its evidence
**Blocked by:** 11
**Objective:** interaction

**What to build:** Repair of milestone review ja67e5bad2d6abc9c findings 3, 4 and its first optional item (nav-redesign/11). (3) src/panel/controller.ts ~553–578 resolves Objective evidence once (preferring the cached Project record), while src/render/work-view.ts ~275–285 replaces the Objective prose from each fresh snapshot but keeps the old `detail.evidence`, which wins in src/render/objective-detail.ts ~176: a result and evidence added while the page is open show the new result without its evidence. Conversely, when an Inspector links an Objective from an old Project snapshot and the fresh read no longer contains that id, the renderer falls back to the old available target instead of 'Current record unavailable'. Resolve the displayed record and its openable evidence together whenever the matching Project read changes (evidence collection stays outside paint, §8), and distinguish not-yet-loaded from read-but-missing. (4) src/render/workboard-input.ts ~502–505 replaces an Inspector with `{kind, target, scroll}` when opening a Sonic/child job, dropping `from` and `back`: from filtered Tickets → Feature → ticket Inspector → child, this clears the Tickets filter, switches from the project-wide job board to the caller-pane board (src/panel/controller.ts ~121–135, 252), sends Esc to Jobs (src/render/monitor-state.ts ~185–189), and a child dispatched from another pane shows 'Job not available'. Preserve the project source and the Feature return chain when moving between job Inspectors. Optional (include): src/render/project-objectives.ts ~74–79 keys an Unlinked feature row's cursor id by its first unfinished ticket path, so Esc misses the row if that ticket lands during the visit; key the row by slug and keep the path for `o`.

- [x] With an Objective page open, adding a result and an evidence entry to the Project record shows both; an Objective removed from a fresh read shows 'Current record unavailable' (EN/ZH); a not-yet-loaded record is not reported as missing (tests)
- [x] Filtered Tickets → Feature → ticket Inspector → child job dispatched from a different pane: the child Inspector shows the job, and Esc steps back to the parent Inspector, the Feature page, then the same filtered Tickets row (test)
- [x] An Unlinked feature row whose first unfinished ticket lands during the visit is still selected on Esc; o still opens a ticket file (test)
- [x] npm test, test:mjs and check:fixtures pass

## Comments

- Landed in this commit (replay base 3143e6b841f4ce04457cc72085b37ffa10f1767c); gate 5/5 passed.
