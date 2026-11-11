# R6b retirement design

**Recommendation:** Keep the v1 history codec, delete the obsolete launch/control graphs after a fail-closed owner drain check, and leave only herdr/owned-pi control plus the narrow Jev runtime.

Observed tree: `dd6dd1e`; the orchestrator confirmed its changes since brief base `2262276` are documentation-only. Counts below are physical lines, including comments/blanks, not executable LOC. Re-census after A8 and TEST-SLIM: some listed tests are concurrently being moved/consolidated. No owner-home inspection, runtime drain, or timing experiment was performed.

## 1. Findings and decisions

- **The old host is not yet dead.** Unset `HUD_MCP_SURFACE` selects it (`packages/hud-mcp/src/surface.ts:8–11`); `main.ts:56–57` constructs the launch-capable client. `src/managed/host-entry.ts:14–17` loads all three native adapter factories plus the Python Jev bridge. Remove this entry graph, not just its public tool names.
- **The replacements do not need it.** `packages/hud-mcp/src/role-main.ts:31–39` constructs the role facade and owned Jev executor. `src/roles/facade.ts:695,777,858,1499–1500,1667–1668` refuses legacy pi mutation; new pi dispatch is v2. CLI recipes for Codex, Claude and Grok remain in `src/roles/launch.ts`; `pi-role` remains a routing recipe ID, not permission to execute that PATH program (`src/roles/adapters.ts:6–13`).
- **History currently imports execution.** `src/collectors/native-calls.ts:6–9,117–149,174–177` imports the bridge and host client and probes their sockets. Extract/retain their existing record decoders; make production history collection file-only after drain. Never translate a historical relation into a new job or a fresh success state.
- **There is a real WP0 blocker.** `tests/unit/b11-cli.test.ts:413–436,607–662` requires durable legacy cancellation and resume, not just history. Removing `hud run` and its writer graph cannot preserve those assertions. A recorded owner exception is necessary; do not disguise this as test consolidation. The rest of that mixed file, all unaffected WP0 mappings, and every visual baseline stay.
- **Keep v1 decoding.** This was also confirmed by orchestrator q1. Keep strict v1/v2 receipt discrimination, STATUS/SESSION/QA observation and historical association display. Stored v1 executable/reaper paths are data only. Unsupported versions and all legacy mutations continue to fail closed. Do not require an obsolete executable to exist merely to display history.

## 2. Removal inventory and disjoint slices

Notation: `name (N)` is a file and its current line count. A directory heading supplies the path prefix. “Delete” means the entire file and all its cases unless the text explicitly says **trim/keep**. Reasons apply to every file in their row. These are conditional dead graphs: external entrypoints become dead only after their clients are switched and their work drained.

Use four file-disjoint slices. P, T and W can merge separately; L is the integrated runtime retirement. Do **not** split L into host deletion followed by a broken collector/package build. Its shared wiring, reader extraction, dependent test changes and deletion belong in the same merge. If a smaller implementation is desired, stage internal commits, not independently shippable half-retirements.

### P — external pi prototype residue

**Evidence:** repository grep finds no production callers of `dispatchEnv`, `launchDispatch`, `reapDispatch`, `orchestratorPane`, `piRoleArgv`, `parsePiRoleArgs` or `appendPiOverrides`; their remaining callers are the tests listed here. PR4 already refuses external execution. `piRoleName`, however, still has a facade caller (`facade.ts:756`): keep it or simplify that validation in this same slice, not by deleting `launch.ts`.

| Action/path | Inventory |
|---|---|
| Delete `tests/fakes/` | `pi-dispatch.mjs (190)`, `pi-role.mjs (28)` |
| Delete `tests/unit/` | `pi-dispatch-conformance.test.ts (541)` — external Fishpref dispatcher/reaper conformance, including the `parsePiRoleArgs` matrix |
| Trim, not delete | `src/roles/pi-dispatch.ts (185)`: remove unused environment/execution stubs and their obsolete timeout constants; keep codec, bounded file reader and SESSION parser. `src/roles/launch.ts (153)`: remove external pi argv helpers, their private constants and now-unused errors; keep all non-pi launch recipes. |
| Mixed tests | `tests/unit/role-facade.test.ts`: remove fake-pi installation and the three `parsePiRoleArgs` assertions at 814–816, not the non-pi/Jev tests. `pi-owned.test.ts:596–599` and `pi-dispatch-facade.test.ts:618–621`: remove calls to deleted throwing stubs, **retain public-facade legacy-refusal assertions**. |
| Documentation | `integrations/skills/hud-delegate/SKILL.md`: remove “fallback Pi”/external-reaper wording; preserve main-session sequencing and grace/QA semantics. |

Keep `pi-dispatch-facade.test.ts`, `pi-dispatch-status.test.ts`, `pi-dispatch-wake.test.ts`, `role-wait.test.ts` and all `pi-owned*` tests. Their names are historical; their current code exercises owned execution or its shared observation protocol. In particular, PR4's facade file now tests hostile PATH launchers, release pinning and legacy read-only drain, not fake-dispatch execution (`pi-dispatch-facade.test.ts:207,318,454,573,586`).

