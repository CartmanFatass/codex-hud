# P065-BUDGET scheduling and ownership release

Date: 2026-11-03. Fresh read-only scheduling Oracle. Checkpoint: 17:29 UTC.

## Decision

**RELEASE P065-BUDGET as one bounded independent implementation follow-on to the owner-approved wave-1 P-06-5 consultation, on the exact accepted integration image below. Reserve its branch, worktree and file ownership now. Its first mutating/compute work must wait for the current B10B-S3F-NEXT cloud measurement lease to be explicitly returned and reassigned by the dispatcher. Pending owner-run local testing or review is not a prerequisite to this independent implementation.**

This ruling supplies the separate scheduling disposition required by queue-progress and P065-BUDGET §12. It does not release a later queue wave, accept any package, authorize a merge, renew another package's fix rounds, relax a gate, or restart assistant-run local work. Read-only preparation can continue while the existing measurement lease is held. Archival/readback of this ruling and factual reservation records must precede dispatch of implementation.

## 1. Documentary prerequisites are verified

The previous metadata-exception decision is archived at docs/cloud/rulings/p065-metadata-exception.md. The single documentation writer confirmed the eight contract/brief amendments complete at universal-hud 448c58b1f386f72d74b730018a659c6a75068cea. I independently read all eight files and their complete diff against a8cbaf547dd0e9c7b0239fa4498a84baf8224889. That comparison contains only contracts 01–06, concept §15 and P065-BUDGET, with no source/test changes.

Contract 02 contains the three specified paragraphs verbatim: the fixed metadata exception, F07 exclusion, and unsafe/expired/uncertain audit prohibition. Contract 06 contains the exact P-06-5 addition and actual-lock-interval measurement wording, including T-06-14. The narrow cross-references preserve actor/source/writer/capability/profile rules. The brief retains all fourteen deterministic cases, the eleven additional metadata requirements and the complete real-clock matrix. Its resolved §8 does not claim global compliance or permission for arbitrary lock-held I/O.

The remaining status synchronization was then completed and independently read back: STATE at commit d9ea6f1a7b5478406a9547961c6bcd87399bd60a, P-06-5 question at 95fafb0b9b8a6bea921895d9795c4835b2baa3ba, and engineering-plan §1 at 71f14876ab6ff68a4426072f3e135f3f6fd5c3e4. They correctly record the resolved contract fork and the then-pending scheduling release, without implementation acceptance. The owner's local report is recorded as received, not as a green gate. The historical rulings and earlier failed evidence remain intact.

Before final release, universal-hud advanced to 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22 solely to archive docs/cloud/handoff/p065-status-amendments.md. I verified that complete comparison and the current branch/tree. No source, tests, contracts, brief or status content changed. This latest documentation-only integration head is the implementation base pinned below.

The last documentary HOLD is now superseded only to the extent of this scheduling release. The dispatcher may append this release/base/reservation to the current brief and factual status records through one serialized writer; do not rewrite historical consultations or describe the code as implemented, accepted or merged.

## 2. Pinned base and branch reservation

- Repository: CartmanFatass/codex-hud.
- Integration base: universal-hud commit **26f6fba36948e6c96e2e109cb374c0d4dbb9ab22**.
- Base tree: **03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9**.
- New implementation branch: **dots/p065-budget**.
- Dedicated cloud worktree reservation: **/workspace/shared/p065-budget**.
- One implementer, Astra high, owns this implementation. Fresh Astra max Oracles handle design forks, final review and re-checks under the existing dots workflow. The dispatcher records and schedules; it does not supply the accept judgment.

The remote branch was absent and the named worktree path was unoccupied at this review. No branch or worktree was created by this consultation.

I compared the pinned integration base against b42ab16564f5ba7e66bdfd6d06797ddfd5499cda, the source image recorded as locally accepted in STATE. All intervening changes are project instructions/documentation; production, tests, package files and build scripts are unchanged. Thus this is the already integrated source image plus the approved documentary decisions, not an unaccepted package image. This lineage statement is not a new full-check result.

