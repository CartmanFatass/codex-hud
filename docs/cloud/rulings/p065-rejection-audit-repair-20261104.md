# P065 rejection-audit repair: scoped ownership and implementation ruling

Date: 2026-11-04 UTC. Fresh read-only Oracle. Repository: CartmanFatass/codex-hud.

## Decision

**Release one narrow P065/core-ledger continuation, not a NEXT repair. Extend P065 ownership to the existing process test and its child, reuse the already implemented trusted CallBudget seam, preserve the exact positive audit assertion, and add deterministic rejection-audit boundary tests. Correct the one P065 catch-path error-priority defect identified below.**

The minimum source/test delta is exactly four paths: `src/ledger/intents.ts`, `tests/unit/ledger-processes.test.ts`, `tests/ledger/process.mjs`, and new `tests/unit/p065-rejection-audit.test.ts`. Existing P065 fixture, clock, ledger and transaction APIs suffice; do not create another production timing API or change NEXT rendering. This is a specific exception to P065's exclusion of unrelated suite repairs, limited to this inherited audit assertion and the same optional-audit semantics.

This ruling releases the bounded design and ownership amendment. It is not a compute lease, permission to install the missing formatter, a capability grant, an acceptance verdict, or a merge. Record it and assign a separate bounded implementation/verification window before execution. The pending V3 check-only formatter operation remains separate.

## 1. Verified basis and identities

Read the complete supplied `next-audit-classification.md`, the binding remote guide and workflow, current STATE, P065's scope/audit/timing/acceptance clauses, contract 02, the scheduling/resource and replay/expiry rulings, relevant NEXT and P065 source, and the latest P065 C1–C4/V2 re-check. Inspected source includes both process fixtures, the whole multiprocess test, P065's actual clock/transaction paths, and its existing relevant semantic tests. No new execution was used to classify source behavior.

- Governing integration/docs: `universal-hud@f248f320d42528fd1eb97db9f1cd2ba97e6d3c86`.
- NEXT branch: `dots/b10b-s3f-next@60b5959d02516e73d30cd5a55913eb6988a94ea9`; original tested candidate remains `0cca9caa6ddf3249291c8ed85a41da1eed800ee4`.
- Selected continuation branch: **`dots/p065-budget`**, existing P065 owner and reservation.
- Exact continuation preimage: **`0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f`**, tree **`71084b30e093da8815804a79d0ffd6eec671668e`**.
- P065's accepted integration base stays **`26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`**. GitHub comparison confirms this is the merge base and the selected continuation is its descendant. The current P065 branch is WIP, not an accepted substitute base for another package.
- The dispatcher confirmed during this consultation that no P065 writer is in flight, the last verified head is `0008ff04`, and V3 formatter tooling awaits user approval. Recheck those facts at actual admission.

The process test and two fixture blobs on P065 still equal the NEXT blobs: `ledger-processes.test.ts` `9fdc8aae22bc10b75e6269f5449649cba01acd41`; `process.mjs` `dab982a0ba50ed2c477bc527f839e2b992b44808`; `fixtures.mjs` `eac992eb5616a029bae504e809ccc1b2d32be989`. P065 already supplies `call-budget.ts` blob `d1105587414ce63e66d924f3725b24237766022f` and the reusable `TestBudgetClock`/`budgetFixture` in `p065-budget-fixture.ts` blob `4264874ef20ebbae2fabe80fe505785c8a89c191`.

## 2. Classification and the additional P065 defect

Retain the supplied classification: NEXT's `0 !== 1` rejection-event assertion is an inherited test/clock-contract mismatch, P2, not a new NEXT ledger-code regression. The exact historical route, expired outer audit guard versus swallowed audit-transaction error, remains unobserved. Neither the subsequent core pass nor a future repaired pass changes the original failed aggregate.

The current contract 02:95–97 and P065 §5 explicitly make this audit conditional. A failed intent rolls back first. No audit starts after the original budget is exhausted, store proof fails, or COMMIT truth is uncertain. The primary refusal and previously durable facts remain authoritative. An eligible audit uses only the original remaining budget.