### T — disconnected transport experiments

**Evidence:** grep/import walk finds the following six source modules reachable only from one another, their corresponding tests and demo scripts; none is imported by the roles, owned-pi or Jev runtime graph. Do not confuse them with native transcript readers or the still-live Codex app-server adapter, which retires in L.

| Directory | Delete |
|---|---|
| `src/harness/codex/` | `exec-json.ts (147)`, `exec-transport.ts (179)` |
| `src/harness/claude/` | `print-json.ts (133)`, `print-transport.ts (190)` |
| `src/harness/pi/` | `rpc-observation.ts (159)`, `rpc-transport.ts (214)` |
| `scripts/` | `demo-codex-exec.mjs (25)`, `demo-codex-exec-transport.mjs (36)`, `demo-claude-print-transport.mjs (38)`, `demo-pi-rpc.mjs (19)`, `demo-pi-rpc-transport.mjs (37)` |
| `tests/unit/` | `codex-exec-json.test.ts (94)`, `codex-exec-transport.test.ts (193)`, `claude-print-transport.test.ts (222)`, `pi-rpc-observation.test.ts (75)`, `pi-rpc-transport.test.ts (77)` |
| `tests/fixtures/` | `codex-exec/completed.jsonl (7)`, `codex-exec-transport/synthetic-client.mjs (65)`, `claude-print-transport/synthetic-client.mjs (96)`, `pi-rpc-transport/synthetic-pi.mjs (48)` |

T owns `scripts/check-cloud.mjs (395)`: remove the retired transport/demo and old `tests/workbench` selections, including the app-server demo selection scheduled for L. This historical runner is not the current default suite. Do not remove similarly named **product UI** `workbench*.test.ts` selections. L's legacy tests still run in the default suite until L removes them. Record the dead-code test exception rather than quietly weakening a gate.

### W — old ledger execution workbench

**Evidence:** `scripts/workbench/unified-world.mjs:7–19,215,276` and `vertical-runner.mjs:7–19,68–81` exercise `DelegationService`, `hud-run`, ledger claims and synthetic reports. Their consumers are `tests/workbench/*`, not production entrypoints. They are not the panel's `src/render/workbench*` implementation.

| Directory | Delete |
|---|---|
| `scripts/workbench/` | `pi-channel-state.mjs (23)`, `pi-extension-context.mjs (328)`, `pi-preparer.mjs (33)`, `synthetic-codex.mjs (25)`, `synthetic-handshake.mjs (45)`, `synthetic-pi-reporter.mjs (79)`, `synthetic-pi.mjs (62)`, `unified-paint.mjs (13)`, `unified-panel.mjs (88)`, `unified-runner.mjs (182)`, `unified-world.mjs (544)`, `unified.mjs (15)`, `vertical-runner.mjs (160)`, `vertical.mjs (13)` |
| `tests/workbench/` | `preparer.test.mjs (205)`, `pi-extension-context.test.mjs (475)`, `pi-channel-state.test.mjs (28)`, `vertical.test.mjs (195)`, `unified.test.mjs (179)`, `unified-paint.test.mjs (40)`, `unified-tty.py (44)` |

All cases in this lab go with it; current Pi evidence-channel/ordinary-session tests stay. Merge T before W because T owns the one shared historical runner edit.

### L — actual runtime/bridge/supervisor retirement (**owner-blocked WP0 change**)

L follows A8, TEST-SLIM, the owner activation/drain and P/T/W. Its deletion inventory follows. Shared/type-only/history exceptions are listed immediately afterward; a directory name is never blanket deletion authority.

**L1: detached native host.** Caller chain is `surface → main → NativeHostClient → host-entry → host-config → factories`; all execution consumers disappear in L. The app-server protocol files also have old transport tests/demo callers, removed here. The Python dependency belongs solely to `PythonJevBridge` (`src/managed/jev-host.ts:27–110`), not `src/jev`.

| Directory | Delete |
|---|---|
| `src/managed/` | `host-config.ts (120)`, `host-entry.ts (26)`, `host-ipc.ts (283)`, `host-wake.ts (205)`, `host.ts (341)`, `jev-bridge.py (90)`, `manager.ts (2)`, `store.ts (3)`, `wake-message.ts (33)` |
| `src/harness/codex/` | `managed-adapter.ts (361)`, `app-server-transport.ts (372)`, `app-server.ts (184)` |
| `src/harness/claude/` | `sdk-adapter.ts (405)` |
| `src/harness/pi/` | `rpc-adapter.ts (239)`, `native-rpc-transport.ts (179)`, `wake-extension.ts (232)` |
| Other | `integrations/pi/hud-wake.ts (5)`, `scripts/demo-codex-app-server-transport.mjs (26)` |