Start from the exact pin. Do not import HYG2, RUNZ1, S3F, PERF, NEXT or B10D code to obtain a pass. A later documentation-only integration descendant may carry this ruling/status record, but must not silently change the implementation's declared base. An intervening source/test change requires revalidation of base, ownership and affected brief assumptions before it is adopted. No force-push, history rewrite or main changes.

## 3. Then-current ownership and active work

Remote heads freshly inspected:

- HYG2: **ce5e6961a0e6de1304dcebb00fc1b8c805573ec6**. It advanced during this consultation from 2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31 only by adding docs/cloud/handoff/hyg2-local-review-20261103.md. The implementation/test diff remains src/ledger/runtime.ts, tests/int/process-client.ts, and tests/unit/{b12d-wal,b12r-store,b16-writer,b45-launch,hud-link-export,process-client}.test.ts. None overlaps P065.
- RUNZ1: **86ca8887fcfb331750ec6dc5518d69134cb795e4**. Its changed production/helpers are src/core/run/process.ts, process-census.ts and README.md; tests are tests/int/runz1-perf.mjs and tests/unit/runz1-fixture.py/runz1-process.test.ts. None overlaps P065.
- B10B-S3F: **bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60**.
- B10B-S3F-PERF: **e5ccee38165b30809bd537e7f31cfed7f227f152**. The complete inherited S3F and PERF production/test changed-path sets were compared, not merely their top-level directories. Neither intersects any of the 43 P065 source/test reservations below.
- Frozen B10D: **4f2c4aced878e5750e66292ed7c552ffb421165d**. Its collector/link/entry/test changes are disjoint but remain unaccepted, outside P065 and unusable as a dependency.

The dispatcher confirmed there are no active HYG2/RUNZ1 implementation workers or additional uncommitted source/test reservations. Their evidence reviews do not reserve new implementation files.

NEXT is the only active source implementation. Its worker reported its ownership and compute lease; I independently read its cloud Git metadata with optional locks disabled. Worktree /workspace/shared/b10b-s3f-next is on dots/b10b-s3f-next, from e5ccee38165b30809bd537e7f31cfed7f227f152, at frozen HEAD **3f2af837b681419cb3461006390c71d2fa9a856f**, tree **4b66dca450ad717455321e2b103dc9b5d190716c**. Its exact committed changes are:

- src/render/delegation/facts.ts
- src/render/delegation/projection.ts
- tests/unit/b10b-s3-facts.test.ts
- tests/unit/b10b-s3-perf-regression.test.ts

There were no untracked paths; the sole dirty item was the unstaged node_modules/.package-lock.json from dependency installation. It remains excluded from all commits. The worker plans no further source/test edits, only reports/evidence. NEXT has no overlap with P065, including the three additional fixture paths.

These are current reservations, not permission to assume future registration, Inspector, B9/B16, B10D, LEG1 or RCP1 ownership is disjoint. Recheck before any newly released work claims one of the same files.

A newly commissioned ancestor-discovery consultation is read-only at this checkpoint. Its proposed bounded paths are packages/hud-mcp/src/process.ts, new tests/hud-mcp/ancestor-discovery.test.ts, and additive tests/hud-mcp/int-ledger-registry.test.ts and skeleton.test.ts. Those four paths do not intersect P065 or NEXT. This observation is not that package's release; any later reservation must preserve strict ProcessReaderPort.get, the exclusion of resolvers.ts/ledger-registry.ts from that proposal, the separate lock-held process-I/O issue, and the same serialized compute rule.

## 4. Exclusive P065 production reservation

Exactly these twenty production paths, only for the purposes in the synchronized brief and metadata ruling:

- src/ledger/call-budget.ts (new)
- src/ledger/transaction.ts
- src/ledger/ledger.ts
- src/ledger/call-context.ts
- src/ledger/intents.ts
- src/ledger/handshake.ts
- src/ledger/reconcile.ts
- src/ledger/local-manager.ts
- packages/hud-mcp/src/server.ts
- packages/hud-mcp/src/resolvers.ts
- packages/hud-mcp/src/hook/resolve.ts
- packages/hud-mcp/src/delegation.ts
- packages/hud-mcp/src/handshake.ts
- packages/hud-mcp/src/read-control.ts
- src/harness/codex/profile.ts
- src/core/launch/brief.ts
- src/core/launch/fingerprint.ts
- src/cli/hud.ts
- src/cli/run.ts
- src/cli/runtime.ts

