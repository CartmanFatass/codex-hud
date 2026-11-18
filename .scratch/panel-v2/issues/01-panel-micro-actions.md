# 01: Panel micro-actions: Go-to-tab (g), inline QA reply (1–4 / d) and safe stop (X)

**Status:** done (b5d3b6b8)
**Blocked by:** none

**What to build:** `docs/spec.md` §2.2 & `.scratch/panel-v2/spec.md` §1. Let the owner jump to a HUD job's herdr tab, answer simple multiple-choice/default worker questions in place, and safely reap a runaway job from the panel.

- [x] Go to worker tab (`g`): on Home (Classic or Split) and Inspector, when the selected target is a HUD thin job with a recorded `TAB` in `SESSION.txt`, pressing `g` invokes `herdr tab focus <TAB>` via a new helper in `src/cli/panel-pane.ts` (showing a brief status note if the tab is already gone). Note: preserve `gg` / `g` top-of-list navigation on non-job views or bind `g` to go-to-tab on job targets while `Home` key always jumps to top.
- [x] Quick QA reply (`d` / `1`–`4`): when an open HUD job question slab or Inspector question is expanded, display numbered options `[1] ...` and `[d] default: ...` hints; pressing `1`–`4` (matching an existing option) or `d` (when a non-empty `suggested` default exists) atomically writes `<job>/qa/qN.answer.md` (`flag: 'wx'`, mode `0600`) and appends a record so `hud watch` / MCP `changes` notify the main session of the owner's answer.
- [x] Safe job stop (`X`): pressing `X` (Shift+X) on an unsettled HUD job shows a one-line confirmation prompt (`Stop <role> <id>? y confirm · Esc cancel`); `y` / `Enter` writes `STATUS.json.close-requested` (when in `idle_grace`) and runs `pi-role-reap <dir>` asynchronously, refreshing the panel on completion.
- [x] Update EN/ZH i18n strings, Help (`?`) shortcuts, `docs/reference.md` / `docs/reference.zh.md`, and add unit tests for input actions and atomic QA writing.

## Comments

- Orchestrator 2026-11-18: a reply takes two keys, `r` and then `1`–`4`/`d`, so the tab keys `1`–`4` can never answer a question by accident (the answer file cannot be undone). This departs from spec §2.2's literal "`1`–`4` or `d` on an expanded slab". Kept until the owner decides.