**L2: superseded ledger execution/supervision.** `src/cli/hud-main.ts:32–43 → cli/run.ts:4–7 → HeadlessRunControl/LedgerRunFactPort`, and `packages/hud-mcp/src/delegation.ts → core/launch/index.ts:14,30–31` are the production roots. The owned roles instead use herdr; owned process-stamp callers do not call group launch (`src/roles/pi-owned/runtime.ts:8`, `src/integrations/herdr/transport.ts:4`). Remove these roots, then their execution-only closure:

| Directory | Delete |
|---|---|
| `src/core/run/` | `cli.ts (95)`, `control.ts (887)`, `fake-port.ts (351)`, `ledger-port.ts (653)`, `port.ts (93)`, `group-leader.ts (91)`, `group-pipe.ts (48)`, `retirement.ts (328)`, `retirement-policy.ts (58)`, `retirement-evidence.ts (75)`, `runtime.ts (4)`, `visible-host.ts (21)`, `visible-process.ts (192)` |
| `src/core/launch/` | `index.ts (31)`, `types.ts (64)`, `supervisor.ts (72)`, `capability.ts (150)`, `codex-cells.json (5)`, `managed-cells.json (5)` |
| `src/harness/codex/` | `profile.ts (262)` — the old claim/run launch preparer, **not** the retained transcript adapter or role recipe |
| `src/harness/claude/` | `managed-launch.ts (240)`, `managed-command.ts (66)`, `managed-configuration.ts (209)`, `managed-role.ts (29)` |
| Other | `src/harness/pi/managed-launch.ts (370)`, `src/cli/run.ts (177)`, `src/cli/run-wait.ts (359)`, `bin/hud-run (7)`, `src/core/runtime-build.ts (455)`, `src/core/runtime-dependencies.ts (112)` |
| `packages/hud-mcp/src/` | `main.ts (142)`, `delegation.ts (626)`, `handshake.ts (176)`, `managed-runtime.ts (314)`, `managed-tools.ts (159)`, `jev-tools.ts (88)`, `ledger-registry.ts (73)`, `read-control.ts (495)`, `wake-drainer.ts (621)`, `wake-state.ts (92)`, `wake-registration.ts (63)` |

**L3: writer-only ledger closure.** The import walk finds these consumers in L2, each other, and legacy tests/fixture builders, not the owned role graph. History readers use `records.ts`, `runtime.ts`, `local-manager.ts`, and the read projections instead. Move necessary *fixture setup* off execution services before deleting their modules; do not delete history assertions to make imports pass.

| Directory | Delete |
|---|---|
| `src/ledger/` | `call-context.ts (263)`, `close.ts (357)`, `handshake.ts (483)`, `intents.ts (549)`, `reconcile.ts (446)`, `run-facts.ts (409)`, `supervisor.ts (336)`, `identity.ts (137)`, `events.ts (33)`, `locator.ts (82)`, `workspace.ts (20)`, `link-commands.ts (104)`, `index.ts (20)`, `delegation-read.ts (159)` |
| `src/core/wait/` | `index.ts (213)`, `hints.ts (30)` |
| `src/core/wake/` | `adapters.ts (237)`, `message.ts (35)` |

**Do not delete these mixed modules:**

- `src/managed/relations.ts (162)`: keep `NativeOwner`, `DirectRelation`, keys, validation and bounded `readRelations`; remove `RelationStore` mutations. `src/managed/jev-host.ts (270)`: reduce in place to `JevRelation` and `readJevRelations` (currently 113–120,130–177), or move those into `relations.ts` and delete the emptied file. `src/managed/types.ts (70)`: retain only passive native-reference/event shapes actually used by history. Relocate the small `HostMessage` type into this retained codec, not a stub host class.
- `src/core/run/process.ts (552)`: keep `currentDomain`, `readProcess`, `sameStamp`, `processState`; delete group launch/supervision functions after their last callers disappear. `process-census.ts (186)` still supplies `parseProcessStat` to `readProcess`; keep that parser, trim only group/zombie census machinery. Ordinary Pi, panel lifetime and owned workers still need process identity.
- `src/core/run/artifacts.ts (487)` and `launch-artifacts.ts (99)` have historical log/panel callers (`src/utils/delegation-log-view.ts:1`, `src/integrations/herdr/panel-host.ts:10`). Keep safe read/log validation; remove construction/write methods only after migrating fixture builders.
- `src/ledger/notify-events.ts (298)`: retain the passive `WakeRegistration`/`WakeDelivery` shapes used by `src/core/wake/projection.ts:3`, remove writers. Keep `core/wake/{binding,projection}.ts`: `core/link/wake-read.ts:4–5`, `core/link/tick.ts:14,787` still project historical wake facts.
- Keep read-only ledger/schema/export support, including `ledger/{runtime,records,local-manager,types}.ts`, `core/ledger-read.ts`, `core/link-ledger-read.ts`, `core/export-query.ts`, link/status projections. `ledger/{ledger,transaction,schema}.ts` are also used to build real historical fixtures; they are **not** whole-file deletions in this inventory. Remove their runtime writer entrypoints, not the means to test old databases. Do not migrate, compact or delete existing databases.
- Keep ordinary native foreground launchers `src/cli/{launcher,claude-launch,claude-configuration,claude-tmux,pi-launch,pi}.ts` and their still-used brief/fingerprint/message helpers. “No duplicate delegated executor” is not a ban on the user opening an ordinary native CLI. `core/launch/message.ts` is also read by the Claude transcript parser (`reader.ts:24`).