This is a maximum whitelist, not a requirement to edit every file. In particular local-manager.ts permits the additive original-store binding and bound local revalidation, not a global policy change to existing check(actor?) callers.

Explicitly excluded production remains src/ledger/runtime.ts, src/ledger/supervisor.ts, src/core/run/ledger-port.ts, src/core/run/process.ts, src/core/run/process-census.ts, packages/hud-mcp/src/ledger-registry.ts, and all renderer/collector/link/observation-store/tree-page/capability/hook-producer/command/shared-process-helper code outside the named list. No package/lock/build/test-script changes. A remedy requiring an excluded path stops for a recorded design/ownership revision; it is not an unnamed helper implied by this release.

The startup registry's lock-held process/content reads remain a separate unresolved compliance issue. Its newly exercised ancestor EACCES failure is also outside this package's ownership. Do not delete or move source-authority checks, suppress unrelated warnings, change permissions, or claim whole-repository lock-I/O compliance to close either issue within P065.

## 5. Exclusive P065 test/fixture reservation

Six named new files:

- tests/unit/p065-budget.test.ts
- tests/unit/p065-local-gate.test.ts
- tests/unit/p065-budget-fixture.ts
- tests/hud-mcp/p065-budget.test.ts
- tests/int/p065-budget-benchmark.mjs
- tests/int/p065-ledger-holder.mjs

Fourteen existing files, limited to additive cases or trusted clock/proof dependency plumbing, preserving all existing business/lifecycle assertions:

- tests/unit/ledger-write.test.ts
- tests/unit/b6-cancel.test.ts
- tests/unit/b6-wait-status.test.ts
- tests/unit/b11-cli.test.ts
- tests/unit/b21-capacity.test.ts
- tests/unit/b45-delegation-fixture.ts
- tests/unit/b45-handshake-fixture.ts
- tests/hud-mcp/authorization.test.ts
- tests/hud-mcp/delegation.test.ts
- tests/hud-mcp/resume-expected-run.test.ts
- tests/hud-mcp/handshake.test.ts
- tests/hud-mcp/hook-source.test.ts
- tests/hud-mcp/b20-advice.test.ts
- tests/hud-mcp/handshake-benchmark.test.ts

**Explicitly reserve the three bounded additions allowed by metadata-exception §6:**

- tests/unit/int-ledger-run.test.ts
- tests/unit/b45-parent-offline.test.ts
- tests/int/fixture.mjs

Use those three only when needed for the internal binding API or additive shared-gate regression coverage. Keep new semantic cases in the named p065 files where practical. Preserve existing lifecycle assertions and visibly synthetic low-level fixture boundaries; they do not prove production gate enforcement. No real-process repair, altered expected outcome, arbitrary fixture rewrite or newly permissive production fallback is released.

The existing tests/int/b45-delegation-benchmark.mjs and tests/int/b45-mcp-stdio-benchmark.mjs remain read-only comparators, with original evidence retained. b45-launch, process-client, runz1, visual baselines and benchmark populations outside the whitelist remain unchanged.

The compiled int-ledger-run and b45-parent-offline suites are already included by package.json's required npm test → test:unit → dist-test/tests/unit/*.test.js, and tsconfig.test.json includes their source. Their exact standalone invocation, if needed to establish a stage not reached by the aggregate, is:

`node --test dist-test/tests/unit/int-ledger-run.test.js dist-test/tests/unit/b45-parent-offline.test.js`

Outer timeout: **600 seconds**, with the brief's isolated HOME/HUD_HOME/TMPDIR, explicit runtime and owned-PID cleanup. This does not make a failed/blocked npm test green. Run real-process cases only on an authorized capable executor. The present socket/ptrace/kernel restrictions are not waived; no forbidden wildcard or assistant local-test restart is allowed. Unavailable required coverage remains explicitly unrun/blocked, not replaced by synthetic success.

## 6. Documentation and evidence ownership

