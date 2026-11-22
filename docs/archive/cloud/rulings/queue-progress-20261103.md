# Queue progress ruling, 2026-11-03

## Decision

**No next-wave implementation package is ready to start now. Keep the existing wave order and every acceptance/merge gate. Continue the active wave-1 evidence/review work, and start a separate read-only P-06-5 implementation-brief consultation while local verification proceeds.** Read-only prerequisite preparation is permitted; it is not a package release, implementation, acceptance, or permission to integrate an unaccepted branch.

The owner's latest direction removes repeated requests for ordinary execution/design approval and lets Oracles decide the appropriate questions. It does not turn unfinished verification into acceptance, change the explicitly ordered queue, waive an implementation brief, or expand a package's owned files silently. Local-test work can be handed to the owner without making all cloud preparation wait for it.

## Inspected state

Read the latest universal-hud snapshot at 2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e, including STATE, AGENTS, dots workflow, cloud README, engineering-plan brief requirements, DOC2/TPD1/B10B-S3F/PERF/HYG2/RUNZ1 briefs, B10D route and P-06-5 rulings, and the recorded owner decisions. Package heads inspected were:

- dots/b10b-s3f: bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60.
- dots/b10b-s3f-perf: 94969100ec85a41f93eb2a0d677aefc886290691.
- dots/hyg2: 2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31.
- dots/runz1: 86ca8887fcfb331750ec6dc5518d69134cb795e4.

No wave-1 implementation package has an applicable accept verdict or completed green merged-tree gate.

B10B-S3F-PERF's implementation series and dispatcher series are distinct. The implementation candidate had Node 24 compact-changed p99 10.579 / 9.488 / 9.900 ms. The later independent dispatcher series had Node 22 passes in all three runs, but Node 24 compact-changed p99 9.716 / 10.233 / 12.314 ms, with rich-changed p99 12.016 / 13.254 / 15.716 ms. Thus the latest series has repeated compact failures and a rich failure. It cannot be released by invoking STATE's narrow single compact-overrun/isolated-rerun exception. Node 22 results do not close Node 24. The PERF report also says npm test and the separate mjs stage were not run in that remediation worktree; successful focused checks are not a full-green result.

HYG2's previous P2 is fixed, and RUNZ1's review found no new must-fix code defect, but both verdicts remain fix required because full checks are red. The HYG2 topology diagnosis establishes the absent CONFIG_PROC_CHILDREN interface and reproduces the five discovery failures on pinned baseline/current snapshots under both runtimes. It explains the observed failure points; it does not validate the lifecycle behavior the tests never reached. The socket/ptrace restrictions likewise are not passing results.

This is a queue/design consultation, not a second final review of the PERF change. The designated package reviewer must assess the complete submitted diff/evidence and issue the package verdict.

## What cannot start

1. **DOC2 implementation:** its brief explicitly says to do it after B10B-S3F merges, so the s3 rulings are on universal-hud. STATE's shorthand “starts after B10B-S3F” must not be read as “after code was submitted,” “after a benchmark improved,” or “after a branch was pushed.”
2. **TPD1 implementation:** its base is explicitly universal-hud after B10B-S3F merges. Working from the unaccepted S3F/PERF branch, cherry-picking its interfaces, or mocking the missing accepted base would not satisfy that prerequisite. Its disjoint action-dispatch ownership relative to B10D collector wiring does not waive the base requirement.
3. **Wave-3 Inspector or B9/B16 implementation:** these remain behind the ordered wave-2 work and need their own complete Oracle briefs. Missing briefs are a preparation opportunity, not an implicit release. Do not presume an unspecified file set is disjoint.
4. **B10D-2, LEG1, RCP1 or the fairness/retirement implementation:** the route ruling §7 first says to finish B10B-S3F/RUNZ1/HYG2, then DOC2/TPD1 and queued Inspector/data work according to STATE. Its subsequent worker-base update and serial scheduling/accounting work do not authorize jumping that sequence. The recorded broader owner approval removes the old pending-permission question; it does not erase the route's order or separate-brief requirements. In particular, a fairness ticket approval is not an accepted worker or a general recovery-interface waiver. Do not merge universal-hud into b10d-worker as a disguised early implementation step now.
5. **Another automatic PERF fix round:** finish the currently authorized review/disposition. The PERF brief grants one additional remediation submission and review, not a fresh automatic two-round budget. A fresh Oracle may recommend a precisely bounded follow-on under the owner's delegated decisions, but that recommendation must be recorded with its scope and evidence before another remedy begins. This queue ruling grants no extra remediation round.

The same-wave disjoint-file rule is permission for parallelism inside an otherwise ready wave, not permission to bypass order. At minimum the explicit B10B-S3F merge prerequisite already blocks both wave-2 packages; this ruling does not relax the route's finish-wave-1-first sequence.

## Work that can proceed now

