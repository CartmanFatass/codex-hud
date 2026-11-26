# 06: Run records carry true station change times, every repair round and the acceptance seat

**Status:** ready-for-agent
**Live try:** none
**Blocked by:** 05
**Objective:** interaction

**What to build:** Repair from milestone review jf5b434ceb903e6ef (findings 3–6). Fix the producer facts behind the Execution metro map (src/collectors/execution-runs.ts and the MCP state writers); no renderer work here. (a) Repair rounds: execution-runs.ts:298–337 keeps only repairs.at(-1). Keep the ordered repair attempts with distinct station ids (Hairline layout rule 5: round two sits on the same line after round one), including in the inline layout data. (b) Acceptance seat: execution-runs.ts:1090–1096 and :707–718 project any active_lead as the final acceptance worker. A lead judging an assumption or blocker during the tickets step (src/mcp/ticket-queue-step.ts:957) must not appear as acceptance or become its Enter target. Bind the accept station to the acceptance step and the seat recorded for it. (c) Answer times: answerComposed (src/mcp/composed-workflow.ts:175) sets the cursor done without updating changed_at. The main-answered queue question resume path (src/mcp/ticket-queue.ts:469–478) does not record the answer on the item, and the fallback at execution-runs.ts:350–355 accepts only `answered`, not a non-default answer marked `departure` (src/collectors/thin-jobs.ts:899). Record the transition time when the answer happens. (d) Batch pool change time: batch-state.ts:50–53,65–67 stamps updated_at on every save, and execution-runs.ts:801 uses it as the pool change time, so a failed pilot loses lastChangedStationId to the pool. Use actual station transitions. Old records without the new fields still parse. Collector-level tests cover each case.

- [ ] Round two of a land repair keeps round one as its own station with a distinct id; both are present in the run's metro data in order.
- [ ] A lead deciding a ticket-step assumption is not shown as the accept station; the accept station reflects only the acceptance step and its recorded seat.
- [ ] Answering a composed-workflow question or a main-answered queue question (including a non-default `departure` answer) sets that station's changedAt to the answer time.
- [ ] A failed pilot that pauses a batch before the tail starts is the batch's last-changed station, not the pool.
- [ ] Records written before this change still parse (test with a legacy fixture).
- [ ] npm test, npm run test:mjs and check:fixtures pass.

## Comments