All shared documentation remains dispatcher-owned and serialized, never concurrently edited by the P065 implementer and another package. The completed amendment writer has relinquished its write scope; the dispatcher appoints one subsequent recording writer at a time.

The exact shared record set is:

- docs/contracts/01-identity.md
- docs/contracts/02-execution.md
- docs/contracts/03-lifecycle.md
- docs/contracts/04-supervision.md
- docs/contracts/05-capabilities.md
- docs/contracts/06-observation.md
- docs/universal-hud-concept.md
- docs/cloud/P065-BUDGET.md
- docs/handoff/STATE.md
- docs/handoff/questions/P-06-5.md
- docs/universal-hud-engineering-plan.md, §1 factual status only
- docs/cloud/rulings/p065-budget-release.md, this ruling

The contract/concept edits already approved and verified are not reopened by this scheduling decision. Any new substantive contract change needs its own recorded Oracle decision. Preserve p-06-5.md, p065-budget-local-gate.md, p065-metadata-exception.md and other historical reports/rulings unchanged.

The implementer returns its full report and raw artifacts; the dispatcher archives them under the brief's exact docs/cloud/handoff/p065-budget/ paths: implementation.md, checks-<runtime>-<run>.log, samples-<runtime>-<run>.jsonl, summary-<runtime>-<run>.json, negative-controls.md, review-1.md and distinct subsequent authorized fix/re-check records. New scoped design rulings require a separately named P065 ruling and do not silently expand source ownership. Evidence uses synthetic data and is sanitized for this public repository. No prior failed record is overwritten by a successful rerun.

## 7. Compute admission and concurrency

File disjointness permits the independent package slot; it does not permit concurrent measurement load.

NEXT's worker explicitly retains the current cloud lease for its candidate strict series, serial Node 24 diagnostic baseline/candidate pair and remaining checks. It must explicitly release the executor to the dispatcher before P065 starts mutating/compute work. Do not infer release from a quiet process snapshot, a passing run, elapsed time or an unfinished tool call. Already reserved NEXT dispatcher measurements retain their reservation until explicitly rescheduled.

While that lease is held, P065 may read its brief/source and prepare questions only. Defer branch/worktree materialization, dependency installation, source/test edits that generate workload, builds, tests, benchmarks and negative-control execution. After the dispatcher assigns a quiet slot, P065 can begin on its own branch/worktree. It need not wait for NEXT acceptance or merge, which are different gates.

Thereafter serialize agent-controlled builds/tests/benchmarks and other substantial CPU/storage work with every strict measurement series. One isolated measurement workload at a time; no parallel P065 and NEXT/HYG2/RUNZ1 measurement. The required heartbeat, contention and observation-storage load inside a declared P065 experiment is part of that one experiment, not a license for unrelated workloads. Record host/runtime/build identity, UTC boundaries, observable interference and limits of host control. Retain interrupted/contaminated attempts and their reasons rather than selecting a favorable subset. Never terminate unrelated processes.

## 8. Local evidence and unchanged queue

The owner's local report is now present, at local-verification/20261103 commit **9be7246c25b5355845e639116c57150ff79d3117**. It concerns pinned HYG2/RUNZ1/old PERF code, not P065 or the new NEXT candidate. It reports all three README check sets not green.

During this consultation HYG2's local-evidence review was archived at ce5e696. Its verdict remains **fix required**: earlier unit/mjs execution gaps are supplied on that WSL host, but the physical-registration EACCES gate remains red; the Node 22 envproxy-output failures are retained separately. This scheduling ruling does not re-review that package or convert evidence from another source tree into P065 verification. Other local evidence reviews remain separately assigned.

The owner withdrew assistant-run local tests. No desktop/local Claude/Herdr/tmux/logged-in harness/probe/live-home action is authorized here. The dispatcher may convey a concise exact-tree test need when useful and consume owner-supplied evidence; independent cloud work continues meanwhile.

P065 is independent because it implements the approved wave-1 authorization-budget follow-on on already integrated control-plane APIs. It implements no Inspector actions, B9/B16 data fields, collector scheduling/fairness/recapture, LEG1 or RCP1 work. DOC2 and TPD1 still require the actual B10B-S3F merge; Inspector/data and B10D follow their recorded order and separate briefs. Existing package remediation counters remain unchanged.

