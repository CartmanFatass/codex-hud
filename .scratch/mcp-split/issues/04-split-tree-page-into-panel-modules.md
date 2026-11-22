# 04: Split tree-page into panel modules

**Status:** ready-for-human
**Blocked by:** none

**What to build:** S4 (:647): tree-page.ts splits into src/panel/*; runs after prune-obs is done (owner default). Frames, keys and PanelReload unchanged.

- [x] tree-page is the entry point only
- [x] check:fixtures shows zero visual change; npm test passes

## Comments

- 2026-11-22 landed c5032bc1 (imp j12807a5a67d181f4): tree-page.ts 36 lines (entry, compat exports, crash recovery); src/panel/ controller 496, lifecycle 107, scheduler 166, actions 177, settings-flow 164, model-services 100, job-pipeline 65, agent-context 88. No test changes. Main: 973/973, unit, check:fixtures; imp ran test:release green. Left as found: TryLog.marks stats the try log on repaint; a quit inside a stdin callback can arm one last 40 ms Escape timer after teardown.