- Complete the active wave-1 report verification, evidence reconciliation and prescribed Oracle review/re-check. Do not duplicate an already assigned final reviewer. Retain failures, unrun stages and exact source identities. Review incoming local evidence when available; do not label it verified before checking it.
- Prepare a bounded P-06-5 follow-on brief in a fresh read-only architecture consultation. The prior ruling expressly requires such a brief after the owner's scope decision, and the decision is recorded as approved. Brief preparation does not modify shared ledger code, expand HYG2, or consume a later wave's implementation slot.
- If useful after that, prepare DOC2's prerequisite read-only rulings on factsEqual/new Function and cold-tick treatment, and build source/ruling/test maps for DOC2/TPD1. Preserve existing gates. Any proposed new cold-tick gate must be explicitly separated as a proposed change, not written into acceptance as already granted.
- Read-only draft briefs for later Inspector/data/LEG1/RCP1 work may inventory dependencies and ownership, but must be marked conditional and revalidated against their eventual accepted base. They do not release implementation or reorder the queue.
- The dispatcher may archive these returned texts and update factual status under its existing recording role, preserving earlier evidence and serializing shared status/design-document edits. Recording a draft does not make its proposed implementation eligible.

**No cloud-only, unqueued production-code task is ready to launch merely because its files appear unrelated.** P-06-5 is the concrete candidate for an independent follow-on, but its code work crosses B1/B4/B5/B6/B11 and shared-ledger ownership. It needs the mandated bounded brief and a separately recorded Oracle scheduling/ownership disposition first. “Cloud-only” changes neither these requirements nor the eventual full-check and merged-tree gates. It is not necessary to ask the owner again merely to obtain this read-only brief.

## Exact next assignment

Commission one fresh read-only Oracle to return **P065-BUDGET: preparation-inclusive authorization budget**, as text intended for docs/cloud/P065-BUDGET.md. Do not implement or run tests during that consultation.

Inputs: the pinned current universal-hud tree, approved P-06-5 question and verbatim ruling, F08, contracts 02/05/06, the engineering plan's complete-brief requirements, actual MCP source/authorization/preparation/transaction/local-resume call paths, and current ownership for B10B-S3F-PERF, HYG2, RUNZ1 and the queued data/B10D work.

The deliverable must:

1. Give exact source base, concrete goal, bounded output paths and complete allowed-file whitelist, including documentation and tests. Compare the whitelist with active package ownership; do not claim broad directory disjointness without inspecting actual files. Treat shared design/status files as dispatcher-serialized records.
2. Preserve the original preparation-inclusive absolute 30 ms deadline, single busy timeout at most 10 ms and cumulative waits/retries/backoff at most 20 ms within it. Cover queued expiry, final admission/commit checks, cumulative accounting, local-resume timing and truthful handling of an already-committed late result. Preserve the separate MCP/hook/wait boundaries.
3. Resolve the local-gate filesystem-I/O-inside-transaction conflict without deleting identity/replacement protection or granting authority from stale evidence. If no bounded safe design is established, return that exact design blocker rather than a permissive placeholder.
4. Specify deterministic correctness tests and separate production-clock qualification, meaningful failing-before assertions, exact check commands, expected state assertions, per-command timeouts, evidence locations, role hierarchy and stop conditions. Preserve the full README check set and all prior failures. Identify local-only qualification separately.
5. Return a distinct **release disposition**: either an explicitly bounded independent follow-on can be scheduled without changing existing wave order or active ownership, or it must wait for named prerequisites. If independent implementation is recommended, explain why it is not an early execution of queued B9/B16/B10D work and record the proposed slot; do not silently start it.

Stop at a complete textual brief/disposition, or at the exact unresolved dependency/design question. No source changes, new branch, tests, capability changes, gate relaxation or package acceptance are authorized by this assignment. The dispatcher should save the brief and disposition, then act only on the ready scope they actually establish.

## Unchanged stop and merge conditions

Any dependent implementation stops if its required accepted base is absent, its exact file ownership overlaps another active package, its complete brief is missing, or its remedy changes a gate/contract/profile beyond the explicitly recorded decision. Preserve the blocked package and move to allowed preparation rather than inventing a pass or a new queue order.

Acceptance still needs the prescribed Oracle verdict and verified report. Integration still needs --no-ff, a complete green check set on the merged tree with the permitted known-flake handling and both logs retained, then push and STATE/plan updates. Never touch main, force-push, rewrite history, stage node_modules/.package-lock.json, simulate local-only work, or treat unexplored local results as qualification. No gate or supported profile changes in this ruling.

## Sources

- STATE and queue: https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/handoff/STATE.md#L104-L139
- Workflow: https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/cloud/dots.md#L24-L43
- DOC2 prerequisite: https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/cloud/DOC2.md#L5-L30
- TPD1 prerequisite: https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/cloud/TPD1.md#L5-L11
- B10D route order: https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/cloud/rulings/b10d-route.md#L225-L238
- P-06-5 approved follow-on: https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/handoff/questions/P-06-5.md ; https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/cloud/rulings/p-06-5.md#L58-L127
- Complete-brief requirements: https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/universal-hud-engineering-plan.md#L58
- PERF evidence: https://github.com/CartmanFatass/codex-hud/blob/94969100ec85a41f93eb2a0d677aefc886290691/docs/cloud/handoff/b10b-s3f-perf-dispatcher-20261103.log
- PERF review/round/dependency limits: https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/cloud/B10B-S3F-PERF.md#L130-L137
- HYG2 diagnosis: https://github.com/CartmanFatass/codex-hud/blob/2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31/docs/cloud/handoff/hyg2-topology-diagnosis.md
- RUNZ1 review: https://github.com/CartmanFatass/codex-hud/blob/86ca8887fcfb331750ec6dc5518d69134cb795e4/docs/cloud/handoff/runz1-review-1.md

Consultation method: read-only GitHub metadata/files and existing evidence. No repository writes, git mutations, tests, builds, probes or subagents.