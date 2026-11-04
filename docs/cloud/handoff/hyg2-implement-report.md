Implemented and published HYG2.

**Branch:** dots/hyg2  
**Commit:** [04f498c6e47e4f8fcb78e4dd351f12a4dcc2f35e](https://github.com/CartmanFatass/codex-hud/commit/04f498c6e47e4f8fcb78e4dd351f12a4dcc2f35e)  
**Verified tree:** bf99976c55b1cdf405218c982ca3fa9c9f1411ef  
**Base:** a319fd93b261470527f445ade77457a52df875ea, including the preserved Oracle ruling.

Changes:
- src/ledger/runtime.ts: synchronous SQLite initialization with temporary, exact SQLite ExperimentalWarning suppression. Restores emitWarning on success and failure; preserves unrelated warnings.
- tests/unit/hud-link-export.test.ts: removed stderr normalization; added raw CLI stderr, restoration, initialization-failure, and unrelated-warning coverage.
- tests/unit/b45-launch.test.ts: timeout kills the exact supervisor PID, retains an event-loop handle while reaping, then rethrows. Production deadline remains 10 seconds. Deterministic hanging-child regression uses a shorter test deadline.
- tests/int/process-client.ts: shared parent-side IPC helper with bounded stderr retention, continuous drainage, pending/subsequent failure handling, point buffering, id-less error handling, and exact-child cleanup.
- tests/unit/process-client.test.ts: six real-child regressions.
- tests/unit/b12r-store.test.ts, b12d-wal.test.ts, b16-writer.test.ts: adopted the utility without changing storage assertions or crash cuts.

No production API, dependency, contract, profile, gate, or storage behavior changes. Child .mjs files remain unchanged. Followed docs/cloud/rulings/hyg2.md.

**Final focused verification**
- Node 24.22.1: 73 tests, 73 pass, 0 fail.
- Node 22.23.4: 73 tests, 73 pass, 0 fail.
- Negative controls:
  - Restoring unsuppressed SQLite initialization fails raw-stderr assertion with the actual ExperimentalWarning.
  - Removing timeout cleanup fails the PID-liveness assertion.
  - Removing pending-wait rejection reproduces unresolved-promise cancellations on actual helper import failure.

**README checks, final code**
- build + build:test + build:hud-mcp: exit 0.
- npm test: 2354 tests, 2325 pass, 13 fail, 16 skipped.
- test:core: 210 tests, 209 pass, 0 fail, 1 skipped.
- test:visual: 319/319 pass.
- test:hud-mcp: 84 tests, 79 pass, 4 ledger_busy failures, 1 skipped.
- format:check: “All matched files use Prettier code style!”
- check:fixtures: “check-fixtures: OK (tests/fixtures tests/prototypes docs/design)”
- git diff --check: exit 0.

Known-flake isolated reruns:
- b11-cli: 20/20 pass.
- hud-mcp b20-advice: 9/9 pass.
- hud-mcp delegation: 8/8 pass.
- hud-mcp resume-expected-run: 7/7 pass.
- run-light-leader: 48 pass, 5 persistent failures.

Remaining full-suite failures reproduce baseline/environment problems:
- Four B19 synthetic Unix-socket listen EPERM failures.
- Three H05 missing /proc/.../children failures.
- Three ptrace EPERM audit failures.
- Two missing waiter/forwarder-target failures.
- B11 ledger_busy passes its isolated rerun.
- Separately ran test:mjs because npm test stopped at unit failures: 32 pass, 15 synthetic socket EPERM failures.

Permitted escalation was attempted, but these restrictions remained. No workaround, assertion weakening, or local-only execution was used.

**Evidence and environment**
- Checkout: /workspace/scratch/6daef0397a95/hyg2-work
- Final raw logs: /workspace/scratch/6daef0397a95/hyg2-tmp/final-checks-2/
- Earlier full run: hyg2-tmp/final-checks/
- Untouched baseline: hyg2-tmp/baseline-all/npm-test.log
- Negative controls: hyg2-tmp/negative/
- Host: d14215e6cbaa, Linux 6.18.57 x86_64.
- Checks used temporary HOME/HUD_HOME and workspace-backed TMPDIR because /tmp is tmpfs and B12D explicitly requires native-backed storage.
- NODE_USE_ENV_PROXY was unset for offline tests to avoid Node 22’s unrelated host-injected UNDICI-EHPA startup warning. SQLite warnings remained enabled.
- Node 22 was installed under an isolated temporary prefix from npm; no repository dependency changes.
- No tick-path change or dedicated performance claim.

Plain git push lacked credentials. Published the identical tested tree through the authorized GitHub connector using expected-head checking and force=false. Verified remote ref through both connector and git ls-remote. Local commit b32c42b has the identical tree; no history was rewritten. node_modules/.package-lock.json remains unstaged and uncommitted.

No commit statuses or workflow runs were returned for the published commit. Oracle review and the full-green merge gate remain outstanding; do not merge on this report alone.