**L's wiring/config/build ownership:**

- `packages/hud-mcp/{src/surface.ts,bin/surface.mjs}`: unset and `roles` select `role-main`; reject obsolete/unknown selections, never silently reconnect legacy control. Keep the `hud-mcp` bin. `src/server.ts`: remove old body/delegate dispatch and budget branches; retain framing, cancellation, authenticated role dispatch and shutdown. `src/tools.ts`: retain any shared schema type/helper, remove old eight-tool schema/validator. `src/resolvers.ts`: retain shared call-resolution types and any independently used native evidence helpers, not old ledger claim resolution by habit. Do not remove `role-source`, `pi-channel`, `pi-host`, `process`, `lifetime`, ordinary-session evidence or worker extensions.
- `packages/hud-mcp/src/{config.ts,hook/record.ts}`: remove native-host factory exports and managed/Jev tool-name imports; retain ordinary Claude hook/config support still used by the foreground launcher. The A4 plugin is not the old native execution bridge.
- `src/cli/{hud-main.ts,runtime.ts}`: remove `hud run`, resume-service dynamic imports and writer access; retain export, history/cache, ordinary launch, roster, panel and shared parsing functions. **Retire `hud run wait` too.** It is not the lightweight owned `hud wait` (`src/cli/wait.ts`, `src/roles/job-wait.ts`), which stays.
- `src/collectors/native-calls.ts`, `src/core/link/view-model.ts`: history imports only passive codecs. No socket, subprocess, SDK, browser call, watcher or newly introduced timer on the history path; return recorded identity plus explicit unavailable observation. Existing native transcript collection remains separate. The current missing-host fallback supplies the intended presentation; do not invent terminal status.
- `package.json`, root lockfile, `scripts/{pack-cloud-preview.mjs,runtime-package/manifest.mjs,runtime-package/dependencies.mjs,runtime-package/update-dependencies.mjs,runtime-package/license-supplements.mjs}`, `THIRD_PARTY_NOTICES.md`: remove `hud-run` bin/inventory, old host spawned-entry and Python asset, old managed capability/output lists and SDK closure. Stop generating the retired `src/core/runtime-dependencies.ts`. Keep immutable old-release validation based on each release's own inventory, not today's reduced required list.
- Delete the now-unneeded `scripts/runtime-package/license-supplements/standardwebhooks-1.1.1-LICENSE.txt` only with its dependency removal. Other license notices follow the actual remaining lockfile.
- `tests/run-core.sh`, `tests/run-integration.sh` and non-WP0 probe invocations: remove retired execution commands, retain display/history/product checks. Clean **generated** build directories before validating so stale emitted JS cannot satisfy a deleted import.
- Old `scripts/local-validation/{claude.sh (22),codex.sh (31),pi.sh (26),setup-home.mjs (282),smoke-discovery.mjs (458)}` generate `native.json`/managed-tool configurations (`setup-home.mjs:241–242`, `smoke-discovery.mjs:10–20,408–411`). Retire them if A8 has replaced their scenarios; otherwise move their discovery assertions to A8's six-role artifact rehearsal, then delete. Do not keep provisioning obsolete clients.

**Dependencies:** remove root `@anthropic-ai/claude-agent-sdk` and its now-unreachable auto-installed peer/transitive/platform closure. The current generated runtime inventory has **107 entries; 104 retire**, leaving `@iarna/toml`, `chokidar`, `readdirp`; eight SDK optional platform entries also disappear from the lock/inventory exceptions. Verify the regenerated lock rather than hand-editing a dependency list. TOML remains used by routing/import/Codex config; chokidar remains used by the file watcher. `jev_ultrafast`/Python is an external old bridge prerequisite, not a root npm dependency: stop requiring it, do not uninstall anything on the owner's machine. Installed pi is still a user prerequisite, not a bundled SDK to prune.

### L tests: delete only retirement coverage

The following whole-file deletion list covers old control semantics; shared/history owners follow separately. TEST-SLIM may relocate individual cases before R6b: follow those cases, do not delete a newly mixed destination file.

