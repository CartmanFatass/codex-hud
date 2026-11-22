# RUNTIME-COMPOSE-1 implementation report

## Outcome and boundary

The new offline fixture composes the two reviewed candidates without any production-source edit. It exercises the actual adjacent installer CLI, generated selector/shim, unchanged production MCP wrapper, fixed installed production managed-runtime factory and physically observed native direct parent. No production wiring defect was demonstrated, so the intentional differences between the pre-existing fixture families were not changed.

This is SIMULATED installed-startup evidence on Linux / Node 24.22.1. The native executable is the unchanged repository C fixture, not Codex. The main, requests, cells, inert command anchors and dependency entrypoints are synthetic. Dependency canaries throw if executed. No production dependency was materialized, no production service or task supervisor ran, and no capability was published.

Acceptance is established by the separate final Oracle review and coordinator publication evidence, not by this implementation report. An ordinary hosted CI result covers only the commands present in its logs; its existing list excludes this new composition test.

## Source identity and changed paths

- Base: `ba6887ccddc9332971985113f9862a29146d13d1`, tree `a9665e6856d80e756cf050821b9400d3f0f3085c`.
- Managed input: `1a49cccb4201c7042d5bf3c9733bfdd53181daed`, tree `c5ce8f29435f62748be477627773b7130eed3640`.
- Installer input: `c6ecf74f3ec56868d1388022be9081d76a3d252d`, tree `161cfb05bbbd99fbd096941807f66cf27234f709`.
- Untouched input union tree: `1c85d206c6d6d68ee6acdfc0fe7b1175d2c2c510`.

Only these five paths are added to that union:

1. `tests/fixtures/runtime-compose.mjs`
2. `tests/fixtures/runtime-compose-main.mjs`
3. `tests/unit/runtime-compose.test.mjs`
4. `docs/cloud/RUNTIME-COMPOSE-1.md`
5. `docs/cloud/handoff/RUNTIME-COMPOSE-1.md`

The workspace is an exactly reconstructed source subset, not a full checkout. Unchanged files were recovered only from the fixed base through the authorized connector, then checked against the base inventory's Git blob IDs. The coordinator's complete-tree reconstruction records the final hashes independently. Both source capability matrices remain byte-identical to the base and empty. No GitHub, integration, universal-hud or main mutation was performed by the implementer.

## Test construction and owned API

The fixture helper's only CLI is `node tests/fixtures/runtime-compose.mjs --check-runtime-build`; unknown arguments refuse. Its exported functions are test-only and do not add a product API.

The emitter transforms exactly the 18 production modules enumerated in the brief with Node's builtin `stripTypeScriptTypes`, mode `transform`. The unchanged runtime-build regression additionally permits its two named test modules. It records input Git blob/SHA-256, generated path/SHA-256, Node version and mode. Entire source files and relative imports are retained. Static runtime imports are checked against the finite graph and Node builtins; dynamic imports, require calls and loader hooks are refused in that graph. The unchanged production wrapper retains its one fixed import of the synthetic main at the normal installed main path.

The synthetic main uses the production configuration validator, Linux process reader and registration function with an explicitly non-authoritative memory registry. It calls the no-override factory, reports physical PID/start relationships without exporting raw PID-domain machine identifiers, and emits exact synthetic request/expectation/matcher results. It does not invoke the production preparer, DelegationService, ledger, supervisor, whoami/report or task resume.

The fixture's positive `dirty: false` is merely a simulated clean-manifest input. Its source emission records are independent of this claim. Unexecuted anchors and dependency canaries are not a distributable package closure.

## Meaningful assertions

