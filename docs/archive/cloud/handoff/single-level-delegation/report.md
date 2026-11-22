# One-level HUD delegation implementation report

Date: 2026-11-05. Base: `22bbb50a5563e3fe134d2af31f34a3190f72aa3e`.
Branch: `codex/single-level-hud-delegation-20261105`.
Environment: cloud Linux x64, Node 24.22.1. All task data and launches are synthetic.

## Delivered

- Captured managed launch marker presence restricts fresh new-session spawn before
  binding. It is internal service data, never an MCP argument or authority grant.
- After normal caller authorization and exact idempotency replay, the intent
  transaction refuses a managed caller before capacity and all new intent writes.
  An indexed full-SessionRef check of durable run targets survives revocation,
  terminal state and reopened stores/servers.
- The stable model-facing refusal is `nested_delegation_not_supported`.
- No schema expansion, numeric concurrency change, process/transcript scan,
  native-harness restriction or UI addition. Resume, same-owner handover,
  whoami/report and historical owner-scoped reads keep their normal gates.
- Ten new regression tests, including both source and thread identity isolation.
  Scope and supported pre-bind launch provenance are documented in
  `docs/cloud/single-level-delegation.md` and contract 03.

## Recorded checks

- MCP build: PASS. Source/build-test/MCP builds also pass in the finite cloud runner.
- Changed test/ledger/tool/error formatting and `git diff --check`: PASS.
- Final combined delegation suite: **16/18 PASS, 2 FAIL**. Both failures were
  unchanged production `ledger_busy` wall-clock budgets: the existing atomic
  spawn test and the new durable-restart test. The single bounded isolated rerun
  of those exact cases is **2/2 PASS**. Both original and rerun output are retained.
  This is not described as a first-pass green combined suite or timing qualification.
- Existing authorization, handshake, owner-list and expected-run suites, run
  serially: **26/26 PASS** (`related-mcp.log`).
- Negative control: removing only the compiled nested-delegation refusal makes
  the durable-identity test fail with `Missing expected rejection`; original
  compiled bytes were restored exactly, then the same test passes **1/1**.
- `node scripts/check-cloud.mjs`: **15/15 steps PASS**. The receipt is
  `cloud-results.json`: three builds, 189 focused tests, 78 product-workbench
  tests, 9 Pi source-root tests, and nine synthetic demos. This records the base
  commit plus dirty working tree honestly. Full raw cloud logs remain under the
  receipt's original local directory `tmp/cloud-development/checks-GMrYDF/`.

Earlier development runs exposed two test-fixture setup mistakes, which were
corrected before the final recorded run; budget-related failures were not hidden
or converted into successes. No production deadlines were relaxed.

## Boundaries and handoff

Supported launch marker plumbing protects pre-bind sessions. A manually altered
launch that strips every marker before first binding is outside that provenance
contract; this is not an adversarial harness sandbox. Durable identity protects
marker loss once binding has committed. No live providers, native installation,
WSL qualification, hosted CI, publishing or release was tested here.

The work stays on its isolated non-main branch. It changes neither the separate
statusline worktree nor the experimental chat backend. The latter retains its
existing uncommitted files and is not promoted into UI support by this slice.
