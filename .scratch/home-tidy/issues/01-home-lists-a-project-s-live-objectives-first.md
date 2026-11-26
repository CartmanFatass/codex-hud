# 01: Home lists a project's live Objectives first

**Status:** ready-for-agent
**Owner try:** no
**Live try:** open /hud panel Home while a MyHUD ticket queue runs and check the Objective owning that feature is listed first under MyHUD
**Blocked by:** none
**Objective:** interaction

**What to build:** Owner 2026-11-26: Home's Objective ordering is wrong. Under MyHUD Home showed `engine` (last activity 19 h ago) and `pi-worker` (10/10, nothing left) while today's working Objectives (`unattended` with chores, `interaction` with exec-page / universal-bar) were folded into `+7`. Cause: src/render/home-view.ts projectView sorts open Objectives only by blocked-first and paused-last, so .hud/objectives.md file order decides the rest. New order for open (not done) Objectives: (1) blocked on an owner request, as now; (2) Objectives with a live or queued job, or a working ticket-queue / unattended run, in their features; (3) the rest by most recent activity in their features (latest landing, ticket change or result date, whichever the snapshot already carries; no new disk reads on paint); (4) Objectives whose listed features have no open ticket left (all done or wontfix) are not shown on Home at all (owner 2026-11-26: completed work can simply be hidden; the Project page still lists them, and a recent result line may still show for 3 days as today); (5) paused last. Ties keep file order. Same order in the Project page's Objective list if it uses the same helper. Row budget and the `+N` fold are unchanged; only which Objectives get the visible rows changes.

- [ ] An Objective with a live job or working run is shown before one with older activity, regardless of file order
- [ ] Among the rest, more recent activity sorts first; Objectives with no open tickets are hidden on Home (still listed on the Project page); paused stay last; blocked stay first
- [ ] Render tests with synthetic objectives cover each rule; no extra disk reads in paint

## Comments
