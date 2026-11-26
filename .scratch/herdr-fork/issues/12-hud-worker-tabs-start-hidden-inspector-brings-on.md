# 12: HUD: worker tabs start hidden; Inspector brings one forward

**Status:** done
**Owner try:** yes
**Blocked by:** herdr-fork/09
**Objective:** herdr-fork

**What to build:** D-2026-11-26-01 step 1a, HUD side. When the running fork reports the hidden-tab capability, every interactive worker tab starts hidden (CLI and pi direct-exec). A role file setting (e.g. `tab_visible: true`) keeps that role's tabs visible. The Inspector's focus action reveals and focuses the job's tab; a second action hides it again. A crashed worker's tab stays hidden until failure retention ends. Nothing reveals a tab automatically. Document in docs/reference.md.

- [x] Fake fork: dispatch passes hidden; a role with tab_visible does not; Inspector reveal/hide call the fork methods for the job's own tab (tests)
- [x] Owner try: start three workers, the tab bar shows only a count; from Inspector bring one forward, type into it, send it back

## Comments

- Landed in this commit (replay base feea030a97917e3ef4cd47efd6baecf789bae280); gate 5/5 passed.

- 2026-11-26 main: fork 0.9.5-hud.a26432a7 installed (live-handoff kept the main tab launch_id). Live: a claude worker (j3a436ad5853bbfba) and an imp started hidden; the main tab stayed visible; the hidden worker reported and its tab closed.