| `tests/unit/` files | Lines |
|---|---|
| `managed-claude-sdk.test.ts`, `managed-codex-adapter.test.ts`, `managed-codex-transport.test.ts`, `managed-core.test.ts`, `managed-pi-adapter.test.ts`, `managed-pi-public-client.test.ts` | 815, 618, 79, 582, 374, 234 |
| `native-host-lifetime.test.ts`, `native-wake.test.ts`, `codex-app-server.test.ts`, `codex-app-server-transport.test.ts` | 295, 255, 138, 83 |
| `managed-capability.test.ts`, `managed-launch-artifacts.test.ts`, `managed-runtime.test.ts`, `runtime-build.test.ts`, `runtime-compose.test.mjs`, `claude-managed-launch.test.ts`, `pi-managed-launch.test.mjs` | 158, 111, 173, 212, 357, 370, 549 |
| `b19-adapters.test.ts`, `b19-drainer.test.ts`, `b19-hints.test.ts`, `b19-lifetime.test.ts`, `b19-registration.test.ts` | 461, 963, 343, 143, 105 |
| `b21-capacity.test.ts`, `b21-config.test.ts`, `b21-compat.test.ts`, `b21-notify.test.ts`, `b21-process.test.ts`, `b21-termination.test.ts` | 220, 95, 161, 191, 23, 576 |
| `b22-policy.test.ts`, `b22-process.test.ts`, `b45-handshake.test.ts`, `b45-launch.test.ts`, `b45-parent-offline.test.ts` | 30, 32, 280, 632, 237 |
| `b6-cancel.test.ts`, `b6-server.test.ts`, `b6-wait-status.test.ts`, `b6-performance.test.ts`, `b3h-production.test.ts`, `b3h-signals.test.ts` | 344, 325, 660, 18, 166, 367 |
| `int-ledger-run.test.ts`, `run-control.test.ts`, `run-control-kill-evidence.test.ts`, `run-light-leader.test.ts`, `run-resource.test.ts`, `run-visible-policy.test.ts`, `runz1-process.test.ts`, `ledger-processes.test.ts` | 952, 592, 653, 1764, 127, 112, 478, 335 |

| `tests/hud-mcp/` files | Lines |
|---|---|
| `authorization.test.ts`, `b20-advice.test.ts`, `delegate-list.test.ts`, `delegation.test.ts` | 132, 670, 321, 635 |
| `handshake.test.ts`, `handshake-benchmark.test.ts`, `headless-close.test.ts`, `host-entry.test.ts`, `int-ledger-registry.test.ts` | 260, 126, 1004, 71, 376 |
| `jev-tools.test.ts`, `managed-native-isolation.test.ts`, `managed-runtime.test.ts`, `managed-target.test.ts`, `resume-expected-run.test.ts` | 566, 168, 113, 462, 346 |

These files' unique guarantees are for the removed protocol, not grounds to keep it executable. Carry forward product guarantees, not SDK/claim/supervisor protocol matrices (see §4).

**Supporting fixtures/programs that go with those tests:**

- `tests/fakes/managed-codex-server.mjs (355)`; `tests/fixtures/native-managed-target/{claude.ts (80),pi.mjs (69)}`.
- `tests/fixtures/managed-native-{build.ts (79),codex.c (64),runner.ts (123),scenario.ts (537),target.mjs (127)}`; `runtime-compose.mjs (565)`, `runtime-compose-main.mjs (239)`, `claude-managed-target-controller.mjs (166)`, `claude-managed-target.c (97)`, `pi-managed-target-host.mjs (84)`.
- `tests/unit/run-control-kill-fixture.ts (535)`, `runz1-fixture.py (138)`.
- `tests/run/`: `b3h-heartbeat-busy.mjs (265)`, `b3h-heartbeat-lock.mjs (20)`, `b3h-heartbeat-overlap.mjs (52)`, `b3h-heartbeat-terminal-port.mjs (18)`, `b3h-preflight.mjs (16)`, `b3h-terminal-port.mjs (18)`, `crash-port.mjs (21)`, `file-port.mjs (5)`, `fixtures.ts (88)`, `group-helper.ts (114)`, `idle.mjs (164)`, `native-group.ts (167)`, `visible-harness.mjs (37)`, `visible-terminal.mjs (784)`.
- `tests/int/` old controller/benchmark programs: `b11-drain-signal.mjs (39)`, `b11-parent.mjs (22)`, `b11-process.mjs (200)`, `b11-resume.mjs (55)`, `b11-wait-performance.mjs (87)`; `b13-real.mjs (506)`; `b19-drain.mjs (30)`, `b19-lifetime.mjs (11)`, `b19-performance.mjs (146)`, `b19-writer.mjs (38)`; `b21-process.mjs (190)`, `b21-worker.mjs (58)`; `b22-evidence.mjs (25)`, `b22-pending-projection.mjs (104)`, `b22-port.mjs (79)`, `b22-process.mjs (1172)`; `b3ar1-env-audit.py (92)`, `b3ar1-env-driver.mjs (46)`; `b45-delegation-benchmark.mjs (204)`, `b45-dispatch-unknown.mjs (170)`, `b45-evidence-summary.mjs (92)`, `b45-mcp-stdio-benchmark.mjs (425)`, `b45-real.mjs (518)`; `b6-commit.mjs (14)`, `b6-lock.mjs (13)`, `b6-performance.mjs (217)`, `b6-real.mjs (141)`, `b6-server.mjs (47)`, `b6-writer.mjs (35)`; `idle.mjs (102)`, `perf-port.mjs (21)`, `runz1-perf.mjs (128)`.
- These helpers are invoked through string paths as well as imports. Remove their invoking cases/runner entries in the same slice. Do not blanket-delete `tests/int`: B9/B10/B12/history/collector programs still exercise retained code.