**Additional scoped finding:** `src/ledger/intents.ts:457` on `0008ff04` calls `budget?.check('complete')` from the catch before returning/rethrowing the primary result. If the real conflicting-intent callback has already thrown `idempotency_conflict`, then rollback reaches the original deadline, this call throws `CallBudgetExpired` and replaces the conflict with `ledger_busy`. It occurs before the conditional audit guard. The numeric path used by historical NEXT has no such extra catch check. This is a distinct P065 candidate issue, not evidence explaining NEXT's historical log. **P2; fix within the already P065-owned catch path.**

Selected semantics: after mandatory cleanup establishes a primary business refusal, elapsed time may prevent optional auditing but must not rewrite that refusal. A genuine budget refusal raised before protected admission or pre-COMMIT remains a budget refusal. An uncertain COMMIT or cleanup failure retains its own unsafe classification. This does not allow a body to run after expiry, preserve a newly accepted uncommitted result, or convert uncertainty into clean nonacceptance.

Use non-enforcing, failure-safe completion observation if needed; do not remove or weaken the actual transaction admission/acquisition/callback/pre-COMMIT checks. Audit-eligibility observation and optional audit failure must not replace the established primary error. Preserve existing capacity-result behavior, authorization exclusions, unsafe-audit exclusions and numeric-API behavior. No public error taxonomy change is authorized.

## 3. Exact ownership delta

The continuation may change only these four source/test files for this repair:

1. **`src/ledger/intents.ts`**: only catch-path preservation of the primary result and safe optional-audit eligibility/completion handling described above. No normalization/digest/authority/replay/admission reordering or other transaction changes.
2. **`tests/unit/ledger-processes.test.ts`**: compose trusted deterministic timing for the existing concurrent-different-parameters audit-positive case and any strictly necessary child protocol typing. Retain its name or make the eligible-budget purpose explicit. Keep exactly one fulfilled result, exactly one `idempotency_conflict`, the original exact-one `intent.rejected` assertion, accepted-run association, all complete-state/integrity assertions, and real concurrent child execution.
3. **`tests/ledger/process.mjs`**: a visibly test-only way for that selected case to construct/pass the existing trusted budget in each child. Import the existing compiled `TestBudgetClock` helper or directly compose the existing `CallBudget` interface. Keep all real ledger SQL and request preparation. No production flag, environment switch, public request field, global clock patch or fault hook is added.
4. **New `tests/unit/p065-rejection-audit.test.ts`**: the bounded deterministic SQLite tests and controls in §5. Reuse existing `budgetFixture`, `TestBudgetClock` and synthetic intent fixtures read-only. A separate file deliberately avoids modifying the already reviewed C1–C4 two-file repair while its exact-source V3 formatting check remains pending.

**Read-only for this continuation:** `tests/ledger/fixtures.mjs`; `tests/unit/p065-budget-fixture.ts`; `tests/unit/p065-budget.test.ts`; `src/ledger/call-budget.ts`, `ledger.ts`, `transaction.ts`, `local-manager.ts`; and every other production/test path. The reusable fixture's prepared inputs and existing clock are sufficient. Do not broaden to these files merely for refactoring, formatting or convenience. Return a precise design/ownership question if the named four-file solution proves insufficient.

This adds three paths to P065's original whitelist: the two existing process-test paths and the new audit test. `intents.ts` was already reserved. It grants no NEXT, HYG2, RUNZ1, NODE22-PROXY, MCP-ANCESTOR, B10D, tree-page, renderer, collector, shared process-helper, build-script, package/lock or visual-baseline ownership.

The dispatcher may serialize this ruling at `docs/cloud/rulings/p065-rejection-audit-repair-20261104.md`, append the exact limited ownership/case addition to `docs/cloud/P065-BUDGET.md`, and record factual status. Reports/raw evidence belong under a new `docs/cloud/handoff/p065-budget/rejection-audit/` directory. Those are dispatcher records, not extra implementer source ownership. Preserve earlier reports, specifications and failures verbatim; contract 02 already states the chosen rule and needs no normative rewrite.

## 4. Branch, reservation and dependency handling

Continue the existing P065 branch with its same implementer, not a second independent core owner. Use its reserved source worktree only after a collision/ownership check and explicit admission. Do not overwrite or repurpose the frozen `/workspace/p065-repaired-verify` verification checkout, an uncertain old worktree, or another agent's resources. Materializing a missing source checkout also requires the assigned resource window.

