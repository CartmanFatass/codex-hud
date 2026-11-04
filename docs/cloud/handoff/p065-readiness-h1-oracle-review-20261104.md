# P065 H1 missing-signal barrier: independent narrow source ruling

Date: 2026-11-04 UTC.

Scope: the H1-only diagnostic correction in `/workspace/shared/p065-driver-readiness-h1-02/`, compared with the retained, sealed `/workspace/shared/p065-driver-readiness-plan-01/` and the governing `/workspace/shared/p065-harness-review.md`. This is not an execution review, deployment admission, or package acceptance.

## Decision

**Accept the exact H1 source correction at diagnostic-artifact-manifest.json SHA-256 `1d4d7c8cf1b3186d7105de7f896f010b228a792b08eaf402aac4340056c137ac`. No remaining H1 source blocker was found.**

The generated diagnostic contains exactly the two declared changes: an abortable signal barrier with an immediate rejection observer, and rejection rather than success release at the unchanged missing-signal deadline. Under the declared active-wave, both-intentions-journaled schedule, absence of the real SIGTERM rejects both waiting jobs without invoking either primary call. The original failure handling records the pending intentions and the missing-signal error, and retains the original cleanup path. A later actual SIGTERM cannot change an already rejected barrier into a fulfilled one.

The original C package, all 33 files, its ZIP, pure-checker identity, manifest, and exact accepted command remain unchanged. H1 does not require regenerating, repackaging, or repeating C. The new manifest explicitly describes a non-executable review overlay; it is not an admitted replacement plan. **No execution or deployment is admitted by this ruling.** Separately reviewed evidence and explicit dispatch remain required for later stages, including I2. All other governing holds remain intact.

## 1. Independently verified identity and custody

The review read the actual files and computed the comparisons independently rather than relying on README, preparation-audit, or manifest claims.

- H1 directory: 16 regular files, no symlinks. All 15 SHA256SUMS entries match, and the checksum inventory covers exactly every other file.
- H1 manifest: the requested SHA-256 above matches the actual bytes. All 14 `newArtifacts` byte lengths and hashes match. Its 24 effective-artifact entries have exactly the original manifest's keys, correct baseline hashes and locations, and correct changed flags.
- Original directory: exactly 33 regular files, no symlinks. All 32 original SHA256SUMS entries match. The full actual inventory equals all 33 entries in baseline-custody.json.
- Original archive: 402,298 bytes, SHA-256 `56984184ddc5fbf286cec0d07e0a014ff3780b3d4fca36079b474b4efc3e28df`. Its 33 regular-file members have unique names, the documented directory prefix, and exact byte/hash equality with the original directory.
- Original plan-manifest.json: SHA-256 `64cff67cd7e51a26e1bd8721b2f9cc7845250865f8136de2764b4b76e3533f3b`. All 24 artifact hashes independently match the retained files.
- H1's h1-ruling.md is byte-identical to the supplied governing p065-harness-review.md.
- Source pin remains commit `8f67f7e2d8249295e5a84af0bb9b98817a30459c`, tree `3e30a63f21d2c50389444dff65f2c47d1c3af3c4`. The retained driver bytes have SHA-256 `fb9559202caa4e4f20b01698392bb77afe7699251ecf5a2d3a51ad546aa227c8`.

The effective-artifact map changes only runtime-hooks.template.mjs, runtime-entry.template.mjs, runtime-diagnostic.mjs, extraction-map.json and runtime-vs-source.diff. Original controller, custody checker, gate, generator, source copies and build baselines remain bound to the unchanged baseline locations and hashes.

Changed JavaScript identities:

- runtime-hooks.template.mjs: 5,501 bytes; SHA-256 `912bb04f62817ea39c1238c7e8a861b45a88f1d370637d52c8b7df2e26030efa`.
- runtime-entry.template.mjs: 7,385 bytes; SHA-256 `f8b192301b34b9af16ec187c67f3bcfc30d29ed5a30d7e175dfae55882d28aca`.
- runtime-diagnostic.mjs: 97,789 bytes; SHA-256 `9abd4c39c2ab8f0bc110cd60a31d6a697108f51865d6a85852d632932910a6bf`.

