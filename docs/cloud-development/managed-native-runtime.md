# Managed native runtime composition

This package closes a startup composition gap. It does **not** enable ordinary managed tasks, add a supported profile, certify a provider, or publish a production capability cell. Both source capability files remain empty and unchanged. Source checkouts, missing/dirty/invalid bundles, and ordinary empty-cell installations return `capability_unverified`. Read-only MCP tools remain available. An already authorized idempotent result still replays before new-capability admission, as contract 02 requires.

## Narrow runtime boundary

The existing main entrypoint calls `createManagedNativeRuntime` once. It reads the fixed installed root's `RUNTIME-MANIFEST.json`; no environment, MCP metadata, profile field, tool argument or production cell-file selector can replace it. The trusted `ManagedNativeRuntime` constructor permits an isolated root and a copied/frozen three-path helper tuple for explicitly **SIMULATED** tests. The production factory accepts neither override. These seams are not user configuration interfaces.

Startup measures the actual Node version, platform, architecture and kernel release. The selected Codex source/profile must match the current registration. The calling native Codex process must be the direct parent, with matching PID/start/domain/source before and after an independently bounded native ELF `--version` observation and again after target discovery. Only version 0.166.0 is considered here. MCP `initialize`/`clientInfo`, turn metadata, configuration version claims and target versions never supply the calling client's version. Registration is not caller authority: the existing resolver and service still validate each call's source, owner, scope and claim.

Targets retain existing `discoverExecutable` discovery, separately keyed by backend/operation and deduplicated only within target discovery. Probes use `launchProbeEnvironment`; HUD authority and stale Pi channel/session markers are removed after profile overrides. No wrapper or shell text is executed by the native version probe. Claude/Pi partial coverage, scripts, unknown targets, visible modes and shell templates cannot select this runtime's cell.

Only native Codex 0.166.0 headless argv, host `none`, layout `none`, and headless resume are admitted for matching. The topology is exactly:

`codex-direct-stdio/headless-argv-v1`

This does not claim that the supervisor uses no internal shell. Its existing fixed `/usr/bin/env`, `/usr/bin/mkfifo` and `/bin/sh` bootstrap files are independently observed by canonical path, bounded content SHA-256 and file identity. No helper functionality experiment is executed. The capability fingerprint is:

```text
digest({
  schema: 'managed-native-runtime-v1',
  target: request.profileFingerprint,
  parent: { sourceId, profileDigest, nativeExecutableIdentity },
  architecture,
  bootstrapFiles
})
```

The parent profile digest comes from the selected validated configuration. Target fingerprints retain existing command, executable identity, configuration and role/model/effort binding. Each complete key, source ID, fingerprint, topology and version tuple must match one strictly validated reviewed cell. A malformed or contradictory sibling invalidates the whole manifest. Duplicate JSON members and duplicate capability keys are refused. All five product checks, accepted review, and empty `incomplete` remain mandatory.

## Installed payload integrity

The manifest is an integrity/provenance record, not a publisher signature, license grant, or capability review. It requires schema version 1, repository SHA/tree, dirty flag, lockfile SHA-256 and entries. `dirty: true` cannot attest this runtime. The exact shared optional metadata whitelist is validated without treating its assertions as observed runtime facts. Entries have private modes `0600` or `0700`, safe relative ASCII paths, exact sizes and SHA-256. Directories are private `0700`. Symlinks, path escapes, duplicate entries, special files, unlisted/missing payload files and mismatched modes/content refuse. Limits are 5,000 payload files, 2 MiB per file, 50 MiB total, and a separate 2 MiB manifest limit.

The loader also requires fixed runtime entrypoint/supervisor/preparer anchors and the three dependency entrypoints, then independently checks the root/MCP package identities, fixed Node resolution fields and in-root dependency resolutions for `@iarna/toml@2.2.5`, `chokidar@5.0.0`, and `readdirp@5.0.0` package descriptors. Nested, ancestor-fallback and fourth-party dependency resolution cannot provide these facts. The default factory also binds its own canonical executing module to the observed installed root. These minimum anchors do not prove the entire installation can run; complete builder closure and an independently materialized package smoke remain separate evidence.

The build identifier is `sha256:` plus SHA-256 of UTF-8 JSON:

```text
['hud-runtime-build-v1', sortedEntries.map(e => [e.path, e.mode, e.bytes, e.sha256])]
```

Sorting is ASCII/JS code-unit order. Exactly four files are excluded from this digest to avoid a capability/build circular dependency:

- `dist/core/launch/codex-cells.json`
- `dist/core/launch/managed-cells.json`
- `packages/hud-mcp/dist/src/core/launch/codex-cells.json`
- `packages/hud-mcp/dist/src/core/launch/managed-cells.json`

They remain in the full integrity inventory and are independently strictly parsed. Main selects only its fixed compiled managed manifest. Payload hashing, bootstrap hashing and version probes occur at startup, never inside accepted-intent transactions or the existing delegation admission path (250 ms deadline with a 100 ms cumulative contention allowance). Verification is bounded in-memory matching. These observations do not constitute atomic protection against malicious same-UID mutation after observation.

## Verification and remaining promotion work

The new suites use temporary HOME/HUD_HOME, an owned compiled C fixture named `codex`, synthetic version output, a synthetic inventory with minimum runtime anchors and inert dependency stubs, and constructor-only accepted cells. The positive service simulation uses the actual strict matcher, DelegationService, existing hud-run supervisor, physical registry/resolver, authenticated whoami/report, scope termination, request-key replay and original SessionRef resume. It never substitutes `verify: () => true`. The startup probe counter counts discovery attempts; native fixture receipts separately identify actual `--version` processes. Process start/end/deadline and startup elapsed/byte/probe observations belong to the test evidence, not a production performance claim. No model or provider request is made.

The shared installer/runtime interface can be developed with these fixtures even when dependency materialization for a real distributable is blocked. Such a simulation is not joint acceptance of a real installed package. An installed hud-mcp shim must preserve the direct native parent, not create a proxy-parent exception; the actual installed-shim joint smoke remains separate. See the package's external check receipts for PASS/FAIL/NOT_RUN; documentation does not declare its own acceptance.

After implementation, an owner-selected actual native Codex 0.166.0/Linux source/profile still needs the applicable B14 identity, input, scope, receipt, single-submission, headless, budget and review evidence before publication of that exact cell. Client wait timeout remains unverified, and local-user resume and `hud claude` refusal behavior are unchanged. Visible/cancel, close/send/ask, real provider accounts, Claude/Pi configuration completion, Pi native attestation and host installation are outside this package.
