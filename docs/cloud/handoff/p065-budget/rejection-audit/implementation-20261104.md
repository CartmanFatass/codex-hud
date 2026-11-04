# P065 rejection-audit repair: implementation candidate

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud. Branch: dots/p065-budget.

**WIP source candidate only. NOT TESTED, NOT ACCEPTED, NOT MERGEABLE, NOT PERFORMANCE-QUALIFIED.** This connector-only implementation window does not authorize or report any build, test, behavioral-control, formatter, benchmark, installation or local-only workload. Publication is not acceptance.

## Authority and immutable identities

Implemented the supplied bounded rejection-audit ruling, SHA-256 `e029ad23dfcd4fbe77b6520fad5a3f16bd798300ca750cea6ead077d91db2883`. Its exact four-file source ownership, unchanged security/timing gates and separately scheduled verification requirements remain binding.

- Frozen before commit: `0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f`.
- Frozen before tree: `71084b30e093da8815804a79d0ffd6eec671668e`.
- Source candidate commit: `3435589ef253159948c94eaae111606191bd4e3d`.
- Source candidate tree: `27d8c69594fefe83332cec00c346cc8fcf664159`.
- Source candidate has the frozen before image as its sole parent. The archival commit containing this report is a documentation-only descendant.
- Accepted integration base remains `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`; this WIP continuation is not an accepted dependency for NEXT.

The branch was read twice before object creation and remained exactly at the frozen before image. Publication uses a normal non-force ref update with that exact expected head. A changed head, denied action or uncertain write must stop publication rather than invite a blind retry.

## Four-file delta

GitHub's immutable before/source comparison reports exactly four files, 367 additions and 18 deletions:

1. `src/ledger/intents.ts`: 21 additions / 15 deletions, confined to the catch path. Replace enforcing completion with failure-safe `note('complete')`. Preserve the established primary error through optional eligibility observation and the separate audit transaction. Retain the original budget, capacity-result handling, unsafe/proof/uncertain/cleanup/busy/authorization exclusions and numeric deadline path. No normalization, digest, authorization, replay, admission or transaction-order change.
2. `tests/unit/ledger-processes.test.ts`: 2 additions / 2 deletions. Only the two requests in the existing different-parameter concurrent case select `auditBudget: 'deterministic'` on the private test-child protocol.
3. `tests/ledger/process.mjs`: 5 additions / 1 deletion. Import the existing compiled TestBudgetClock helper; construct one new trusted budget per selected invocation before preparation and normalization; pass it to acceptIntent. Ordinary requests still pass undefined and use the existing default numeric behavior. A separately authorized caller retry obtains a new invocation budget; audit never obtains a fresh one.
4. `tests/unit/p065-rejection-audit.test.ts`: 339 new lines. Eight deterministic cases execute real SQLite and production acceptIntent, using unchanged reusable synthetic fixtures.

Immutable changed blobs:
- `src/ledger/intents.ts`: `422870d6c487b43e23636b0bb1d40062f1ec434d`
- `tests/unit/ledger-processes.test.ts`: `0c32f4964605f213c25c7883716c29548f9046b0`
- `tests/ledger/process.mjs`: `e7c0e0ea61452c7c34427ed660a2e4f70e3675be`
- `tests/unit/p065-rejection-audit.test.ts`: `6a1ffb4729b0788ea6d0e2683f0faca5477a137c`

The complete returned content of all four source files was compared byte-for-byte in memory with the submitted content and matched. This is source readback, not compilation or runtime validation.

## Preserved assertions and coverage

The process-test file returns exactly to its original bytes when only the two added `, auditBudget: 'deterministic'` fields are removed. Thus all original assertions and all other cases are retained verbatim:

- Both ready OS children receive their first requests before either response is awaited.
- Exactly one fulfilled result and exactly one rejected idempotency_conflict.
- Exactly one intent.rejected event, complete link/run/claim/slot/idempotency/accepted-event state, accepted-run association, SQLite integrity and foreign keys.
- At most one caller retry, only after an initial explicit ledger_busy and after the competitor has responded.
- All SIGKILL cuts, reconcile contention, real-clock waits and owned-child reaping before temporary-home removal are unchanged.

The new deterministic positive cases additionally assert exact rejection requestKey/reason, null link/run attribution and event time. Complete winner snapshots contain every column of every link/run/claim/slot/idempotency row and all accepted-event rows, so losing state cannot be hidden by count-only assertions.