## 2. Exact delta and assembly

I applied the four byte-range replacement records from h1-delta-map.json to independent in-memory copies of the corresponding original files. Every recorded position, length, before/after hash and unique replacement text matches. The resulting three files equal the candidate exactly. The generated file's second offset correctly uses the documented intermediate-file convention after the first replacement.

Independent unified-diff reconstruction exactly matches all supplied comparisons:

- Hooks template: one hunk.
- Entry template: one hunk.
- Generated runtime: exactly two hunks, reproducing those template changes and nothing else.
- Extraction map: one hunk, changing only runtime output length and SHA-256.
- Complete runtime-versus-immutable-source comparison: eight hunks, including the already accepted derivative differences.

All 28 extraction-map source ranges match the immutable source byte lengths and hashes. After replacing only the runtime output identity with the old value, the complete extraction-map object equals the original map. Its C identity and declaration ranges are unchanged.

I also reconstructed the entire candidate runtime as text in memory from the immutable prefix, the four accepted prefix substitutions, the six accepted compiled-import URL substitutions, the accepted narrowed cold loop, the original mapped entry/catch/finally blocks, and the two candidate templates. It equals the candidate byte for byte. No supplied generator was executed. This independently checks template/generated consistency, not merely the small diff.

## 3. Failure-closed behavior established by source inspection

### Barrier rejection and primary exclusion

Hooks template lines 13–21 now capture both resolve and reject functions for the same `signalBarrier`. The entry template's timeout at lines 36–42 retains 15,000 ms, the original stderr message and exitCode=1, but calls `abortSignal(new Error('diagnostic_signal_not_received'))` instead of `releaseSignal()`.

The existing call wrapper, hooks lines 102–119, is unchanged. For I2 primaries it returns `signalBarrier.then(invoke)`; only `invoke` calls the captured original `exactCall`. A rejected barrier propagates its rejection through this fulfillment-only handler and does not invoke it. Therefore neither primary reaches the original call's issued-state assignment, measurement attachment or MCP RPC. This is primary exclusion, not a claim that fixture initialization, handshakes or holder traffic never occurred; those deliberately precede the barrier.

The original wave journals both intentions before building the two operational jobs, then awaits their `Promise.all` (generated lines 1128–1153). Both wrappers share the same barrier. In the declared H1 schedule both rows retain `dispatchState: 'pending'` and `finished: false`; neither gains fabricated response, diagnostics or end data. Rejection transfers control to the wave catch, so recovery and later success-path work are not reached.

### No fabricated stop and no late reopening

There is exactly one call to `releaseSignal()` in the candidate runtime, inside the actual SIGTERM listener at generated lines 2117–2123. The missing-signal branch does not emit a signal, set `signalReceived`, set `stopped`, change a production clock or manufacture `p065_outer_timeout_incomplete`.

The original SIGTERM listener remains installed before the additional diagnostic listener. A genuine signal received first retains the original stopped-state/raw-interrupted handling, records actual receipt, clears the timeout and resolves the barrier. The original call then fails its unchanged outer check before primary issuance, as in the accepted positive I2 design.

If the timeout settles the barrier first, a later real listener invocation may truthfully record that later signal and change the original stopped state, but its resolve callback cannot resettle the already rejected promise. The primary fulfillment callbacks cannot run, and the rejection is not replaced with a synthetic signal failure. The timer and signal callbacks run sequentially; the first settlement controls the promise.

### Pre-wave rejection handling

The immediate `signalBarrier.catch(() => {})` is a separate rejection observer, attached synchronously before the timeout is installed and before initialization awaits. The variable still refers to the original barrier, not to the promise returned by catch. Its callback neither throws nor returns a rejected promise, so the observer's otherwise-unused result fulfills.

Consequently, if imports or initialization outlast the deadline, the barrier has a rejection handler already attached and does not create an unhandled rejection merely because wave has not subscribed yet. Any later primary wrapper still observes the original rejected barrier and skips `invoke`. Once the operational jobs are constructed, their derived rejection chains are synchronously attached to the original `Promise.all`, followed by `allSettled` in its catch. The no-op observer does not swallow the rejection seen by those jobs.

## 4. Original error, evidence and cleanup

