# 10: Feature page ticket rows: per-ticket landing times, inspectable live jobs, state word kept

**Status:** done
**Live try:** from 项目 → interaction → nav-redesign: a ticket landed before the last queue finished shows its own landing age (not the queue end); a ready/blocked ticket with a recent job still shows its state word next to the job status; Enter on a ticket marked working opens that job's Inspector
**Blocked by:** 07
**Objective:** interaction

**What to build:** Repair of milestone review j3173891f358ab140 findings 1, 2, 3, 5 (nav-redesign/07). (1) src/collectors/execution.ts ~207–228 stamps every queue-run ticket's `ended` activity with `run.endedAt`, so a ticket landed yesterday reads 'landed 5m' when the queue finished 5 minutes ago, and old landings re-enter the ≤ 24 h window; this also feeds the Objective page activity note. Use the individual landing/settlement time (item.changedAt or the job/land receipt time) for both age and the 24 h eligibility. (2) Project resolves a ticket's job ID from target_hint/ticket filename/task text (src/collectors/ticket-rollup.ts:37–51) but execution.ts only keys ticket activity from `ticket`/`slice` receipt fields, so src/render/feature-detail.ts:149–154 shows 'working' from ticket.job with no execJob: Enter expands the checklist and g/P/H cannot reach the worker. Join the already-resolved ticket.job.id to the execution worker/target (jobTargetFor); do not infer a second identity in the renderer. (3) feature-detail.ts ~268–282: when a job observation exists the state word is dropped except for `try`. The ticket says each row carries state mark, word, blockers (← NN) and the job status; make the full-width candidate state word + blockers + status, and shorten (blockers, then word) only when the row runs out of cells. (4) feature-detail.ts:236 orders done tickets by max(file mtime, ledger time, job time), so editing an old ticket or a checkout reorders done. Prefer a dated landing/completion observation (ledger/land receipt/Landed comment); use file mtime only when none exists.

- [x] A unit test with a multi-ticket queue whose tickets landed at different times shows each ticket's own landing age and drops landings older than 24 h even when the queue ended recently; the Objective activity note uses the same times
- [x] A ticket whose job is resolved only through target_hint/filename has its execJob on the Feature row: Enter opens its Inspector and g/P/H act on it (test)
- [x] At 120 columns a ready ticket with a recent unlanded job and a blocked ticket with blockers both show their state word, blockers and job status; at 40 columns blockers drop before the word, the title and status stay readable (tests, EN/ZH, no-colour)
- [x] Done tickets order by landing/completion date; a done ticket with a newer file mtime but an older landing stays below a newer landing (test)
- [x] npm test, test:mjs and check:fixtures pass

## Comments

- Landed in this commit (replay base ddbeb06b20e539cd33e1033e8ca08b9becfcf66b); gate 5/5 passed.