## 9. Acceptance, stopping conditions and merge

The synchronized brief and metadata-exception ruling remain binding in full. In particular:

- One original preparation-inclusive monotonic 30 ms deadline; cumulative wait/retry/backoff at most 20 ms within it; current busy_timeout=0 and contractual single maximum 10 ms. No later clock reset or metadata allowance.
- Original Ledger/opening binding; only the fixed home/main/WAL/SHM lstat/realpath operation; preserved safety predicates, after-acquisition and after-gate expiry checks, pre-COMMIT check, unsafe-audit suppression and positive local resume/replay support.
- No authority from caller data, timestamps, cache, repinning or SQL ledgerId alone. Current authority precedes canonical replay; fresh admission follows it. Successful late COMMIT preserves durable truth and still fails its performance sample; uncertain COMMIT does not permit redispatch.
- All fourteen semantic cases, eleven metadata precisions, meaningful behavioral negative controls, compiled CLI-to-MCP handoff and preserved shared-writer regressions. Missing-symbol/import failures are not failing-before evidence.
- Every command, timeout, raw-log and complete real-clock population in brief §§9–10 remains. At least 50 warmups and 1,000 measured calls per declared non-wait tool/combination, both H/R profiles, real SQLite/production clock, contention/heartbeat/cold-first-use/load, three isolated series on Node 22 and Node 24, all outcomes/overruns retained. A percentile cannot replace the per-call 30 ms bound.
- Real-Claude joint timing, real-harness/capability and formal supported-platform/B14 qualification stay distinct. No cloud/synthetic result promotes a capability cell.

Stop the dependent portion on changed/overlapping ownership, missing binding or accepted base, an outside-whitelist remedy, an unapproved contract/profile/gate change, denied facilities, missing required populations, or unexplained evidence/source identity. Preserve the branch and exact blocker. A pre-existing or environment-triggered full-suite failure is not permission to hide it, weaken assertions or mark the gate green. Known flakes receive only their prescribed single isolated rerun with both results retained; P065 over-budget samples are not erased by that rule.

One fresh independent final Oracle must verify the exact final branch, report, negative controls, raw checks and complete measured populations and return accept. At most the normal two P065 fix rounds apply, without renewing any other package's allowance. Integration then requires one merger, --no-ff into universal-hud, the complete green README check set on the actual merged tree, permitted flake handling with both logs, and only then push plus factual STATE/plan updates. No main changes, force-push, history rewrite, node_modules staging or unaccepted dependency integration.

**Final disposition: scheduling RELEASE with exact source/test/docs reservations and pinned base; resource admission waits for the existing NEXT lease to be explicitly released. Acceptance, merge and local-only qualification remain HOLD until their independent gates are met. No new owner approval is required merely to carry out this bounded release.**

## Sources and method

- Pinned integration image: https://github.com/CartmanFatass/codex-hud/tree/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22
- Synchronized brief: https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/P065-BUDGET.md
- Metadata decision: https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/rulings/p065-metadata-exception.md
- Queue ruling: https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/rulings/queue-progress-20261103.md
- Current status: https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/handoff/STATE.md
- Documentation amendment comparison: https://github.com/CartmanFatass/codex-hud/compare/a8cbaf547dd0e9c7b0239fa4498a84baf8224889...448c58b1f386f72d74b730018a659c6a75068cea
- Accepted-source lineage comparison: https://github.com/CartmanFatass/codex-hud/compare/b42ab16564f5ba7e66bdfd6d06797ddfd5499cda...26f6fba36948e6c96e2e109cb374c0d4dbb9ab22
- NEXT brief: https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/B10B-S3F-NEXT.md
- Owner-run evidence: https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md
- HYG2 local re-check: https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/docs/cloud/handoff/hyg2-local-review-20261103.md

Method: read-only GitHub files/refs/comparisons, existing reports, dispatcher/active-owner reservation statements and read-only cloud Git metadata with optional locks disabled. No repository or local file writes, branch/worktree creation, build, test, benchmark, probe, permission change, local-machine action or subagent was performed.