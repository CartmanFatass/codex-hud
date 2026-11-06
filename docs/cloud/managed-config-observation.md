# Codex app-server configuration evidence

This opt-in increment observes `config/read` on one explicitly launched
`CodexAppServerTransport` connection. It does not launch a thread or turn, call a
provider, write configuration, discover accounts, or qualify managed execution.
It is part of task 5, not completion of cross-harness effective configuration.

## Pinned interface and product path

The selected official schema is
[`openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d`](https://github.com/openai/codex/tree/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript).
The generated `v2/ConfigReadParams.ts`, `ConfigReadResponse.ts`, `Config.ts`,
`ConfigLayer.ts`, `ConfigLayerMetadata.ts`, and `ConfigLayerSource.ts` define the
wire types. `ReasoningEffort.ts` at this pin is **string**, not a closed enum;
`v2/SandboxMode.ts` is the three-value enum `read-only`, `workspace-write`,
`danger-full-access`. The pin selects a parser contract, not the installed CLI's
version or executable identity.

After `await transport.initialize()`, call
`await transport.configRead({ cwd: explicitAbsoluteDirectory, includeLayers: true })`.
The observer also exposes `configRead(id, options)` for its existing byte seam.
Only `cwd` and `includeLayers` are serialized. `cwd` is required, absolute,
nonempty, control-free and at most 4096 UTF-8 bytes; `includeLayers` defaults true.
The helper waits for initialization acknowledgement and does not add a generic
request API. Existing thread start/resume and `snapshot()` shapes stay unchanged.
`configurationSnapshot()` is the additive redacted latest-attempt receipt.

The demo and new tests instantiate the actual product transport with
`process.execPath` and `tests/fixtures/codex-config-server.mjs`. The recorded wire
must be exactly `initialize`, `initialized`, `config/read` for a single read. No
real Codex executable, user home, account, provider, CLI permission or interactive
login is needed to exercise this product seam.

## Evidence, privacy and bounds

The schema-1 receipt includes the selected protocol commit, request sequence,
`qualification: not_qualified`, connection-only scope, and the SHA-256 of the exact
requested cwd UTF-8 bytes. That fingerprint is a local request-comparison hint;
it does not resolve symlinks, prove a project root or bind any runtime identity.
It contains no plaintext cwd. It is not a digest of the raw configuration.

Exactly four effective fields are selected: `model`, `model_provider`,
`model_reasoning_effort`, and `sandbox_mode`. Each distinguishes known, unknown
(missing/null) and invalid values. Null is retained as unknown with `value: null`;
zero, false, objects and unrecognized sandbox enums are never coerced. Selected
strings are nonempty, control-free and at most 256 UTF-8 bytes. Unknown nonempty
reasoning strings are valid observations because the pinned type is open.

Each selected origin copies only a recognized source type and a nonempty,
control-free version string of at most 128 UTF-8 bytes. Required source members
are checked against the pin, then omitted: paths, domain/key, profile, enterprise
IDs and descriptions are never copied. Source types are `packagedDefaults`,
`mdm`, `system`, `enterpriseManaged`, `user`, `project`, `sessionFlags`,
`legacyManagedConfigTomlFromFile`, and `legacyManagedConfigTomlFromMdm`.
Unknown sources yield fixed partial reasons, not their arbitrary type text.

At most 64 origin keys and 32 layers are accepted. Inventory has only bounded
index, projected source/version, and disabled boolean; disabled-reason text and
`layer.config` are never exposed. Missing/null layers are unavailable if requested;
`includeLayers: false` explicitly marks inventory omitted. Omitted inventory
never implies complete project/managed coverage. Missing origins are partial;
malformed top-level config/origins/layers or malformed layer envelopes are
unavailable. Field/source failures remain partial with fixed reason codes.

Unrelated extension keys, env values, credentials, instructions, raw config,
layer contents and error bodies are not cloned, stored, hashed, logged or
returned. The existing parser holds transient bounded JSONL bytes only. This is
an allowlist projection, not a general secret detector: selected value/version
strings are the peer's declared evidence, not independently trusted facts.
The synthetic sentinel checks cover ignored env, API-key, instruction, source
identity, disabled-reason and error-body positions.

## Correlation and failure

Only a correlated successful response produces available/partial facts. Every
attempt clears the previous receipt before dispatch; invalid/refused attempts
are unavailable. Each promise receives its own receipt, including when responses
arrive out of order. The snapshot follows the highest request sequence, so an
older success cannot overwrite a later pending/failed request. Returned receipts
and snapshots are independent copies. Historical successful receipts held by a
caller are not refreshed by another attempt or by shutdown.

Read errors reject with fixed messages. A malformed response cannot become an
empty effective config. Wrong/duplicate IDs, malformed frames, timeout, EOF or
unsupported server requests never reuse old facts or trigger a retry/approval.
A same-chunk protocol failure invalidates pending config receipts before later
lines can commit. The existing 8-pending/256-used-ID caps, serialized writes,
64 KiB frame and 4 MiB connection limits, deadlines, TERM/KILL and
`reaped: false` uncertainty are retained. No reconnect or retry is added.

## Run and record honestly

With a complete checkout and normal lockfile-installed dependencies on supported
Node 22.13+ or Node 24, from the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run build:test
node --test dist-test/tests/unit/codex-app-server.test.js dist-test/tests/unit/codex-app-server-transport.test.js dist-test/tests/unit/codex-config-observation.test.js
node scripts/demo-codex-config-observation.mjs
```

Use temporary `HOME` and `HUD_HOME` for the command shell. The fixtures and demo
also explicitly isolate their owned children. The new suite covers full/sparse/
null values, type/enum failures, provenance and bounds, exact request bytes,
reordered concurrency, stale-failure refusal, sentinel redaction, omitted layers,
malformed envelopes, frame/connection limits, EOF, deadline, approval refusal,
ID reuse, cleanup uncertainty and refusal to treat a receipt as a capability cell.
Existing observer and transport suites run unchanged. The cleanup-uncertainty
case suppresses signals only for its owned synthetic child, then explicitly kills
and reaps that exact child in `finally`; it does not alter the production seam.

Report commands as PASS, FAIL or NOT_RUN against the exact source tree. If npm
registry access/dependencies or a complete checkout are missing, record the
blocker and continue source review plus MJS syntax/diff/blob checks. Do not borrow
a compiler, strip TypeScript, run tests against a fake-only duplicate parser, or
relax the runtime gate to manufacture a green result. These are development
verification limits, not reasons to wait for a real account to implement the API.

Required independent labels:

- `OFFICIAL_SCHEMA_PINNED`
- `SYNTHETIC_CONFORMANCE_PASS`, `FAIL` or `NOT_RUN`, from the actual run
- `REAL_CODEX_CONFIG_OBSERVATION_NOT_RUN` until explicitly observed
- `MANAGED_CONFIGURATION_BINDING_NOT_IMPLEMENTED`
- `PRODUCTION_CAPABILITY_UNVERIFIED`

## Remaining trusted composition

This receipt does not establish caller identity, downstream account,
authorization, production eligibility, or that a separate `codex exec` process
uses the same effective settings. Capability manifests and launch/profile gates
are untouched; arbitrary receipt data cannot serve as a verified capability cell.
Claude and Pi coverage remains independent and unpromoted.

A future trusted composition would need exact source identity, requested/resolved
cwd evidence, selected profile and environment/configuration inputs, executable
identity/version and matching protocol evidence for the actual launched process.
It must compare those inputs explicitly and preserve unknown/mismatch outcomes;
matching four values or their cwd fingerprint is insufficient. No such binding
adapter or permission/capability grant is implemented here.
