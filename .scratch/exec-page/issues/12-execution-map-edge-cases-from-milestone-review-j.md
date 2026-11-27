# 12: Execution map edge cases from milestone review jc4d4a86fe218e4a4

**Status:** needs-triage
**Live try:** Open the Execution tab during a live queue run where 01 has landed and 02 waits for a slot; the detail line shows no ←01 and Station Detail does not call 01 a blocker.
**Blocked by:** none
**Objective:** interaction

**What to build:** Follow-ups from milestone review jc4d4a86fe218e4a4 (5 majors, 0 blockers). The lead finished run qfccfb53c029ecd08 without them because each is an edge or transient case; see that report for the probes. (1) src/render/execution-metro.ts:573–602,657–673: the free-lane test ignores spurs already placed, so at 40 columns with 16 sequential tickets, where 02 and 03 each have two retained repair rounds, 02 round 2 and 03 round 1 share lane 1, x=6, and metroStationAt returns the wrong one. Reserve each spur's interval before placing the next one, and fall back to inline geometry or the viewport. Also delete the gap-2/gap-1 retries at :670–673 (the viewport exists; Hairline rule 3 stops at gap 3). (2) src/collectors/execution-runs.ts:327–337,973–999,1024–1051: during a standalone land (f…) lease wait after a repair, the collector emits a separate failed Gate station stamped with the current header time and ordered after Lease, so changed-last picks the old failure. Keep the failed timing inspectable, but do not let it paint as current or take a fresh transition time. Check both f… and q… flows. (3) execution-runs.ts:586–593,720–725, execution-metro.ts:938–939,1265–1272, execution-run-detail.ts:278–280: station blockers come from the declared deps, so with 01 landed and 02 waiting for a slot the map shows `not started ←01` and Station Detail lists 01 under 'Blocked by'. Keep the 01→02 wire; use the observed unresolved list (waiting_on) for the wait text and the Blocked-by row. (4) src/mcp/batch-step.ts:54–59, execution-runs.ts:887–890,913–949, execution-run-detail.ts:313–324: a stalled fixed-batch pilot (item left `running`) is counted as ◉×1 in the pool and shown as running on the Pilot line. Derive the display counts and the pilot detail from current stall evidence, as the composed path does; slot accounting stays unchanged. (5) execution-run-detail.ts:249–252,305–306: Station Detail appends 'Job not retained' to any jobId, even when the live station has an execJob target. Tell an available target from a job missing from the current snapshot, and do not claim it was pruned. Do not widen periodic scans.

- [ ] Adjacent repair hosts with two rounds each get distinct hit cells at 40 columns (test asserts metroStationAt per station); gap-2/gap-1 retries removed.
- [ ] A standalone land and a queue ticket in lease wait after a repaired gate failure both have lease wait as the changed-last/current station; the failure remains in Station Detail.
- [ ] Before 01 lands the detail line shows ←01; after 01 lands with 02 waiting for a slot only the wire remains and Station Detail shows no Blocked-by 01.
- [ ] A stalled fixed-batch pilot is not counted as working in pool counts or the Pilot line; after resume it counts as working.
- [ ] Station Detail never shows 'Job not retained' for a station whose job has an Inspector target.
- [ ] Every line exactly width columns; existing golden frames match except frames this ticket changes.

## Comments
