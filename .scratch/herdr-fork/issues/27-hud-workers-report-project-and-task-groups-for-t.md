# 27: HUD: workers report project and task groups for the herdr sidebar

**Status:** ready-for-agent
**Owner try:** yes
**Live try:** with workers of MyHUD (two features) and one herdr-fork worker running, the herdr sidebar shows MyHUD and herdr-hud groups with feature subgroups and the main session inside MyHUD
**Blocked by:** 26
**Objective:** herdr-fork

**What to build:** Owner 2026-11-26, HUD half of herdr-fork/26. Where HUD reports pane metadata (src/mcp/dispatch/direct-exec.ts tokens: hud_role, hud_ticket, hud_icon), add `hud_group` = the job's registered project name (the same name the panel shows) and `hud_subgroup` = the ticket's feature slug (from `job.ticket` `feature/NN`), else the package label, else the parent job's subgroup for Sonic children and prewalk scouts, else omitted. Where a main session's pane is known to HUD (the Claude mod, the pi extension, or the statusline path that already knows its pane), report `hud_group` for that pane too so the main session sits in its project's group. Require the fork capability for grouped sidebar if herdr-fork/26 adds one; otherwise tokens are harmless on older forks. No new reads on the paint path. Update docs/reference.md.

- [ ] Worker panes carry hud_group (project) and hud_subgroup (feature, package or parent's) in their metadata (tests over synthetic jobs)
- [ ] A main session pane known to HUD reports hud_group for its project (test)
- [ ] docs/reference.md describes the grouping

## Comments