**Mixed files: retain and adjust, never wholesale delete:**

- **WP0** `tests/unit/b11-cli.test.ts (875)`: owner-approved retirement of legacy run control/help/wait cases only. Keep ordinary launcher, panel, read-only ledger display and other inherited assertions. Its fixture imports must remain valid. **WP0** `herdr-bridge.mjs`, `diagnostic-runtime-identity.test.ts`, wrapper/herdr integration tests and visual fixtures are not retirement targets.
- `tests/unit/{native-call-display.test.ts (236),jev-native-display.test.ts (170)}`: retain relation/history isolation, rendering, missing data and no-write tests; replace live-host-backed setup with persisted synthetic relations. Delete only host/bridge execution assertions.
- `tests/unit/run-process.test.ts (345)`: keep process identity/unknown/dead evidence used by owned workers; remove group-supervisor-only rows. `run-artifacts.test.ts (394)`: keep safe historical read/log tests; remove constructor/writer-only rows.
- `tests/unit/ledger-write.test.ts (819)`, `ledger-schema.test.ts (105)`, `ledger-read.test.ts (508)`, `ledger-perf.test.ts (114)`: retain schema/history fixture integrity and read-only coverage; retire production writer/intent stress rows, not whole files by their names.
- `tests/unit/{b10a-data.test.ts (229),b10a-observation.test.ts,b10a-wake.test.ts,b19-merge.test.ts (61),statusline-summary.test.ts,statusline-native-details.test.ts,delegation-summary.test.ts,panel-open-logs.test.ts}` and `tests/int/b19-merge-report.mjs (163)` retain historical projection assertions; change only execution-backed fixture construction. `b21-fixture.ts (118)` and `b45-handshake-fixture.ts (328)` have many such consumers and **must not simply be deleted**. Reduce them to synthetic historical data setup. `b45-delegation-fixture.ts (159)` retires after its B11/old-budget consumers are migrated/removed.
- `tests/unit/role-facade.test.ts:1511` (“delegate_status still accepts one run id”) retires, but P owns this shared file: remove that obsolete case in P rather than editing the file again in L. Keep all actual role cases.
- `tests/hud-mcp/{skeleton.test.ts (613),hook-source.test.ts (598),native-source-without-ledger.test.ts (287),ancestor-discovery.test.ts (253),pi-source-root.test.ts (222),config.test.ts (118)}`: retain still-used transport/native-evidence/ordinary-launch cases, remove old tool-schema/managed/claim cases. `role-source.test.ts`, `pi-host-identity.test.ts` remain.
- `tests/unit/{runtime-package.test.mjs,runtime-install.test.mjs,cloud-preview-build-order.test.mjs}` retain release integrity/activation/rollback. Remove required old-host/Python/wake assertions (`runtime-package.test.mjs:61–78,523–552`); replace with absence checks and owned artifact execution. Keep `jev-runtime-package.test.mjs` and `jev-runtime-graph.test.ts`.
- `b13-skill.test.ts (316)` and `integrations/skills/hud-handoff/SKILL.md`: retire `delegate_spawn`/ledger-run instructions and their checks; retain useful main-session handoff behavior against the six-role skill. Do not retire `hud-delegate` or the owned worker role texts. Old benchmark/probe files with retained hook/identity coverage need case-level pruning, not deletion based on “legacy” names.

## 3. What stays, drain and ordering

**Minimum compatibility:** strict `pi_dispatch` v1/v2 codec; bounded STATUS/SESSION/QA/history readers; source-scoped native/Jev relation decoders; existing read-only ledger/schema/export/log projections. Receipt schema 1 is **not** synonymous with pi dispatch contract v1: owned jobs still have an outer receipt format. Classify by executor/harness/`pi_dispatch.contract_version`, not `schema === 1`.

Keep native Codex/Claude/Pi transcript adapters, their ordinary-session bindings, Pi package/footer/evidence bridge, herdr transport/panel integration, Codex/Claude/Grok role recipes, all `src/roles/pi-owned`, all `src/jev` including J1/J1b/J2 foundations, role facade/wait and A8 packaging. `src/core/materials/legacy.ts` is a **summary consent bridge**, not obsolete execution; its caller in `collectors/small-model.ts` remains. Do not remove it.

