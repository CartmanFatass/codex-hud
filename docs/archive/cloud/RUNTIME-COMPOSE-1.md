# RUNTIME-COMPOSE-1: offline installed-runtime composition

## Objective and evidence boundary

Compose the reviewed managed-runtime and installer candidates on an isolated, non-main candidate. Verify the common manifest, actual installer selection and generated shim, fixed installed managed-runtime module path, and physically observed native direct-parent identity.

This is **SIMULATED installed-startup composition**, not a real distributable smoke or production capability qualification. The executed production logic must come from the pinned source. Do not copy or replace its verifier with `verify: () => true`.

No new diagnostics feature, production configuration interface, supported profile, capability cell, registry access workaround, or integration/main update belongs to this package.

## Immutable inputs

Repository: `CartmanFatass/codex-hud`.

- Base commit: `ba6887ccddc9332971985113f9862a29146d13d1`
- Base tree: `a9665e6856d80e756cf050821b9400d3f0f3085c`
- Managed candidate: `1a49cccb4201c7042d5bf3c9733bfdd53181daed`
- Managed tree: `c5ce8f29435f62748be477627773b7130eed3640`
- Installer candidate: `c6ecf74f3ec56868d1388022be9081d76a3d252d`
- Installer tree: `161cfb05bbbd99fbd096941807f66cf27234f709`
- Untouched union tree: `1c85d206c6d6d68ee6acdfc0fe7b1175d2c2c510`

Both candidates have the stated base as their sole parent. Their 15 and 10 changed paths do not overlap. The coordinator's `initial-composition-identity.json` records the verified union and per-file identities.

The working source snapshot is reconstructed, not a full checkout. Its directory name or surrounding Git repository is not proof of source identity. Missing unchanged files must be recovered from the fixed base through the authorized GitHub connector and verified against the retained base inventory. Do not substitute files from another checkout.

Retain the untouched union snapshot. Record every implementation delta against it. Before publication, reconstruct and verify the complete resulting tree and read back the published candidate's commit, tree, parents, and changed paths.

Applicable instructions are `AGENTS.md`, the current cloud-development handbook and roadmap, and the existing identity/capability contracts. Historical local-only prohibitions do not prohibit explicitly labelled simulation; production gates remain unchanged.

## Ownership

One implementer owns these new files:

- `tests/fixtures/runtime-compose.mjs`: finite source emitter, joint-bundle construction, bounded process runner and regression entrypoint.
- `tests/fixtures/runtime-compose-main.mjs`: explicitly synthetic startup driver installed at the fixture's MCP main path.
- `tests/unit/runtime-compose.test.mjs`: composition assertions.
- `docs/cloud/RUNTIME-COMPOSE-1.md`
- `docs/cloud/handoff/RUNTIME-COMPOSE-1.md`

Use the existing `tests/fixtures/managed-native-codex.c` unchanged for native parent and version fixtures.

Preserve both existing fixture families. The installer fixture intentionally permits dirty bundles and has insufficient managed-runtime anchors; the managed fixture lacks the installer's command/helper closure. Neither is a joint positive fixture.

No production edit is required merely to reconcile those fixture differences. If the new test demonstrates an actual wiring defect, make only the smallest contract-preserving correction in the affected candidate-owned file, record the reproduction, and include it in fresh review. Do not broaden this into schema unification, dependency redesign, new runtime overrides, or cleanup/refactoring.

The coordinator owns publication and final review records. This package does not advance integration, universal-hud, or main.

## Bounded offline emitter

Use Node 24.22.1's existing builtin:

`stripTypeScriptTypes(source, { mode: 'transform' })`

This is syntactic test emission. It performs no TypeScript type checking and does not certify compatibility with the project's compiler options.

Allow exactly these 18 production source modules:

