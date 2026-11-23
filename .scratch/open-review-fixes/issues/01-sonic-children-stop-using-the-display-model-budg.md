# 01: Sonic children stop using the display-model budget and the job-directory windows

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Open reviews (fable j5c4cb51dc2240e9f #4, carbon j91fa6e1950156406 #2, astra j89d7a94587dc0669 #1): ~51% of job dirs are sonic children. They take 52-59% of card sentences and kind/outcome labels although Home never draws them (src/collectors/job-sentences.ts:257-260, decision-labels.ts:81-91), so the text model sits at its 240/h cap; and they fill the newest-200/64 directory windows (thin-jobs.ts:693, control-radar.ts:139, project-board.ts:284) so Home/Control 'done today' and Project lookups drop most of the day's imp jobs. Skip workers with a parent in sentence/label/recommendation updates; bound the windows by top-level jobs (children follow their parent). Also find why ~84% of job-sentences.json entries have empty text (carbon suspects reasoning_effort sent to the Mistral endpoint or reasoning text not stripped, src/collectors/small-model.ts:218-232) and fix it, with backoff on deterministic 4xx.

- [ ] No sentence/label/recommendation request is made for a job with a parent (unit test)
- [ ] Directory windows count top-level jobs; a day with 300 children still shows every top-level job in Control today and Home
- [ ] Empty-sentence cause identified in the report and fixed; deterministic 4xx backs off
- [ ] Panel cadence/perf unchanged (existing perf tests pass)

## Comments
