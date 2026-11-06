# E4 headless close: implementation and check handoff

Status: source candidate prepared for independent review. Built-service validation
is **BLOCKED / NOT_RUN**, not PASS. No provider/control qualification, publication,
integration, merge or capability promotion is claimed.

## Pinned scope

Base commit `60625488804bed0eff637d0a1b570fd31f158f41`, tree
`4bcfc1123db6124e59d4d17a18ae54c4d3ac6e39`. The working input is a reconstructed
subset, not a complete checkout. This is the base tree, not the final candidate
tree; the coordinator will compute the full candidate tree from the overlay.
Additional unchanged source/test inputs were
retrieved at that commit and checked against the complete Git blob inventory.
The approved scope is recorded in `docs/handoff/questions/e4-headless-close.md`.
Contracts 02, 03, 06, 07 and concept sections 6.6.1/15 reconcile the former blanket
close refusal. Contracts 01, 04 and 05, DDL/user_version, capability manifests,
process signals/census, RunControl, installer and CI workflows are unchanged.

## Implementation

- Strict authenticated-parent `delegate_close` schema, exact Claude tool allowlist,
  existing original-receipt write budget and sanitized refusal codes.
- `requestClose` validates an existing current caller context and canonical owner
  before the shared idempotency lookup. Replay precedes all fresh link/run gates,
  returns the original outcome, and performs no context establishment, cancellation
  dispatch, cleanup or finalization. Derived observations are separate and nullable.
- Atomic close.requested plus immutable outcome, reusing the existing cancellation
  intent format and preserving existing grace/time/steps. No new run/claim/slot or
  launch event. A distinct pending key refuses; a closed relationship has an
  authenticated already_closed no-op.
- Fresh resume and predecessor handover are fenced after immutable replay.
- `finalizeCloseIn` runs in close admission and the existing reconciler, including
  terminal runs without a new transition. Frozen owner/run/sequence/generation/full
  target, validated terminal R/Q/N basis, submission fence, no actual-target/run slot
  and no unresolved conflict are required. It closes only the unchanged current
  relationship, revokes claims/bindings and remaining wake registrations, and retains
  all run outcomes, terminal notes, receipts, reports and history.
- Status/list/wait expose read-only pending/closed/incompatible progress and
  non-resumability. Local status uses the same pending fence; it gains no close API.

No visible/local-manager close, reopening, live input, send/ask, new worker,
relaunch or paused HUD chat UI is included. Generic mvpOperationPolicy(close)
remains unsupported.

## Test source and actual evidence

`tests/hud-mcp/headless-close.test.ts` traverses actual HudMcpServer,
DelegationService, temporary SQLite and commitReconcile. It is ledger/MCP
simulation, not an executed owned-runner simulation. Cases cover active acceptance,
terminal R/Q/N, cancellation before/after/unknown chronology, immutable replay,
changed parameters, source/context/owner/target/generation failures, pending
resume/handover ordering, unconfirmed/visible targets, unknown/partial cleanup,
revoked relationships, rollback/recovery, terminal-without-transition completion,
missing terminal evidence, late reports/binding, restrictive nested-delegation
history, wake revocation and budget/COMMIT/cleanup semantics. Hook, skeleton and
Pi bridge test sources are updated for the exact added tool.

Checks on Node 24.22.1:

- PASS: built-in `node --check` parsing of all changed TypeScript/MJS files. This
  neither type-checks nor executes their imports or tests.
- PASS: scoped synthetic fixture/privacy scan using the repository checker.
- PASS: before/after whitespace check has no diagnostics. `git diff --no-index
  --check` returns 1 for the expected file differences; the initial EOF-whitespace
  diagnostic is retained separately and was corrected.
- BLOCKED: `npm run build`, `npm run build:test`, `npm run build:hud-mcp` each exit
  1 because `node_modules/typescript/bin/tsc` is absent.
- BLOCKED: scoped Prettier invocation exits 1 because the repository Prettier is
  absent. No formatting pass is claimed.
- BLOCKED / NOT_RUN: new service suite launch exits 1 because its compiled test
  file does not exist. No test body ran.
- BLOCKED / NOT_RUN: `node --test tests/unit/relaxed-delegation-budget.test.mjs`
  exits 1 at import because `dist/ledger/runtime.js` is absent. No budget assertion
  ran.
- NOT_RUN: affected authorization/list/resume/hook/skeleton/Pi bridge/run-control/
  ledger-run functional regressions, aggregate builds/tests and real providers.

The exact prerequisites are the complete pinned repository build/test input,
locked repository-compatible TypeScript, Node types, Prettier and runtime
packages. Do not retry the blocked registry, import unrelated dependencies,
expand the bounded startup transform, alter workflows or use remote dependency
materialization to evade the restriction. Existing ordinary hosted CI, if a
candidate is independently authorized for publication, is separate evidence for
only the commands it actually executes.

Independent Oracle review and ordinary full-environment validation remain open.