Freeze `0008ff04` as the before image and record the new commit/tree after the scoped change. A later documentation-only descendant may be used only after recording a tree comparison proving the relevant source/configuration bytes unchanged. Intervening source/test edits, a concurrent writer, unexplained generated/dependency changes or a different dependency branch require reconciliation before mutation. No history rewrite, force push, `main` write or dependency-state staging.

V3 remains a check of its pinned earlier repair, not a check of this future change. Preserve C1–C4/V1/V2 findings and raw evidence without repeating them merely for bookkeeping. This new defect and source delta justify their own focused verification. They neither invalidate the historical passes nor make those passes cover the new `intents.ts` bytes. The pending formatter approval may remain pending while separately admitted source work proceeds; this ruling does not grant that installation/run or permit a substitute formatter. The new final candidate still needs applicable formatting and all package gates.

**Dependency consequence:** there is no honest test-only patch on the unchanged NEXT tree using P065's absent clock API. Do not cherry-pick these tests, import unaccepted P065 code, copy its clock subsystem into NEXT, or enlarge NEXT's four-file scope. This selected shortest route fixes the inherited test in its actual core/ledger timing owner. It does not by itself clear NEXT's old-tree full-check failure. A consuming NEXT/integration candidate can claim the remedy only after the P065 dependency has its applicable full acceptance and the combination is separately authorized, source-identified and checked through normal history-preserving integration. Current composite/NEXT evidence is immutable and cannot be relabeled as evidence for that new combination.

An independent minimal-seam extraction onto accepted integration would be a different production package with overlapping ownership and its own review. It is **not** released here as a fallback shortcut. Do not waive the P065 gate or manufacture a combined WIP tree to avoid its outstanding qualification.

## 5. Required behavior and tests

### A. Existing positive concurrent case stays real

- Two owned OS children must be ready and both first requests sent before either result is awaited, as today. Both use the same real SQLite ledger and normal authorization, canonical digest/key lookup and transactions.
- Construct a new trusted budget for each actual test invocation inside that child, before `acceptIntent` normalization. Pass that same object through all transactions and its optional audit. Semantic time does not advance merely because the host schedules a child slowly; intentional logical waits/advances remain explicit.
- Preserve the existing at-most-one caller retry only for an explicit initial `ledger_busy` after the competitor responds. A separate authorized request retry can have its own original call budget; there is no audit retry or same-call budget reset. Do not retry a conflict, poll until an audit appears or allow a busy result as the final expected conflict.
- Keep exact-one accepted state and exact-one rejection event. Check the rejection payload key/reason and null link/run attribution, preferably in the dedicated deterministic positive case as well.
- Other process tests, SIGKILL cuts, reconcile contention, real-clock waits and child cleanup remain unchanged. Teardown must still reap every owned child before removing temporary homes. Do not convert the suite to a single-process or mocked acceptance test.

### B. Deterministic real-SQLite audit cases

Use a real accepted winner and a fresh, conflicting input with the same canonical key/different normalized digest. Snapshot the complete accepted link/run/claim/slot/idempotency and accepted-event facts. Test instrumentation may observe/wrap only the fixture's actual transaction/SQL operations; it must call through and must not manufacture the conflict result or substitute an in-memory ledger.