1. `packages/hud-mcp/src/managed-runtime.ts`
2. `packages/hud-mcp/src/process.ts`
3. `packages/hud-mcp/src/io.ts`
4. `packages/hud-mcp/src/errors.ts`
5. `packages/hud-mcp/src/config.ts`
6. `packages/hud-mcp/src/registry.ts`
7. `packages/hud-mcp/src/pi-host.ts`
8. `src/cli/capability.ts`
9. `src/core/capabilities.ts`
10. `src/core/canonical.ts`
11. `src/core/capability-manifest.ts`
12. `src/core/identity.ts`
13. `src/core/runtime-build.ts`
14. `src/core/launch/fingerprint.ts`
15. `src/core/process-domain.ts`
16. `src/core/link/limits.ts`
17. `src/core/capacity.ts`
18. `src/harness/pi/delegation-context.ts`

The last module is present only because the existing registration module imports Pi host support. The scenario does not run a Pi integration.

Requirements:

- Transform entire files without handwritten type removal, function extraction, import rewriting, monkeypatching, or loader hooks.
- Retain relative `.js` imports and the production output layout.
- Check the emitted runtime import closure. Every executed import must resolve to this allowlist or a Node builtin. Unexpected imports stop the run.
- Record Node version, emitter mode, input Git blob and SHA-256, output path and SHA-256, and any implementation delta.
- Write generated JavaScript only beneath the test-owned temporary root, never into working `dist`, production artifacts, or a committed dependency directory.
- No `npm ci`, mirror, alternate registry, unrelated `node_modules`, external transpiler download, or executor change to evade restrictions.

For the unchanged runtime-build regression only, additionally transform:

- `tests/fixtures/managed-native-build.ts`
- `tests/unit/runtime-build.test.ts`

Place these and their required source modules in a separate temporary source-shaped tree. Run the unchanged test module there; identify this as builtin-transformed source testing, not the normal compiled suite.

If this bounded emitter cannot execute the allowlisted graph unchanged, stop and report the exact failure rather than expanding into a general build replacement.

## Joint simulated bundle

Construct a new fixture from the union of the installer's `REQUIRED` paths and the managed verifier's `MINIMUM_RUNTIME_FILES`.

The fixture must contain:

- The actual installer entrypoint and its three production helpers.
- The unchanged production `packages/hud-mcp/bin/hud-mcp.mjs` wrapper.
- Source-derived production managed-runtime modules at their normal MCP output paths.
- The synthetic main driver at `packages/hud-mcp/dist/packages/hud-mcp/src/main.js`.
- Correct root and MCP identities: `codex-hud` and `@myhud/hud-mcp`, both ESM.
- The exact dependency descriptor shapes and resolution entrypoints required by the managed verifier.
- All four capability JSON files, initially valid and empty.
- Private directories and the manifest's exact private file modes.

Unexecuted command/helper/supervisor anchors and dependency entrypoints may be deterministic fixture canaries. Mark them explicitly **SIMULATED, not distributable dependencies**. Executable JavaScript canaries should throw if loaded. The executed graph must not import them; successful startup plus the recorded import closure must establish that they were not used as functioning dependencies.

Do not include those canaries in a real runtime archive or claim that matching package names/versions proves dependency materialization.

The fixture's manifest must clearly identify synthetic provenance and no production qualification. Its positive `dirty: false` is an input to the simulated clean-bundle case, not a claim that the reconstructed working snapshot was built cleanly. Keep actual source provenance in a separate evidence record.

## Required positive path

Run this real chain:

`owned synthetic native codex → Node executing installed PREFIX/bin/hud-mcp → generated production selector/shim → unchanged production hud-mcp wrapper → synthetic main → production createManagedNativeRuntime`

The native C fixture's driver is the installed shim, not a checkout entrypoint. Invoke from an unrelated working directory, with a private prefix containing spaces and shell metacharacters, beneath a CommonJS ancestor.

The synthetic main must:

- Use production `validateDelegateConfig`.
- Use production `LinuxProcessReader` and `registerCaller`, with `MemoryCallerRegistry` as the explicitly non-authoritative fixture registry.
- Call production `createManagedNativeRuntime` with no root/helper override.
- Construct clearly synthetic capability requests for matching tests. This does not exercise the production launch preparer.
- Report the observed selected release, wrapper/module paths, PID/PPID/start identities, startup result, exact verification results, and bounded probe receipts.
- Never invoke `DelegationService`, a real provider, or a task supervisor.

