# 04: Run records carry what the metro map needs: ticket dependencies, per-station change time, gate steps

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Data for the Execution metro map (docs/design/metro-map/README.md "What the build needs" points 1, 4, 5, 6). TicketQueueItem records no blockers once a ticket starts (src/mcp/ticket-queue-state.ts), so started branches cannot be drawn. Keep every ticket's dependency edges on the run record (or read them from the ticket store) for started, landed, failed and held items; record a change time per station (landed, failed, held, answered, gate step change), not only the worker start (projectTicketItem `since`); expose land gate index/total so passed steps are known. Define how graphs the three lanes cannot hold (a dependency that skips a column, crossings, graph.json runs, large queues, prewalk scout flows) reduce to lanes: merge at a shared junction keeping order; the detail line names the blockers. Batch pools and councils project as station groups and member lanes.

- [ ] The Execution collector returns, per open flow, stations (id, kind, state, change time) and edges, for queue runs (incl. started/landed/held/failed items), batches, councils, prewalk flows and lands.
- [ ] Old run records without the new fields still render (edges fall back to wave order) and are not rewritten.
- [ ] Lane reduction is a pure function with unit tests for chains, fan-out, fan-in, skip-a-column, crossing and >3 parallel cases.
- [ ] No new periodic reads; the collector stays within the panel's current refresh cost (measured before/after).

## Comments