1. **Eligible audit:** real conflicting transaction rolls back; sufficient original budget remains; exactly one distinct audit transaction commits exactly one correctly attributed rejection. Assert rollback-before-audit ordering, no partial losing intent, unchanged complete winner and integrity/foreign keys.
2. **Boundary after known refusal:** advance the trusted clock only after the real conflict rollback, with elapsed values just below 30, exactly 30, and just above 30 ms. Below the boundary, require the exact positive audit. At/after it, require the original `idempotency_conflict`, no newly scheduled audit transaction, zero new rejection rows and unchanged accepted state. Where possible capture the actual callback-thrown error and assert identity, not merely a broad regex that also permits busy. The current catch check must fail these expired-conflict cases before repair.
3. **Expired before protected admission:** pass an already expired original budget to a new intent. Require actual budget refusal, zero protected callback/admission, no new accepted rows, no optional audit. This guards against accidentally disabling real admission checks to preserve business errors.
4. **Audit expires while queued:** enter the optional audit while still eligible, then deterministically exhaust the same budget before its actual acquisition. Distinguish queued transaction invocation from a successful `BEGIN IMMEDIATE`: the queued audit must not enter its callback or commit. The original conflict remains primary and accepted state unchanged. No fresh 30 ms or 20 ms account is allocated.
5. **Audit fails with budget still available:** use an actual SQLite failure confined to inserting `intent.rejected`, such as a fixture-only trigger that aborts that insertion. Prove an eligible separate audit was attempted, rolled back and created no rejection row; the original conflict survives, winner rows stay unchanged and integrity passes. Do not simulate audit failure merely by rejecting a fake `acceptIntent` call. A known rolled-back audit is the zero-row case; do not incorrectly demand zero rows from an acknowledged-lost COMMIT that may actually have committed.
6. **Budget identity and exclusions:** observe that the conflict and eligible audit receive the identical original budget and retain spent wait accounting. Preserve the existing cumulative-wait, local-proof failure, uncertain-COMMIT, cleanup-isolation, late-success, canonical-replay and capacity/security tests. No audit is allowed on those unsafe cases, and no second acceptance/launch is introduced. If a new wait-account control is added, charge actual fixture contention/backoff, not relabel callback time as proven lock wait.

Use temporary HOME/HUD_HOME/TMPDIR and synthetic data. Restore fixture hooks in finally/test cleanup. Serialise tests that alter a shared prototype. In-process real SQLite suffices for B; the multiprocess positive case in A is mandatory and cannot be replaced by B.

### C. Meaningful controls

- First run the new expired-after-conflict tests against the selected P065 before image, or restore only its catch `check('complete')` in an isolated negative-control tree. It must fail because it returns busy instead of the established conflict, not because an import/export is missing.
- An isolated behavior mutation suppressing eligible audit insertion must fail the retained exact-one positive assertion. Do not delete/weaken the assertion in the candidate.
- Removing the expiry audit-admission condition in an isolated control must fail the no-new-audit-attempt expectation, even if the deeper transaction guard still prevents a SQLite write.
- Letting the eligible audit error escape in a control must fail the original-error preservation assertion.

Each control has a declared mutation, expected failing assertion, actual exit/output and restored final-source identity. Controls are not production changes and never run on the integration branch. A compiler/import failure is not a useful behavioral control. These controls add no performance qualification claim.

## 6. Scoped verification and existing gates

No command was run by this consultation. After a separately assigned quiet window, use fresh compiled outputs from the exact remedied source, explicit supported Node identity, temporary homes, retained stdout/stderr/status/UTC boundaries and owned-child cleanup. Existing denials, unknown historical process outcomes and local-testing withdrawal remain binding.

Minimum new focused group, once on each supported Node family under separately assigned windows:

1. `npm run build`, `npm run build:test`, `npm run build:hud-mcp`, each with the existing P065 180-second outer cap.
2. `node --test dist-test/tests/unit/ledger-processes.test.js dist-test/tests/unit/ledger-write.test.js dist-test/tests/unit/p065-rejection-audit.test.js`, 300-second outer cap; all actual child/SQLite behavior must execute.
3. `node --test dist-test/tests/unit/p065-budget.test.js dist-test/tests/unit/p065-local-gate.test.js`, existing 300-second cap, because the changed catch path shares their expiry, uncertainty and proof boundaries. This is regression validation of changed production source, not repetition to reconfirm C1–C4.
4. `node --test packages/hud-mcp/dist/tests/hud-mcp/p065-budget.test.js`, existing 300-second cap, plus affected existing P065 authorization/delegation/replay/capacity regressions from the brief. Keep the external error mapping and business results unchanged.
5. The declared behavioral negative controls, with the corresponding focused command and cap. Fresh-build changed control source; record candidate restoration and hashes afterward.
6. Check formatting of the four changed paths with the exact approved formatter once available, without broad unrelated rewrites; `git diff --check` must inspect the actual committed repair delta as well as any pending delta. The required whole-package `format:check` is not replaced by the focused check.