**No new permanent drain service.** Per orchestrator q1, add one read-only `scripts/audit-r6b-drain.mjs`, approximately ≤150 lines, with explicit `--slice` and home/prefix/config-path inputs. One PASS/FAIL/UNKNOWN line per precondition; any FAIL/UNKNOWN exits nonzero. No writes, signals, repairs, socket startup or automatic cleanup. Treat unreadable/truncated/unparseable inventories as UNKNOWN; do not turn missing evidence into “drained”. If complete machine proof does not fit this small script, report UNKNOWN and require the owning release's inspection, not a larger framework.

The following are **proposed commands**, not commands already present or run:

| Slice | Owner's one command before merge | Required result |
|---|---|---|
| P | `node scripts/audit-r6b-drain.mjs --slice pi --home "$HUD_HOME"` | No unresolved v1-dispatch or old direct-pi job; all old primary/helpers and recorded panes/tabs closed through their owner. Settled STATUS or `state=closed` alone is not sufficient cleanup proof. |
| T | `node scripts/audit-r6b-drain.mjs --slice transports --home "$HUD_HOME"` | No process using the obsolete experimental transport/demo entrypoints; these were never an owned production route. |
| W | `node scripts/audit-r6b-drain.mjs --slice workbench --home "$HUD_HOME"` | No running old lab entrypoints or their fixture-owned children. Does not inspect/kill unrelated product workbench panes. |
| L | `node scripts/audit-r6b-drain.mjs --slice runtime --home "$HUD_HOME" --prefix "$HUD_PREFIX" --clients "$R6B_CLIENT_PATHS"` | A8 activation points new clients to the six-role facade; no live old native host/bridge/MCP controller, old hud-run supervisor/scope or unresolved legacy resources; all scanned client configs accounted for. |

Assign the new audit file and its small synthetic tests/runbook to P. P can land only after its own drain condition; T/W run after that tooling is available. No other slice edits it.

For L, check old ledger runs/claims/slots and process stamps, native-host sockets/processes and retained native/Jev handles, v1/direct-pi receipts and actual herdr inventory. A historical native relation is not a live-handle inventory. A stale socket does not prove either liveness or drain. An absent process does not prove its browser resource was closed. Unresolved/unknown cases are returned to the **owning release**, not adopted by the new release. Explicit owner-provided complete config paths and the owner's confirmation of relevant homes/workspaces are part of the runbook; the script cannot discover every private configuration location with certainty.

**Shipped references versus live owner configs:** currently shipped `packages/hud-mcp/bin/surface.mjs`, root `package.json`'s `hud-run`, package manifests/preview lists, `integrations/pi/hud-wake.ts`, old local-validation generators and old handoff text reference retired paths. A4/A5 configs intentionally select roles; A8 owns Codex activation. The owner's actual Claude/Codex/pi configurations were **not inspected**. Audit exact command/args/env, cached plugin copies and running clients; restart/reconnect ordinary MCP clients only after their delegated work drains. Never bulk-rewrite personal settings or remove old release directories during this source deletion.

An old release may still run existing jobs until drain, and an owned v2 job pins its immutable release for helpers/reaper. Source retirement is not release GC: retain rollback releases and every job-pinned release. No `pkill`, no replay, no new-release call to a saved v1 executable/reaper, no reassignment of ownership.

## 4. Test ownership and acceptance

Update `docs/testing.md` in L; it explicitly predates PR4 and some listed titles are no longer current.

| Map owners | Disposition |
|---|---|
| F05–F08 | Point to current PR4 cases in `pi-dispatch-facade.test.ts` and owned orchestration. Preserve timeout≠completion, QA idempotency/ownership, close-unresolved and continuation suppression. F09/F10 protocol observation stays. |
| H01/H06 | Retain framing/JSON/cancellation; tool-schema owner becomes F01's **six-role** schema plus role-source tests, not eight delegate schemas. |
| H02/H03/H08 | Preserve current native caller isolation through `role-source.test.ts`/ordinary evidence channels; do not carry old claimed authority forward. |
| H04, H09–H12 | Retire the generic native/bridge contract; product equivalents live in role-facade, owned-pi orchestration and Jev runtime/IPC tests. A native SDK acknowledgement matrix is not a requirement of herdr execution. |
| H05, H14/H15/H17–H19; L02/L04/L09–L11 | Retire old claim/resume/cancel/capacity/retirement protocol coverage, with the B11 owner exception recorded. Keep H13/H16's still-public ordinary CLI behavior where applicable. |
| L01/L03/L06/L07/L08 | Retain historical schema, read/export and safe artifact access; remove only retired writer portions. |
| L05; X09/X10 | Put MCP EOF/cancellation lifetime in the actual role-MCP process owner; keep owned process-identity tests. Remove the sourced group-leader/waiter topology once no product path launches it. |
| C07/C17 | Retire the old native wake transport; caller-backgrounded owned wait has the one wake channel. Keep `pi-dispatch-wake.test.ts` and independent waiters. |
| R02/R07/R10/R12/R14; E01–E03 | Keep artifact closure/integrity, Jev assets, rollback and the three owned product scenarios; change expected closure, not the guarantees. |

