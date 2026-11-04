# HYG2 ruling: parent-side process helpers and regression ownership

**Decision: use the proposed shared parent-side utility. These narrow ownership clarifications are in-package; no owner decision is needed.**

Reviewed `dots/hyg2` at `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9`, HYG2, the HYG1 handoff, current package ownership, the workflow, contract 06’s crash-consistency requirements, contract 07’s export behavior, and decision log §15.

## Reason

HYG2 item 3 names child entry files, but the defect is in their parents:

- `tests/unit/b12r-store.test.ts:473–525`: unread stderr and IPC/point promises without termination handling.
- `tests/unit/b12d-wal.test.ts:442–485`: the same pattern, using the same `b12r-process.mjs` child.
- `tests/unit/b16-writer.test.ts:397–410`: unread stderr and an unconditional wait for the first IPC message.

Strictly, these three contain inline helpers, not existing `ProcessClient` classes. The class used as the precedent is in `tests/unit/b12-store.test.ts:655–713`.

Static imports in the children can fail before any message handler is installed. Therefore, changing only child files cannot reliably report missing-build/import failures. Putting unrelated wrappers into `b45-launch.test.ts` would not repair the affected callers.

## Authorized file scope

Retain HYG2’s existing ownership and clarify these additional, narrow locations:

- `tests/unit/hud-link-export.test.ts`: item 1’s warning regression and removal of the warning allowance that would mask that regression.
- `tests/unit/b12r-store.test.ts`
- `tests/unit/b12d-wal.test.ts`
- `tests/unit/b16-writer.test.ts`

  In these three files, change only subprocess creation, communication, failure handling, and cleanup needed by item 3. Preserve the storage assertions and crash cuts.

- New `tests/int/process-client.ts`: shared test-only subprocess utility.
- New `tests/unit/process-client.test.ts`: focused regressions for that utility.

The existing test build follows imports into `tests/int/`, and the unit-test glob already discovers the proposed test file. **No `package.json`, compiler configuration, production API, or dependency change is required.**

Do not refactor `b12-store.test.ts` merely for uniformity. Its existing class is a precedent, not additional required migration scope. Child helpers may remain unchanged.

## Required behavior and acceptance clarification

The brief’s acceptance remains unchanged: every item needs a test that fails without its fix, and the README check set must pass. Concretely:

1. **Warning:** test raw stderr from a fresh CLI process on Node 22. HYG1’s `hudStderr()` normalization must not hide the regression. Suppression remains limited to the SQLite initialization warning, restores the warning mechanism, and preserves unrelated warnings and existing export errors. No global warning-disable flag.

2. **Supervisor cleanup:** the timeout path kills the exact owned `result.pid` and establishes cleanup before propagating the failure. Add a deterministic regression that actually exercises the timeout path. Keep the production timeout and unrelated launcher behavior unchanged.

3. **Process utility:**
   - Attach stderr drainage and lifecycle/message handlers before sending requests.
   - Bound retained diagnostics while continuing to drain all stderr.
   - On premature `close` or process/IPC failure, settle pending RPC and point waits; subsequent waits must reject rather than hang. Include helper identity and available stderr in the failure.
   - Preserve complete startup/import diagnostics. An exit code of zero before a required response is still failure.
   - Handle B16’s existing id-less `{ error }` message, rather than silently waiting for a point that will never arrive.
   - Register point waits before the triggering send, or buffer points, so an early point is not lost.
   - Preserve intentional SIGKILL crash testing and exact-child reaping. Expected cleanup must not itself fail the test or leave unobserved rejected promises.

Regressions should exercise an actual synthetic child’s import failure, pending and later RPC/point failure, bounded stderr drainage, and successful communication plus intentional termination. Preserve the existing before-/after-COMMIT assertions. A utility-only test is insufficient if the three callers remain on their old paths.

## Boundary determination

- **Contract change:** none.
- **Gate or supported-profile change:** none.
- **Design-document or owner-reserved decision:** none.
- **Other queued package’s owned files:** none. The listed changes remain disjoint from RUNZ1, B10B-S3F, TPD1, and DOC2.

This clarifies where HYG2’s explicitly requested fixes and tests live; it does not grant general ownership of B12/B16 production code or unrelated tests. Any need to change those, weaken an assertion, alter a crash cut, or waive a required check must return for consultation.

**Disposition: proceed within this scope. This is a design ruling, not the final accept verdict. No files edited or tests executed.**