C1–C4 files were fetched again from the source commit and matched their original complete contents:
- `tests/unit/p065-budget-fixture.ts`: `4264874ef20ebbae2fabe80fe505785c8a89c191`.
- `tests/unit/p065-budget.test.ts`: `7c0d9b190c684509002dd8646d751828f5ec8fb0`.

The exact four-file comparison also preserves call-budget.ts, ledger.ts, transaction.ts, local-manager.ts, fixtures.mjs, all other source/configuration/dependency files and prior reports. Existing cumulative-wait, local-proof, uncertain-COMMIT, cleanup-isolation, late-success, replay, capacity and security cases remain untouched. Historical C1–C4/V1/V2 findings are not evidence for the changed intents.ts bytes, and pending V3 remains its own earlier-source formatter check.

## Authored real-SQLite cases

All eight cases are authored, NOT RUN:

1–3. `P065 rejection audit: conflict rollback at 29.999 ms preserves the original refusal`, and the same name at `30` and `30.001` ms. Advance the trusted clock only after the actual conflict ROLLBACK succeeds. Capture the actual callback error and require object identity and exact idempotency_conflict. Below 30, require a distinct audit BEGIN/callback/COMMIT after rollback and exactly one correctly attributed event. At/above 30, require no second transaction invocation and zero rejection rows.
4. `P065 rejection audit: eligible audit keeps the identical budget and actual spent lock wait`. A second real SQLite connection holds BEGIN IMMEDIATE. Actual failed acquisition/backoff advances 1+2+4 ms before releasing it. Require exact original-budget object identity for conflict and audit, seven spent wait milliseconds, multiple acquisition attempts, rollback-before-audit ordering and the exact positive event.
5. `P065 rejection audit: expired original budget never enters protected admission`. Expire before acceptIntent; require CallBudgetExpired, no transaction/callback/admission, no accepted state and no audit.
6. `P065 rejection audit: eligible queued audit expires before BEGIN without resetting the budget`. Observe actual audit transaction enqueue while 30 ms remains, then advance time before its queued acquisition executes. Require a second invocation but no second successful BEGIN, callback or COMMIT; actual CallBudgetExpired from the queue; original conflict identity; unchanged winner; zero rejection rows. The 30 ms queued overrun is observed, not granted new budget.
7. `P065 rejection audit: real SQLite audit failure rolls back and preserves the original conflict`. A temporary SQLite trigger aborts only intent.rejected insertion. Require a distinct audit BEGIN/callback/ROLLBACK, actual trigger error, available original budget, zero rejection rows and primary conflict identity. This is a known rollback case, not an acknowledged-lost COMMIT case.
8. `P065 rejection audit: failed completion or eligibility observation cannot replace a real conflict`. After real rollback, make the fixture clock observer throw. Require the actual conflict object, no new audit and unchanged durable state.

Instrumentation wraps only the fixture's actual ledger transaction method and SQL exec, calls through, records successful SQL distinctly from transaction invocation, and captures callback/transaction errors without manufacturing a conflict or replacing SQLite. The clock is the existing trusted fixture dependency. Each hook is restored in finally. Tests are serial, use isolated synthetic HOME/HUD_HOME/TMPDIR, close ledgers and remove owned temporary roots. The SQLite failure trigger is removed in finally. Those cleanup assertions/paths have been inspected but not executed. No test child or SQLite workload was started in this window, so runtime cleanup results are **NOT OBSERVED**, not passed.

## Required isolated behavioral controls

Each control is **NOT RUN**. There is no exit code, stdout/stderr or runtime source-restoration evidence yet. Do not report an import/compiler failure as its behavioral result. The dispatcher must record exact isolated mutation, fresh compiled-source identity, UTC boundaries, stdout/stderr, actual exit, expected failing assertion, and final candidate restoration/hash identity.

