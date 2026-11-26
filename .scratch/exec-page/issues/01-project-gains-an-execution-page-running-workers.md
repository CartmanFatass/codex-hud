# 01: Project gains an Execution page: running workers, live thumbnails, delegation tree

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** herdr-fork/12
**Objective:** interaction

**What to build:** Spec display rule (26.02): execution detail is allowed on a separate single-project page, never on Home or multi-project views. In the /hud panel, Project gets an Execution page for that project: every running or waiting job (role, model/preset, state, elapsed, last progress line), a live thumbnail of each tab worker (last few screen lines from herdr `pane.read`, sampled outside paint at a bounded rate only while the page is open, exact-column frames, no I/O in paint), headless jobs show their last progress instead, and a delegation tree (main session → jobs → Sonic children and scouts, from job records). Keys: Enter opens Inspector for the job; one key reveals and focuses the worker's hidden tab (herdr-fork/12), another hides it again. EN/ZH, no-colour and narrow widths per ARCHITECTURE §8. Use the personal-frontend instrument-panel style for layout choices.

- [ ] Frame tests at 60/100/140 columns with synthetic jobs (tab, headless, Sonic child): rows, thumbnails and tree render at exact width; no herdr call happens in paint and none while the page is closed
- [ ] Reveal/hide keys call the fork for the job's own tab only (fake fork test)
- [ ] Owner try: with three workers running in one project, open Execution: see each worker's live screen and who started whom; bring one forward and send it back

## Comments
