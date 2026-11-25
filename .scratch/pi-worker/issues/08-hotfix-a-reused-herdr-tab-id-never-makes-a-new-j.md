# 08: Hotfix: a reused herdr tab ID never makes a new job look closed

**Status:** done
**Owner try:** no
**Blocked by:** none
**Objective:** pi-worker

**What to build:** Observed 2026-11-25 20:33: fresh imp job j6daafb3598870be7 (pi) launched into herdr tab `w5M:t10` and the owner got `failed | tab closed` at once; the job kept working because pi then wrote its own STATUS. herdr reuses tab IDs (current tabs t1M..t1Y then t10). The watcher's `closedTabs` set (`src/runtime/watch-runtime.ts` ~L145, `rememberClosedTab`, `openRuntime().tab`, and the handoff `start(state, tabs)`) keeps an old close of `w5M:t10`, and `tabClosed = closedTabs.has(tab)` (~L679) then matches the new job's SESSION; with no pi pid yet the branch at ~L770 writes `failed / tab closed`. CLI jobs take the ~L705 path with the same stale fact and may be judged terminal; the reap path (~L483) also consults `closedTabs`. Fix the fact, not the symptom: a close counts for a job only if it happened after that job's tab receipt was created (e.g. close events carry a sequence/time and are compared with the launch receipt, or claiming a tab in a new receipt retires that ID from `closedTabs` in every watcher generation including the handoff). Cover pi fresh launch, CLI fresh launch, resume into a reused ID, and a real close after launch still failing the job. Process-safety rules from pi-worker/03 stay as they are (exact PID+start, verified shell identity).

- [x] A close event for a tab ID recorded before a job's launch receipt never marks that job failed, for pi and CLI fresh launches and for resume
- [x] A close of the job's own tab after launch still fails it and wakes main
- [x] The watcher handoff (reload) cannot resurrect a stale close for a reused ID
- [x] Tests reproduce the reused-ID case first (red before the fix)
- [x] Land gate passes

## Comments

- Accepted residuals (known liveness gaps until `herdr-fork/03-04`):
  - Receipts with an unmatched or missing `HERDR_SOCKET_PATH` endpoint are skipped by tab/pane probes.
  - A pane ID reused across a Herdr restart answers present to `pane.get`.

- Landed in this commit (replay base 7585ff0f946ff02cb05981028220d3eb2241788a); gate 5/5 passed.