- **C-A, expired established refusal:** On an isolated source-candidate copy, replace the complete first failure-safe completion try/catch in acceptIntent's catch with the original unguarded `if (!auditUnsafe) budget?.check('complete');`. Do not merely replace note inside a swallowing catch. Run the new suite against fresh build:test output. The 30 and 30.001 ms cases must fail the exact-original-error assertion because the result is CallBudgetExpired/ledger_busy rather than the captured idempotency_conflict. Alternatively use the frozen before image plus the new test file, whose existing clock/fixture exports are already present.
- **C-B, eligible positive audit:** In an isolated copy, remove only the intent.rejected insertRecord block inside the optional audit callback, leaving its real transaction/local guard/budget callback check. The retained multiprocess exact-one assertion and new eligible exact-one assertions must fail with zero rows instead of one.
- **C-C, audit admission boundary:** In an isolated copy, remove only the budget/numeric remaining-time operand from optional-audit eligibility. At/after 30 ms, the new no-second-invocation assertion must fail even though the actual transaction guard still prevents a write.
- **C-D, audit failure priority:** In an isolated copy, change only the final optional-audit catch to `catch (auditError) { throw auditError; }`. The real SQLite-trigger case must fail the original-error-identity assertion. The queued expiry case must also cease preserving the conflict.

Use the focused 300-second command below with fresh builds as applicable; C-B includes the retained real multiprocess suite. Controls never run on integration, never change candidate assertions and make no performance claim.

## Verification inventory and blockers

Every stage below is **NOT RUN on this candidate**. There are no success counts, durations, raw test outputs, benchmark numbers or formatter claims to report.

New focused group, separately admitted on each supported Node family (Node 22 >=22.13 and Node 24), using explicit runtime identity and fresh output:
- `npm run build`, `npm run build:test`, `npm run build:hud-mcp`: 180 seconds each.
- `node --test dist-test/tests/unit/ledger-processes.test.js dist-test/tests/unit/ledger-write.test.js dist-test/tests/unit/p065-rejection-audit.test.js`: 300 seconds.
- `node --test dist-test/tests/unit/p065-budget.test.js dist-test/tests/unit/p065-local-gate.test.js`: 300 seconds.
- `node --test packages/hud-mcp/dist/tests/hud-mcp/p065-budget.test.js`: 300 seconds.
- The four isolated controls with fresh changed-source builds and the corresponding focused command: 300-second test cap.
- Four-path check-only formatting with the exact separately approved formatter: 300 seconds. No installation or substitute formatter was attempted.
- Actual committed repair delta `git diff --check 0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f 3435589ef253159948c94eaae111606191bd4e3d -- src/ledger/intents.ts tests/unit/ledger-processes.test.ts tests/ledger/process.mjs tests/unit/p065-rejection-audit.test.ts`: 60 seconds, plus any pending diff. The in-memory byte checks above do not replace this Git command.

Retain the full README/P065 final-candidate inventory:
- Three builds above.
- P065 affected ledger-write/b11-cli/b21-capacity/b6-wait-status group: 600 seconds.
- Existing MCP authorization/delegation/resume-expected-run/handshake/hook-source/b20-advice group: 600 seconds.
- `npm test`: 1,800 seconds, including its mjs stage; `npm run test:mjs`: 600 seconds if the aggregate stops before it, without relabeling the aggregate.
- `npm run test:core`: 600 seconds; `npm run test:visual`: 300 seconds; `npm run test:hud-mcp`: 600 seconds.
- Whole-package `npm run format:check`: 300 seconds; `npm run check:fixtures`: 120 seconds; actual diff hygiene: 60 seconds.
- Existing P065 CLI-to-MCP, local-gate, security, lifecycle and independent negative-control obligations.
- Existing real-clock comparators and complete P065 qualification, unchanged: original preparation-inclusive 30 ms, cumulative 20 ms wait, busy_timeout=0, actual outcomes/overruns, 50 warmups and >=1,000 measured calls per required cell, three isolated series on both supported Node families, and separate local-only qualification. Deterministic semantics do not substitute for these populations.

Current blocker is the intentionally connector-only implementation window: all compute validation awaits a separate authorized quiet window and exact-source execution setup. Formatter setup remains separately pending. Existing denied socket/ptrace operations, unknown historical outcomes and local-testing withdrawal remain binding; do not rerun, probe, move executors to evade a denial or silently skip an aggregate. Preserve exact prior blocker evidence and finish only independently permitted groups.

Only README-listed flakes receive the prescribed one isolated rerun, preserving both outputs. The original missing rejection-row assertion is not newly classified as a flake.

## Handoff

Request fresh Oracle review of this bounded changed behavior after its focused evidence is available. P065 package acceptance, NEXT consumption, qualification and integration remain held. No NEXT source, combined WIP tree, main/universal-hud write, force push, history rewrite, dependency staging or node_modules/.package-lock.json change is included.

The final guarded branch/report readback identities are returned to the dispatcher separately, because this report cannot contain its own future commit identity. A report-only descendant must compare as exactly this new documentation path with no source/configuration change.
