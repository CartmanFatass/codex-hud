HYG2 fix round 1 is implemented and published.

**Remote commit:** [4e120f5e82e81124619d9dbb9bf5875ceb581405](https://github.com/CartmanFatass/codex-hud/commit/4e120f5e82e81124619d9dbb9bf5875ceb581405)  
**Branch:** dots/hyg2  
**Parent:** bec2dbca18a4ea00328bda81f741e7926d5f1c5c  
**Remote tree:** d27da425ed07d4b85a435128477c9346085cb9c3

The dispatcher’s review and check-log commits were preserved. Publication used expected-head checking and force=false; the fetched remote ref was verified.

**Required P2 finding addressed**
- tests/int/process-client.ts:
  - `wait()` checks terminal failure before buffered messages.
  - Failure clears buffered messages.
  - Messages received after failure are ignored.
- tests/unit/process-client.test.ts:
  - Added real-child regressions for buffered points followed by fatal error, premature close, and live IPC disconnection.
  - Each verifies pending and subsequent waits reject.
  - Existing healthy early-point behavior remains tested and passing.

Only these two files changed in the fix. Previously accepted production code and tests were untouched.

**Regression evidence**
- Utility suite: 9/9 passing on Node 22.23.4 and Node 24.22.1.
- All six HYG2-focused suites: **76/76 passing on both versions**.
- Negative control used the exact pre-fix utility from 04f498c with the new tests: **all three new regressions failed**, each with “Missing expected rejection.”

**Full check results**
- build + build:test + build:hud-mcp: exit 0.
- npm test: **2357 tests, 2326 pass, 15 fail, 16 skipped; exit 1**.
- core: 209 pass, 1 skipped, 0 fail.
- visual: 319/319 pass.
- hud-mcp: 83 pass, 1 skipped, 0 fail.
- format, fixtures, git diff --check: exit 0.
- Separate test:mjs: 47 tests, 32 pass, 15 socket failures; exit 1.

The twelve previously observed persistent failures remain. Three additional failures in this full run passed diagnostic isolated reruns:
- b10b-perf no-change tick: suite 5/5.
- b3h-signals integration deadline: suite 10/10.
- int-ledger-run null stamp: suite 24/24.

Both failing and isolated outputs are preserved. These reruns do not waive the full-green gate.

**Evidence**
- Raw final checks and focused logs:  
  /workspace/scratch/6daef0397a95/hyg2-tmp/fix1/checks/
- Negative control:  
  /workspace/scratch/6daef0397a95/hyg2-tmp/fix1/negative-before-fix.log
- Tested local revision: dced9114e9d15977fef07fa52c1a329a58dfa505
- Tested local tree: 380b637c6cc867cde2a62d38789743e65f694b62

Check logs now contain revision/tree headers. Comparing tested local HEAD with the published remote shows only the dispatcher’s added review document; src, tests, package.json, and package-lock.json are identical.

Socket/ptrace EPERM is directly evidenced. Missing-process/topology failures remain repeated baseline failures of undetermined cause, not conclusively environmental. The earlier baseline log lacks its own revision header.

No dependency, API, gate, profile, performance, or local-only changes. node_modules/.package-lock.json remains unstaged and uncommitted. No commit statuses were returned.

**The P2 fix is ready for fresh re-check. The independent full-green acceptance blocker remains; do not merge yet.**