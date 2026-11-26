# 01: Send a pane selection with its source to the responsible main session

**Status:** ready-for-human
**Owner try:** yes
**Blocked by:** none
**Objective:** interaction

**What to build:** D-2026-11-26-01 step 3b (docs/fable-proposal/01-herdr-fork-final-plan.md §3). A HUD herdr plugin action on a selection (plugin actions already receive `selected_text` and `stale_content`) opens a small composer that shows the excerpt exactly as it will be sent, plus a question line. It goes, with its source (project, pane, job if the pane is a worker's, time), to the main session responsible for that pane's job, or the project's main session for other panes, through HUD's normal delivery path. If the content changed (`stale_content`), the composer shows the latest text before sending. The reply is that session's ordinary answer. Installed by the HUD installer as part of the herdr component.

- [x] Tests: excerpt and source block delivered once to the right main session (worker pane → job's dispatcher; other pane → project main); stale content shows the new text before sending; empty selection does nothing
- [x] Owner try: select two lines of a failing test in a worker's tab, ask "is this from your last change?": the main session receives the excerpt, the job it came from and the question

## Comments

- Landed in this commit (replay base b5c5e7f3d528b33b2c710887fcc55a55e99a862a); gate 5/5 passed.

- Landed in this commit (replay base 6fa93f4f47c9b625e3b1d5e1a41a73756c323f90); gate 5/5 passed.
