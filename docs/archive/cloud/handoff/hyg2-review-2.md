# HYG2 fix-round-1 re-check

**Verdict: fix required. HYG2 is not accepted; do not merge.**

The previous P2 code finding is **fixed**. I found no new regression in the fix. The independent full-green acceptance blocker is **not resolved**: the dispatcher still records twelve unit-test failures and fifteen additional `test:mjs` failures. This verdict does not request unrelated code changes from the HYG2 implementer or waive any check.

## Reviewed scope and provenance

- Fix commit: [4e120f5e82e81124619d9dbb9bf5875ceb581405](https://github.com/CartmanFatass/codex-hud/commit/4e120f5e82e81124619d9dbb9bf5875ceb581405), against the previously reviewed implementation `04f498c6e47e4f8fcb78e4dd351f12a4dcc2f35e`.
- Tested local revision: `dced9114e9d15977fef07fa52c1a329a58dfa505`; tree: `380b637c6cc867cde2a62d38789743e65f694b62`.
- Branch tip observed after evidence publication: `62c3dac0e493be19a860917571655a482aabeec9`. Comparing this tip with `4e120f5` shows documentation/evidence additions only.
- Read AGENTS.md, the dots and cloud workflow/check rules, HYG2, its ownership ruling, the prior review, both implementer reports, and the complete available check evidence. Previously accepted areas untouched by this fix were not reopened.
- The fix commit changes only `tests/int/process-client.ts` and `tests/unit/process-client.test.ts`. Their remote blob IDs match the tested local source: `c161c158f85db34188e754ed06adcb842d93ae4a` and `3ab24c1d2ed1433ae25d5ca674a1d05bcceac6e3` respectively.

## Previous finding: fixed

**tests/int/process-client.ts:29,51–54,62–66 — Buffered messages bypass terminal failure — P2: fixed.**

`wait()` now checks terminal failure before examining buffered messages. `fail()` clears the buffer, and the message handler ignores messages received after failure. Consequently, neither an earlier buffered point nor a later message can turn a failed helper into a successful subsequent wait.

`tests/unit/process-client.test.ts:127–148` adds three actual-child regressions: buffered points followed by an id-less fatal error, premature close, and live IPC disconnection. They verify a pending wait rejects, then verify buffered-point, later-point, and subsequent-RPC waits reject. The fatal variant also sends a point after reporting failure. The existing healthy early-point/reply test remains intact.

Independent checks on host `d14215e6cbaa`, Linux 6.18.57 x86_64, with temporary HOME, HUD_HOME and TMPDIR:

- Node 22.23.4: `node --test dist-test/tests/unit/process-client.test.js` → **9 tests, 9 pass, 0 fail; exit 0**.
- Node 24.22.1: the same command → **9 tests, 9 pass, 0 fail; exit 0**.
- Before running, I independently transpiled the two current TypeScript sources in memory and confirmed that the existing built JavaScript matched, excluding source-map comments.
- Independent negative control: compiled the exact pre-fix utility from `04f498c` into an isolated scratch directory, paired it with the current regression tests, and ran Node 22 with `--test-name-pattern='rejects buffered'`. **All three regressions failed with “Missing expected rejection”; 0 pass, 3 fail, exit 1.** No repository file was changed for this control.

No new code finding was identified. No further HYG2 implementation change is requested for this P2.

## Verified check evidence

The fix report accurately describes its own recorded run:

- The six HYG2-focused suites: **76/76 passing** on both Node 22.23.4 and Node 24.22.1.
- Full unit run: **2357 tests, 2326 pass, 15 fail, 16 skipped; exit 1**.
- Its three additional failures have separately recorded passing diagnostic reruns: b10b-perf **5/5**, b3h-signals **10/10**, and int-ledger-run **24/24**. These reruns do not make the required full check set green.

The later dispatcher run is distinct and records:

- build, build:test and build:hud-mcp: **exit 0** each.
- `npm test`: **2357 tests, 2329 pass, 12 fail, 16 skipped; exit 1**.
- Because npm test chains stages using `&&`, its `test:mjs` stage did **not run** in that invocation.
- Explicit supplemental `npm run test:mjs`: **47 tests, 32 pass, 15 fail, 0 skipped; exit 1**.
- test:core: **210 tests, 209 pass, 0 fail, 1 skipped; exit 0**.
- test:visual: **319/319; exit 0**.
- test:hud-mcp: **84 tests, 83 pass, 0 fail, 1 skipped; exit 0**.
- format:check, check:fixtures, and git diff --check: **exit 0**.

The twelve unit failures are the same signatures identified in the first review: four B19 Unix-socket `listen EPERM` failures, three H05 missing `/proc/.../children` failures, three ptrace `EPERM` audit failures, and two missing waiter/forwarder-target assertions. The supplemental mjs failures concern synthetic socket tests. Socket and ptrace permission errors are directly evidenced. The missing-process/topology failures remain of undetermined cause; their recurrence alone does not establish an environmental cause or justify a waiver. The earlier baseline artifact still lacks an independently embedded revision header.

## Evidence archive verification

The original `hyg2-fix-dispatcher-20261103.log` contains a truncation marker and is **not the complete raw log**. Use `docs/cloud/handoff/hyg2-fix-dispatcher.log.part01.txt` through `part06.txt`, concatenated in numeric order **without inserting separators**; parts can split a line.

I fetched all six published parts and verified that their concatenation exactly matches the complete 3420-line local dispatcher log. Its SHA-256 is:

`f02d0f1f06341ce7487a1fc58eb2bf37a629d4dc6d69df1139d0753572db79e5`

I also verified that the published [supplemental mjs log](https://github.com/CartmanFatass/codex-hud/blob/62c3dac0e493be19a860917571655a482aabeec9/docs/cloud/handoff/hyg2-fix-mjs-dispatcher-20261103.log) exactly matches its complete local original. SHA-256:

`d69b4b6aeb16a080631ca407b0f4322ff3944c7bcf8424c099ee0c23bd7438fb`

The dispatcher supplied the tested local revision/tree above separately; the main raw dispatcher log does not embed that header. The implementer’s fix-round check logs do embed it. The supplemental dispatcher mjs log identifies `dced9114e9d15977fef07fa52c1a329a58dfa505`.

## Remaining gates and disposition

1. Resolve the execution restrictions and diagnose the persistent process/topology failures through the dispatcher and appropriately scoped work. Do not weaken assertions, skip required checks, expand HYG2 ownership silently, or classify an unknown cause as environmental.
2. Obtain the required green README check set, including mjs, on the intended code tree. Record exact revision/tree, host/runtime, commands, raw output and exit codes; retain both initial and isolated outputs for known flakes.
3. Only after the package satisfies acceptance may it receive an accept verdict. The workflow additionally requires the full green check set on the merged tree before pushing the `--no-ff` integration. A gate or supported-profile change remains an owner decision.

No commit statuses or pull-request workflow runs were returned for the fix commit; this is not positive CI evidence. No new production, dependency, API, contract, profile, performance-gate, storage-assertion or crash-cut change is present. No dedicated performance or WSL/local-only qualification is claimed.

No repository writes, git mutations, subagents, or local-only work were performed during this re-check. The pre-existing unstaged `node_modules/.package-lock.json` modification remains untouched.