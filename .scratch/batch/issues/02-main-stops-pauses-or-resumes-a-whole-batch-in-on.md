# 02: Main stops, pauses or resumes a whole batch in one call

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01, eng-hygiene/11

**Scope change 2026-11-25:** main-side pause/resume/stop/retry_failed are built in batch/01 (`hud_create({batch, action})`). This ticket keeps only the owner side: one panel key on the batch row and the CLI forms, calling the same controls.

**What to build:** Spec §2.1 (D-2026-11-25-03): main can stop, pause or resume a batch as a whole. Stop: removes every waiting member (eng-hygiene/11's queued-cancel path), lets running members finish (or names how to stop them with owner approval), and ends the batch with its totals. Pause: no new members start; running ones finish; the batch shows paused. Resume: continues with the waiting members in order. Expose this on the batch flow ID through the existing tools (e.g. `hud_close({job: <batch flow>})` for stop, and a pause/resume op where flows already take ops) rather than a new tool if possible; the owner gets the same actions in one step: a batch row in the panel with one key for stop/pause/resume, and the CLI forms below. Owner note 2026-11-25: cancelling 100+ queued jobs took one manual confirmation per job; that must never happen again.

- [ ] Stop on a batch flow removes all waiting members in one call and ends the batch with totals; running members are not killed without owner approval.
- [ ] Pause stops new starts; resume continues in order; state is visible in hud_read.
- [ ] The owner stops (and pauses/resumes) a whole batch with one action: one panel key on the batch row and one CLI command (`hud act stop <batch flow>`, plus `hud act stop --package <label> --queued` for jobs that were created one by one); never one confirmation per job.
- [ ] Tests cover stop, pause, resume and a stop during a pause.
- [ ] Land gate passes.

## Comments


- 2026-11-25 main: the main-side controls already landed with workflow/01 (`hud_create({batch, action:
  'pause'|'resume'|'stop'|'retry_failed'})`, stop removes waiting members via the queued-cancel path; batches now
  run on the workflow engine). This ticket keeps only the owner side: a batch row in the panel with one key for
  stop/pause/resume (confirmed once for the whole batch, never per member) and the CLI forms, both calling the same
  engine controls. No second control path.
