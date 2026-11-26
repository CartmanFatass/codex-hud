# 02: Execution page shows ticket-queue runs and where each ticket is

**Status:** ready-for-agent
**Owner try:** yes
**Live try:** open /hud panel → Project → Execution while a hud_tickets run is working and check the run row, step marks and per-ticket stages match hud_read on the flow ID
**Blocked by:** none
**Objective:** interaction

**What to build:** Owner 2026-11-26 asked whether the workflow is visualized and chose this shape. Today a ticket-queue run (hud_tickets run or an unattended run: steps tickets -> review -> accept, per-ticket progress, held/failed items, lead decisions, todo) is visible only as JSON through hud_read on the flow ID or `hud unattended status`; Execution shows only per-job cards and the delegation tree. Add a Runs section at the top of the Execution page (single-project page only, per the spec display rule; Home and multi-project views unchanged; Home keeps showing only hand-backs). One row per ticket-queue run of this project that is working or paused, plus runs that ended within the last hour (same retention idea as fixed-batch rows): feature or Objective, short run ID, the three steps with state marks (waiting, running, done, with the lead verdict on accept), and elapsed time. Under each run one line per ticket with its stage: queued/blocked (blocked by what), worker running, settled, land gate running, landed, held (short reason, e.g. spec change, feature deletion, assumption), failed. Then one summary line: todo count, decisions count, held count, repair rounds when non-zero. Enter on a ticket line opens that job's Inspector; Enter on a run line opens the run's detail (decisions with reasons, todo text, review summary) in the existing Inspector style or a simple scroll view, whichever is less new surface. Data: read the run records under $HUD_HOME/flows (q*.json) with the existing header-scan/visibility helpers used for fixed-batch rows (runVisible, project scope), off the paint path, no model calls, no extra herdr reads. Pane-less (unattended) runs show for the project they belong to. EN/ZH, no-colour and narrow widths per ARCHITECTURE section 8; use the HUD role icons already used in the herdr sidebar (imp, reviewer, lead) where a role is shown. Keep it compact: attention first, detail on demand.

- [ ] Execution shows a Runs section with one row per working, paused or recently ended ticket-queue run of the project, with tickets/review/accept step marks and the accept verdict
- [ ] Each run lists its tickets with their stage (queued/blocked, worker, land gate, landed, held with reason, failed)
- [ ] Enter on a ticket line opens its job Inspector; Enter on a run line shows decisions, todo and review summary
- [ ] Run records are read off the paint path with the existing scan/visibility helpers; Home and multi-project views unchanged
- [ ] EN/ZH, no-colour and narrow-width render tests with synthetic run records

## Comments
