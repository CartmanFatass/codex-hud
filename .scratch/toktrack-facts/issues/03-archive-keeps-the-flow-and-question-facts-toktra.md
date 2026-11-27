# 03: Archive keeps the flow and question facts toktrack reads

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Spec `docs/spec.md` §2.3 (evidence beyond the current run; D-2026-11-23-01). Job and flow directories expire after 24 hours (`src/runtime/work-retention.ts:58-105`, `watch-runtime.ts:806-818`), but the archive line misses facts toktrack's HUD pages read. In `src/roles/job-land.ts:60-63` and `src/roles/job-archive.ts:87-100`, add: the land flow's `created_at` and per-step outcomes, including flaky-rerun command names (toktrack `workflow.rs:196,213`, `facts.rs:112`); the job's `dispatcher` when known (`facts.rs:215`); `output_written`; and per-question asked/answered times (`workflow.rs:285`). Additive fields only, no report text. Details: `~/projects/MyHUD/tmp/tasks/spec-pivot/review-carbon.md` §2 item 5.

- [x] Unit test: an archived line for a landed job with a flaky rerun and one answered question carries flow `created_at`, step outcomes with the flaky command name, `output_written` and the question times
- [x] Older archive lines without these fields still parse (existing archive tests)
- [x] docs/reference.md (EN/ZH) describes the new archive fields; `npm test` passes

## Comments

- Landed in this commit (replay base 199f20a061343d6efd7aaa4a97a2aa6081cbe57e); gate 5/5 passed.