### A → B → A sequence

1. Create bundle A with empty capability manifests.
2. Call the actual adjacent installer CLI for preview and apply using the returned plan digest.
3. Launch A through the native-parent/installed-shim chain.
4. Assert that both manifest verifiers accept its integrity, the fixed-path factory observes a non-null build ID and the direct native parent, but capability verification returns `capability_unverified`.
5. Obtain the production runtime's expectation for the synthetic spawn/resume requests.
6. Construct bundle B outside the installed prefix by changing only fixture capability JSON. Insert exact test-only cells with all required result/review fields labelled SIMULATED. Reseal using the same manifest format.
7. Assert B has a different full manifest digest but the same runtime build ID, because only the four declared capability files are excluded from that build ID.
8. Preview/apply B through the actual installer. Launch through the same installed shim and production factory. The exact synthetic requests must match.
9. Restore B's apply receipt through the actual preview/restore CLI. Confirm selection returns to unchanged A under a fresh generation and capability verification again refuses.
10. Confirm same-package no-op preserves selection/generation, and stale generation-bound receipts/plans remain refused.

Never edit an installed release to manufacture the positive case.

Assert that the synthetic main's PPID is the recorded native fixture PID, with matching physical start/namespace/source observations. `process.argv[1]` must be the selected production wrapper, and the managed module must execute from:

`PREFIX/releases/DIGEST/packages/hud-mcp/dist/packages/hud-mcp/src/managed-runtime.js`

Also assert literal argument, stdin and inherited descriptor preservation through this joint chain. Existing installer regressions retain responsibility for their broader signal and native-entrypoint lifecycle matrix.

## Mandatory negative assertions

Use isolated cases and the actual production verifier. Do not regenerate an accepted cell after a negative mutation.

### Manifest and installed-root boundaries

- Dirty bundle: installer integrity acceptance may remain valid, but managed runtime observation must refuse.
- Wrong MCP package identity, missing managed anchor, or wrong dependency resolution fields: managed observation refuses.
- Payload hash/mode mismatch and unlisted or missing files: relevant production integrity checks refuse.
- Malformed capability JSON in any one of the four inventory paths invalidates runtime observation.
- Valid cells placed only in the other three files cannot replace the fixed MCP managed-cell file.
- Changing an ordinary payload byte and resealing changes the build ID; the old accepted fixture cell no longer matches.
- Duplicate JSON members or malformed sibling cells remain rejected by the strict managed parser.
- A source-shaped module location cannot obtain installed status through environment variables, extra input fields, or a supplied manifest path.
- Broken selector/module marker must prevent payload execution; assert no synthetic-main startup marker.

The two verifiers have different purposes. Do not “fix” their intentional asymmetry by weakening managed checks or by requiring the installer to grant capability eligibility.

### Parent and target identity

- A real Node proxy between the native fixture and installed shim causes parent observation/refusal. Do not fake this with an altered ProcessReader.
- Native parent version `0.165.0` cannot borrow a target's `0.166.0`.
- Native target version `0.165.0` cannot borrow a parent's `0.166.0`.
- Wrong selected source/profile cannot borrow the valid registration.
- Missing or script-based native executable does not become verified from metadata or environment assertions.
- Parent and target probes remain separate; target spawn/resume discovery may deduplicate only as the current implementation permits.
- Probe environments exclude HUD authority and stale Pi session/channel markers, including after profile overrides.

### Exact capability match

Starting from the accepted fixture request/cell, independently alter source ID, profile digest/fingerprint, executable identity, operation, resume origin, host/layout, visible mode, configuration coverage, and version tuple. Each must refuse.

Remove an accepted review, one required product result, or empty-incomplete status. Each must refuse.

These assertions establish matcher behavior only, not reviewed real-world evidence for those cells.

## Isolation, deadlines and cleanup