Then preserve the complete README/P065 required check inventory on the exact final candidate: three builds, full `npm test` including its mjs stage, core, visual, hud-mcp, format, fixtures and actual diff hygiene, plus all P065-specific obligations. The existing P065 brief gives command timeouts. If an aggregate would knowingly repeat an unchanged denied socket/ptrace operation, leave that stage blocked/unrun and name the precise blocker; finish independent allowed groups. Do not skip or alter tests, retry the denied operation, move executors to evade it or call a focused pass a green aggregate. Obtain separately authorized exact-tree capable-executor/owner evidence where necessary.

Only README-listed flakes receive the prescribed one isolated rerun with both results preserved. The original missing `intent.rejected` assertion is not silently added to that list. A later focused pass never changes an earlier aggregate's exit status.

This repair introduces no new B10B strict/performance series or general full-suite timing matrix. **It also waives none of P065's existing complete real-clock qualification:** original preparation-inclusive 30 ms, cumulative 20 ms wait, busy_timeout=0, actual outcomes/overruns, Node 22 >=22.13 and Node 24 populations, required samples/series and separate local-only qualification remain. Deterministic clock evidence proves semantics only.

Return the lease after the assigned group and authoritative owned-process cleanup, including on failure. Review waiting and pending formatter/user input do not retain the compute lease. No installation, launcher redesign, process probe, new capability test or revival of old uncertain sessions is bundled into this ruling.

## 7. Review, acceptance and stopping rules

The implementer returns the exact before/after identities, four-file delta, test/control names and outputs, unchanged-assertion evidence, child/SQL cleanup results, check inventory and remaining blockers. A fresh Oracle reviews this changed behavior and its evidence, without reopening the accepted C1–C4 construction details unless actually affected.

A scoped verdict may close this P2 repair after source and focused evidence establish it. It is not P065 package acceptance and not NEXT acceptance. Full P065 acceptance still needs its complete prescribed final review, semantic/security checks, full gate and qualification. Existing package fix-round counters are not reset. Integration continues only through the existing authorized one-merger, `--no-ff`, green-full-merged-tree rule. Publication alone never means acceptance.

Stop the dependent action on a source/ownership collision; any path outside the four-file whitelist; a needed production clock/transaction API change; an unapproved formatter/setup need; denied or uncertain process action; loss of real child/SQLite coverage; a proposed budget, authority, profile or contract relaxation; or missing exact-target verification. Preserve the completed work and report the precise blocker. Do not fix unrelated suite failures under this exception.

**Disposition: bounded P065 repair scope approved; execution awaits explicit dispatcher window; formatter setup remains separately pending; package acceptance, NEXT consumption, qualification and merge remain held by their existing gates.**

## Pinned sources

- [Binding AGENTS](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/AGENTS.md), [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/dots.md), [README checks](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/README.md).
- [P065 brief](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/P065-BUDGET.md#L44-L102), [audit and clock clauses](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/P065-BUDGET.md#L155-L201), [contract 02](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/contracts/02-execution.md#L95-L97).
- [P065 catch finding](https://github.com/CartmanFatass/codex-hud/blob/0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f/src/ledger/intents.ts#L455-L493), [existing clock](https://github.com/CartmanFatass/codex-hud/blob/0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f/src/ledger/call-budget.ts), [trusted test fixture](https://github.com/CartmanFatass/codex-hud/blob/0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f/tests/unit/p065-budget-fixture.ts#L11-L55).
- [NEXT process assertion](https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/tests/unit/ledger-processes.test.ts#L123-L185), [real child](https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/tests/ledger/process.mjs), [NEXT numeric audit](https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/ledger/intents.ts#L445-L468).
- [P065 lineage/delta](https://github.com/CartmanFatass/codex-hud/compare/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22...0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f), [latest C1–C4/V2 re-check and V3 boundary](https://github.com/CartmanFatass/codex-hud/blob/0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f/docs/cloud/handoff/p065-compile-fixture-v2-oracle-recheck-20261104.md).
- [P065 release](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/rulings/p065-budget-release.md), [resource windows](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/rulings/wave1-resource-windows-20261103.md), [replay/expiry/uncertainty ruling](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/rulings/p065-replay-expiry-clock.md).

Method: read-only GitHub/source/evidence inspection and the supplied classification, with only this requested standalone ruling written. No tests, builds, benchmarks, dependency setup, process probes, source changes, branch creation, repository writes or subagents were performed. The interrupted read-only retrieval had no mutating action or uncertain write outcome.