Required small regression rows (extend existing owners, no new framework):

1. Default and explicit `roles` MCP list exactly six tools; CLI create/read/wait never imports/spawns `managed/host-entry`, `hud-run`, SDK or Python, including with hostile old tools on PATH.
2. A Jev request starts only `src/jev/runtime/entry`; old native host/Python assets are absent from a clean staged artifact. Exercise the artifact after source checkout removal/relocation.
3. v1/direct receipts still display; mutation/same-key relaunch refuses before any write. Unknown version, symlink/oversized/malformed history and stale identity remain unavailable, not current authority.
4. Native/Jev relations and old ledger history render/export without socket connections, filesystem mutation, migration or inferred completion. Keep fixed visual bytes and all unaffected WP0 assertions.
5. Upgrade/rollback does not change an existing owned job's release or replay send intent. Retained release manifests do not suddenly require today's reduced inventory.
6. Audit fixtures cover live, dead, reused stamp, malformed/truncated/unreadable inventory and undisclosed config inputs: UNKNOWN is nonzero, and no writes/signals occur.

Use the actual post-A8/TEST-SLIM unit/mjs/MCP/WP0/visual gates, scoped negative controls and clean artifact rehearsal. Retired tests go with their code; don't add a parallel “legacy test mode” or retain a hidden old executor merely to make frozen assertions pass.

## 5. Expected result and limits

| Slice | Counted gross removal |
|---|---|
| P | 759 test/fake lines, plus small source hunks; keep codec/shared observation tests. |
| T | 1,022 source lines; 661 default-test lines; 155 demo + 216 fixture lines. |
| W | 1,610 script lines; 1,166 non-default lab-test lines. |
| L | 15,351 lines in the enumerated full source/bin/module deletions (excluding retained wake projection/types); 16,788 unit/mjs + 5,250 MCP test lines; supporting programs/fixtures add several thousand more. |

Thus the **enumerated whole-file source/module subtotal is 16,373 lines**, before mixed-file reductions, replacement codec/type lines and scripts. Expect roughly **16–18k net production-source reduction** and **30–35k test/fixture/support reduction** if the owner approves the complete legacy control retirement. These are planning estimates, not a final diff statistic. Do not count retained history fixtures or concurrently retired TEST-SLIM cases twice. One direct npm dependency and 104 production inventory entries disappear; bundle bytes/RSS should be measured from the staged artifact rather than guessed.

**Default-suite time:** T's five test files account for about **3.61 summed case-seconds** in the historical TEST-SLIM-0 baseline. The broad old managed/run/B19–B22/B45/B6 family accounts for about **326.40 summed case-seconds across 850 matched records** in `tmp/tasks/TEST-SLIM-0/baseline-cases.json`; that family includes cases which stay or move and is an opportunity estimate, not additive wall-time savings. W is outside `npm test`, and external conformance is normally skipped. The map's historical unit wall time is 350.680 s (`docs/testing.md:390–407`); it is invalid to subtract the summed seconds from that wall time. Report before/after default-suite wall time on the same host, same concurrency, ≥3 runs **after TEST-SLIM**, including build time separately. The dependable result is less compiled/shipped code and fewer process-heavy cases, not a promised percentage speedup.

## 6. Risks / decisions

1. **Owner decision required:** retire B11's mapped `hud run` mutation/wait assertions and explicitly record the affected WP0 replacement/removal. Recommendation: approve only those obsolete control cases; preserve the remaining file and main behavior. Until then L cannot delete its writer graph. P/T/W can proceed under their own prerequisites.
2. **Drain proof is not a directory count.** Finished jobs can retain pi grace/helpers, native transports or browser tabs; unknown ownership blocks deletion. Owner drain/activation evidence is still NOT_RUN here.
3. **Hidden dynamic packaging roots:** spawned entries, Python assets, bin aliases and fixture string paths are not ordinary import edges. Validate from a fresh build/staged release; never trust leftover `dist` output.
4. **Do not remove similarly named live code:** the role Codex/Claude/Grok/Jev adapters, ordinary native launchers, Pi package bridge and summary-consent legacy bridge stay. All historical ledgers/receipts remain on disk.
5. **Concurrent changes:** A8 and TEST-SLIM can change filenames, counts, ownership and timing. The orchestrator explicitly owns the post-merge re-census; the table is a concrete planning inventory, not permission to delete a newly mixed file.

**Optional:** none. No release-GC command, compatibility daemon, migration framework or generalized sweeper.

**Scope: needs orchestrator** — schedule after A8/TEST-SLIM, record the narrow owner WP0 decision and real-machine drain/config checks. Keeping the v1 codec/passive relations and the ≤150-line read-only audit were approved in consult q1. No new product feature or execution framework is proposed.