- A installs through preview/apply and starts via native parent → installed shim → unchanged wrapper → synthetic main → fixed-root factory. Both integrity verifiers accept; native parent/bootstrap/build are observed; empty cells refuse.
- B differs only in the four excluded capability files. Full manifest digest changes while build ID stays stable. Exact synthetic spawn/resume requests match test-only accepted cells.
- Restore selects unchanged A under a fresh generation. Reapply A is a no-op without generation changes. Stale generation-bound receipts and stale plans refuse.
- Prefix spaces/metacharacters, a CommonJS ancestor, unrelated working directory, literal argv including an empty argument, stdin and inherited fd3 are exercised.
- Dirty manifests, wrong MCP identity, missing managed anchors, incorrect dependency resolution fields, hash/mode drift, unlisted/missing files, every malformed capability path, duplicate members and malformed sibling cells refuse at the relevant production boundary.
- Valid cells only in the other three files cannot replace the fixed MCP managed-cell file. An ordinary resealed byte changes build identity and rejects old accepted cells.
- Source-shaped code stays uninstalled despite environment assertions, extra factory input fields and a supplied manifest path. Broken selector/ESM marker prevents main entry.
- A physical Node proxy cannot borrow native grandparent authority. Native parent and target version mismatches are separate; missing/script targets cannot use metadata to become native. Wrong source/profile selection refuses.
- Probe environments scrub HUD authority and stale Pi markers after profile overrides. Native probe receipts verify actual probe versions and ended processes; spawn/resume target discovery deduplicates independently of the parent probe.
- Accepted requests independently reject source, profile digest/fingerprint, executable path/version, operation, resume origin, host/layout, visible mode and partial coverage changes. All eight version tuple fields, accepted review, all five product results and empty-incomplete eligibility are checked through the production strict matcher.

## Checks and retained evidence

Final available checks on Node 24.22.1:

- `node --test --test-concurrency=1 tests/unit/runtime-compose.test.mjs`: PASS, 32/32, no skips.
- `node tests/fixtures/runtime-compose.mjs --check-runtime-build`: PASS, unchanged builtin-transformed source test, 70/70, no skips.
- `node --test --test-concurrency=1 tests/unit/runtime-package.test.mjs tests/unit/runtime-install.test.mjs`: PASS, 139/139, no skips. Actually rerun on this composition, not carried forward from the installer candidate.
- `node scripts/pack-cloud-preview.mjs --self-test`: PASS, tracked-source mapping, excluded trees and non-publishable manifest.
- `node scripts/check-cloud.mjs --self-test`: PASS, finite runner, failure receipt, owned timeout, path/environment isolation.
- `node --check`: PASS for all three new MJS files and all generated executed production modules.
- `bash tests/check-fixtures.sh` with exact fixture/unit/brief/handoff inputs: PASS.
- Exact-diff whitespace check over the five added paths: PASS. This is not represented as `git diff --check` on the reconstructed subset.
- Legacy shim syntax generation is unchanged; its existing source regression remains responsible for that check.

The first complete matrix passed 31/31 before the additional unknown-argument assertion and cleanup evidence hardening. Both the first successful run and final 32/32 run are retained.

Final command counts and exact tree hashes are recorded in the accompanying machine-readable coordinator evidence. Every available check identifies its command, exit, output hashes, deadline, direct-child birth identity and exit/pipe-close cleanup. The fixture retains its root and stops if cleanup is uncertain. Normal fixture roots are removed only after owned processes are confirmed ended. A partial or failed test is not promoted into PASS.

Two initial harness-only failures were retained: the first attempted ESM syntax checking before writing the test tree's ESM marker under the deliberate CommonJS ancestor; the second scanner incorrectly classified the registry's ordinary `register` method as a loader call. Both were fixed without changing the bounded module graph or any production source, before the positive/negative matrix ran.

No performance claim is made. Timings in logs are host-specific test observations, not production budgets or platform promotion.

## NOT_RUN and unchanged boundaries

- TypeScript type checking, normal root/build-test/MCP builds and Prettier: dependencies absent; registry restrictions honored, no replacement toolchain installed.
- Actual lockfile dependency materialization, `pack-runtime.mjs` distributable build/archive, and independently installed real-package smoke.
- Full managed-runtime unit/MCP service suites requiring the normal compiled graph/dependencies.
- Production preparer, DelegationService, ledger, supervisor, authenticated whoami/report and exact-session resume through the installed bundle.
- Node 22, real Codex 0.166.0 or other providers, live accounts, tmux/Herdr, Windows/WSL, user-host installation and performance qualification.
- Production capability publication and integration/main advancement.

The builtin emitter is not an alternative PASS for any NOT_RUN item. These commands were not attempted on the composed tree merely to repeat known dependency/provider blockers.
