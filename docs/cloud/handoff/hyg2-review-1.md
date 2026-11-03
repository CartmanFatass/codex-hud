# HYG2 final review

**Verdict: fix required. Do not merge.**

Reviewed implementation [04f498c](https://github.com/CartmanFatass/codex-hud/commit/04f498c6e47e4f8fcb78e4dd351f12a4dcc2f35e) against `f1e2a84`, the brief, ownership ruling, binding contracts, implementer report, and [dispatcher check output](https://github.com/CartmanFatass/codex-hud/blob/f5b7343/docs/cloud/handoff/hyg2-dispatcher-checks-20261103.log).

## Required finding

**tests/int/process-client.ts:60–63 — Buffered messages bypass terminal failure — P2.**

`wait()` searches `messages` before checking `failure`. A buffered point therefore remains consumable after an id-less fatal error, IPC failure, or premature close. Subsequent waits can report success despite the helper having failed, contrary to the ruling’s explicit requirement that waits after failure reject.

I reproduced this against the reviewed compiled utility using an actual synthetic child:

1. Child sends `{point:'before_commit'}`.
2. Child sends `{error:'synthetic fatal failure'}`, then disconnects and exits.
3. Parent awaits `client.closed`.
4. `await client.point('before_commit')` **resolves**, returning the buffered point.

Observed output:

`{"subsequentPoint":"resolved-after-failure","value":{"point":"before_commit"}}`

**Required fix:** Make terminal failure take precedence over buffered messages. Clear or disregard buffered/post-failure messages once failed. Add a real-child regression covering a buffered point followed by fatal failure or premature close, and verify later waits reject. Preserve the existing successful early-point behavior while the helper remains healthy.

## Independent acceptance blocker

The README check set is **not green**.

Dispatcher log, lines 2461–2466 and 2725:

- `npm test`: **2354 tests, 2326 pass, 12 fail, 16 skipped; exit 1**.
- Because the command chains stages with `&&`, `test:mjs` did **not run** in that dispatcher invocation.

The twelve failures are:

- Four B19 Unix-socket `listen EPERM` failures.
- Three H05 missing `/proc/.../children` failures.
- Three ptrace `EPERM` audit failures.
- Two missing waiter/forwarder-target assertions.

The implementer’s separate `test:mjs` log reports **47 tests, 32 pass, 15 fail; exit 1**, involving synthetic socket failures.

These are not a passing suite or an acceptable known-flake rerun. The supplied baseline log contains the same twelve persistent failure signatures, corroborating that they predate this patch. However, it has no revision/tree header, so its exact baseline provenance is not independently pinned by that artifact. Socket/ptrace permission failures are directly evidenced; the missing-process/topology failures should not be declared conclusively environmental without further diagnosis.

**Disposition:** Fix the P2 finding within HYG2 ownership. Resolve the execution/check blockers through the dispatcher and appropriately scoped work, then obtain the required green checks. Do not weaken assertions, skip failing checks, or expand HYG2 ownership silently. A gate/profile change requires the owner.

## Verified

- All nine changed remote blobs, including the ownership ruling, match the reviewed local commit’s files. Its tree is `bf99976c55b1cdf405218c982ca3fa9c9f1411ef`. The reported `a319fd9` parent adds the ruling atop the requested `f1e2a84` comparison base.
- **SQLite warning:** The production hook is synchronous, suppresses only the exact SQLite `ExperimentalWarning`, restores `emitWarning` through `finally`, and retains the runtime/read-only capability checks. The raw CLI stderr normalization was removed. Tests cover raw stderr, restoration after success and failure, and unrelated warnings.
- **B45 timeout:** The existing test now calls the helper with the unchanged 10-second default. Its timeout path kills `result.pid`, retains an event-loop handle while awaiting completion, and then propagates failure. The hanging-child regression checks both PID disappearance and SIGKILL completion.
- **Process helper migration:** B12R, B12D, and B16 all use the new utility. Storage assertions and before-/after-COMMIT crash cuts are unchanged. Point waits are registered before their triggering sends.
- **Existing utility coverage:** Real-child tests exercise actual missing-`dist/` imports, pending/later RPC and point rejection without buffered matches, bounded stderr drainage, zero-exit missing replies, id-less errors, live IPC disconnection, successful early points, and intentional exact-child reaping. The newly identified buffered-after-failure case is missing.
- Focused logs report **73/73 passing on Node 22.23.4 and Node 24.22.1**.
- Recorded negative controls fail as claimed: unsuppressed SQLite produces the raw warning assertion failure; missing timeout cleanup fails PID liveness; missing pending-wait rejection produces unresolved-promise cancellations.
- Dispatcher build/build:test/build:hud-mcp, core **209 pass/1 skipped**, visual **319/319**, hud-mcp **83 pass/1 skipped**, formatting, fixtures, and whitespace checks pass.
- The implementer’s earlier full-run counts and isolated flake reruns agree with its supplied logs. They remain distinct from the dispatcher’s later run.
- Changes stay within the brief/ruling scope. No dependency, production signature, schema, contract, capability-profile, storage assertion, or tick-path change was found.
- Added source/tests and the dispatcher log use synthetic data. No newly added personal-home paths or apparent credentials were found. The pre-existing `node_modules/.package-lock.json` modification is outside the committed diff.
- No dedicated performance claim is made; no formal WSL qualification or local-only acceptance is established.

No files edited, git mutations performed, subagents started, or local-only work executed during this review.