- Run cases serially.
- Use an exclusive private temporary root with isolated HOME, HUD_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and TMPDIR. Inherit no credentials, NODE_OPTIONS, NODE_PATH or loader configuration.
- Only compile the pinned synthetic C fixture using the existing `/usr/bin/cc`. Record compiler identity, argv, exit and output hashes.
- Bound compilation, installer invocations, native scenarios, output sizes and cleanup separately.
- Record PID and birth identity for every owned long-lived process. Signal only a still-matching owned process.
- Require both exit/reap and pipe-close evidence; a timeout or uncertain cleanup is not PASS.
- Do not reuse the existing runner's unconditional temporary-directory removal after an uncertain failure.
- If cleanup cannot be confirmed, preserve the root and receipts, stop later process cases, and report `UNKNOWN` plus exact owned identities.
- Remove only a verified test-owned root after all its processes and handles are settled.
- Never touch real provider homes, integration worktrees, user settings or unrelated processes.

Public evidence must not dump environment values, raw machine IDs, real transcripts or credentials. Process/domain comparisons can be asserted without exporting private host identity material.

## Commands and required records

Run with the pinned Node 24.22.1 and sanitized test environment:

```sh
node --test --test-concurrency=1 tests/unit/runtime-compose.test.mjs

node tests/fixtures/runtime-compose.mjs --check-runtime-build

node --test --test-concurrency=1 \
  tests/unit/runtime-package.test.mjs \
  tests/unit/runtime-install.test.mjs

node scripts/pack-cloud-preview.mjs --self-test
node scripts/check-cloud.mjs --self-test
```

The new fixture helper's `--check-runtime-build` command must run the unchanged runtime-build test through the bounded emitter described above, report its actual counts, and refuse unknown arguments.

Also run:

- `node --check` on new/changed MJS and generated executed modules.
- `bash -n` on the generated legacy shim if its generation changes.
- Fixture hygiene on the exact candidate inputs.
- `git diff --check` on a genuine candidate checkout, or an explicitly named exact-diff whitespace check for the reconstructed snapshot. Do not label the latter as a Git command run.

Record each command, source/tree identity, environment/tool versions, outcome, count, logs, deadline and cleanup evidence. Do not carry the installer candidate's prior 139/139 result forward as a new composed-tree run.

Hosted cloud CI covers only its actual configured list. An ordinary green run does not cover these new composition tests unless their commands appear in that run's logs.

## Required NOT_RUN list

Unless separately obtained and verified, retain:

- TypeScript type checking and normal root/build-test/MCP builds.
- Prettier formatting checks.
- Actual production-dependency materialization from the lockfile.
- Actual `pack-runtime.mjs` distributable build, archive and independently installed package smoke.
- The full managed runtime unit/MCP service suites requiring the normal compiled graph and real package dependencies.
- Production launch-preparer, DelegationService, ledger, supervisor, authenticated whoami/report and exact-session-resume joint execution through the newly installed bundle.
- Node 22 execution.
- Real Codex 0.166.0 or another provider/client.
- Live accounts, tmux/Herdr/Windows/WSL qualification, performance promotion and user-host installation.
- Production capability publication and integration/main advancement.

Distinguish pre-existing blocked attempts from commands not attempted on this composed tree. The builtin emitter is not an alternative PASS for any item above.

## Completion and stopping conditions

Complete when:

1. The two immutable candidates are composed without unrelated changes.
2. The finite positive/negative matrix and applicable available regressions pass.
3. Evidence accurately separates production source execution, synthetic drivers/canaries and unrun package/service qualification.
4. Both source production capability matrices remain byte-identical and empty.
5. A fresh final Oracle reviews the actual delta and evidence.
6. The coordinator publishes the authorized independent candidate and verifies its remote identity without advancing integration.

Permit at most two focused fix/review rounds. Stop earlier for an access denial, missing required input, unconfirmed cleanup, unresolved relevant regression, or a necessary contract/gate/profile change.

If a fix would allow indirect parent authority, user-selected runtime manifests, simulated production verification, looser identity matching, changed capability requirements or a new supported profile, write an owner question instead. Do not implement that change inside this package.