The original wave catch remains byte-identical (generated lines 1345–1354). It awaits all issuedJobs, obtains `errorText(error)`, finalizes every registered row, writes `wave_failed` records and rethrows the same error. The unchanged finalizer (lines 983–995) assigns the interruption reason and `not_issued_incomplete` disposition without inventing completion timing. Both rejected jobs originate from the same timeout Error; the observer does not translate it.

The unchanged cell catch retains the failure, summarizes the incomplete rows, writes an incomplete snapshot and rethrows. The outer catch preserves the observed error text in its existing failure/report/stderr path and leaves exitCode=1 (lines 2216–2220 and 2242–2249). Under the declared schedule with otherwise successful writers/cleanup, these records retain `diagnostic_signal_not_received`, not the expected injected-stop reason.

The original wave finally remains intact (lines 1355–1377): holder close request and existing fallback, queue-job settlement, client closure, instrumentation restoration, service/ledger/observer closure, fixture disposal and current-state reset. The outer finally retains owned-helper process closure, owner-checked sandbox deletion and environment restoration (lines 2250–2258). The patch does not bypass either finally or substitute a new cleanup mechanism.

These are source control-flow guarantees, not a runtime resource-closure pass. Existing cleanup or evidence-write failures can still add failures or interrupt later cleanup; they must remain unexpected and must not be relabeled a valid I2 result. Actual process, lock, wait and ECHILD closure still require the governing controller evidence. The two-row claim applies when both intentions exist. An earlier initialization failure cannot supply that evidence. If the barrier deadline fires before wave and later independent initialization or signal handling stops progress earlier, the timeout's stderr record remains evidence; this review does not claim that every possible earlier failure must reach wave finalization or produce a two-row report.

The unchanged positive-I2 postconditions deliberately reject the missing-signal result. The check at generated lines 2268–2272 requires `p065_outer_timeout_incomplete`, while H1 produces `diagnostic_signal_not_received`. Thus H1 cannot set `diagnosticValidated=true`, manufacture a positive I2 sidecar, or pass merely because a late signal was also observed. The later assertion may add `unexpected_error_is_not_an_injected_stop` to stderr; it does not turn the earlier retained timeout into success. An unexpected failed attempt need not reach the diagnostic.json write. Retain its actual raw/report/support/stderr files rather than promising that sidecar.

## 5. C identity and remaining admission boundary

The original pure-checker.mjs remains 35,691 bytes with SHA-256 `51f0010d2495f414140140d928c9406d58a3504055e4b9c4dfadb605bf193921`. No pure checker, executable plan-manifest.json or run-case.sh is included in the new H1 directory. The exact C command agrees in original COMMANDS.md, governing review, baseline-custody.json and the new manifest:

`/bin/bash /workspace/p065-driver-readiness-plan-01/run-case.sh node24 C 64cff67cd7e51a26e1bd8721b2f9cc7845250865f8136de2764b4b76e3533f3b`

This command is recorded to identify unchanged custody, not dispatched by this review. The original manifest pin cannot be reused to run altered bytes, and the H1 review-overlay hash is not a runnable plan-manifest hash. A future diagnostic deployment must be separately sealed/admitted without overwriting or silently regenerating the accepted C package.

The narrow H1 source precondition for eventual I2 is satisfied. Preceding-stage evidence, a named quiet admission and the exact future deployment/command remain separate requirements. No automatic R/I progression, Node 22 execution, full benchmark, new capability probe, formatter/build/test rerun, source/repository change, merge or package acceptance follows. Existing R1/F1–F5, formatting and build-readiness acceptances are not reopened or reset. Full populations, timing gates, nonqualification boundaries and all platform/package holds remain those of the governing review.

## Method and limits

Read-only local file inspection plus independent data-only byte, SHA-256, archive, JSON, diff and in-memory text-assembly checks. No supplied JavaScript or Python program was evaluated, imported or executed. No generator, Node/syntax/parser check, checker bank, driver, controller, holder, project test, compiler, formatter, signal exercise, process/capability probe, Git command, repository write or external publication was performed. This review creates only this requested standalone ruling. Historical execution claims in preparation-audit.json are not treated as independently demonstrated behavioral results.
