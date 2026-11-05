# TPD1 prerequisite source, action and test map

Fresh Oracle prerequisite consultation, 2026-11-03. Research used GitHub reads only. This report is a conditional preparation artifact, not a release, implementation review, acceptance verdict or merge authorization. Workflow sources read: [AGENTS.md][S37], [dots roles and loop][S38], and [cloud rules/check set][S39].

## 1. Disposition

**TPD1 implementation remains held.** Its required base is `universal-hud` **after the actual B10B-S3F merge**. A pushed S3F/NEXT branch, a completed DOC2 prerequisite consultation, an improved benchmark, or an archived report does not satisfy that condition. Do not create a TPD1 branch from an unaccepted candidate, cherry-pick its interfaces, or invent a substitute accepted base.

The action semantics below are substantially settled, but the present brief also has concrete implementation-boundary gaps: production host observations/composition, native picker-label inputs, actual control-bar copy feedback, and log/clipboard effect plumbing. The later implementation must not silently turn these into collector, data-layer, adapter or rendering work outside its ownership. Revalidate and record bounded dispositions on the eventual accepted base before claiming the complete TPD1 goal can be delivered.

No contract, gate, supported profile, queue order or file ownership is changed by this consultation. The resource/lifecycle hold recorded in STATE is also unchanged. No code, test, build, branch, probe or workload was started. At the dispatcher's later request, this returned report alone was saved locally for verbatim archival.

## 2. Exact source identities and their different status

- Integration source inspected and rechecked at the end: `universal-hud@48abc4fc5e4b71ef36af720a69cad344ad71ea34` (commit message: `docs: record P065 interrupted continuation and lifecycle hold`). This is the authoritative current source snapshot for this map, not evidence of wave-1 acceptance.
- Unmerged interface/reference candidate: `dots/b10b-s3f-next@00b2d197ce165882a768b86c5c2b650667528486`. Its action producer, s3 rulings and s3 tests were inspected for future integration. They are **not current integration-source features**.
- Other branch tips observed: `dots/b10b-s3f@bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60`; `dots/b10b-s3f-perf@e5ccee38165b30809bd537e7f31cfed7f227f152`; original `cloud/b10b-s3-wip@ee2b032b414e4410bdebdc5cb7c47185f5c6b1e1`.
- GitHub comparison of integration source to NEXT was `diverged`, ahead 44 / behind 76, merge base `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9`. Treat the candidate as a distinct branch, never as the latest integration base.
- `src/tree-page.ts` has the same blob SHA, `843a9e224444745d00362931be5a392d3fe26fc5`, at integration and the inspected NEXT tip. Thus the dispatcher/reconcile gaps identified below are not already fixed by NEXT.
- No `tests/unit/tpd1-*` file appeared in the inspected integration tree. The s3 action types, s3 ruling file and s3 unit suites are on the unmerged candidate, not in that integration tree.

Sources: [integration commit][S1], [current STATE][S2], [TPD1 brief][S3], [queue ruling][S4], [branch comparison][S5].

## 3. Binding semantics, with conflicting shorthand resolved

Read the TPD1 brief together with the s3 rulings, contract 03 and design §3.7. The s3 brief's `o / Enter` shorthand must not override the later explicit Enter ruling.

1. `o` performs Open or Switch. `L` performs Log only. `R` performs Reconcile or the MVP Resume diagnostic. Enter, Space and `v` inspect; they emit no delegation effect. A row click selects only, with no legacy double-click `pick` behavior injected for delegation rows.
2. A key acts only when its corresponding control was drawn in the frame the user saw, including the narrow-width/zero-height cases. The dispatcher consumes the emitted action; it must not bypass the input producer and manufacture an action from selection or a timer.
3. `switch` remains the existing `{ type: 'switch', id: identity.ref.sessionId }`, only for a Codex native whose native-edge ancestry reaches the viewpoint root. Other-harness natives and natives under delegated sessions do not use the root Codex picker. Root `m` / home behavior remains unchanged.
4. Visible managed Open requires the displayed host gate and a dispatch-time recheck: `host.currentState != null`, no `uncertain:` state, and the same fixed target. A replacement run, stale/unknown locator, mismatch, conflict or unavailable adapter must cause refusal, never selection of another node or a raw-pane fallback.
5. Log applies to managed headless rows in every state, including uncertain and ended, with or without a report. Visible/root/native/plain-session/synthetic-conflict/put-away rows have no Log. `o` on a Log row does nothing.
6. Reconcile consumes the **captured ActionDescriptor object** and copies `displayCommand` verbatim. It never re-looks-up a newer descriptor, reconstructs the command, changes run/request identity, executes the command, or invokes a writer/reconciler process.
7. MVP Resume is always diagnostic-only. An ended managed run with a report of any status and no Reconcile descriptor has the grey Resume control; `R` or its click returns the translated fixed diagnostic, never a copy. A still-live reported run does not gain Resume. B14 owns release of the real local-resume capability.
8. A successful copy must display the specified two-second `✓ Copied` feedback. Failure must not claim success. Repaint, notification, reconnect, uncertainty transitions and timers never cause copy, open, log or control actions.
9. Plain-session SurfaceLocator support, per-conflict Reconcile descriptors, the real resume gate and Inspector content are later work. Do not fabricate their missing data or capabilities in TPD1.

These are existing binding interpretations, not new feature decisions. Sources: [candidate s3 rulings][S6], [candidate action producer][S7], [design §3.7][S8], [contract 03 fixed-target/copy-only boundary][S9], [concept decision log][S10].

## 4. Source-to-action map

### A. Visible managed Open

- Producer, candidate: `src/render/delegation/actions.ts`, `rowActions`, `openEnabled`, `openKeyAction`, `openButtonAction`; `monitor-input.ts:104–116` resolves the selected action from the drawn frame.
- Current page gap: there is no `delegation-open` dispatch branch or HostAdapter composition in `src/tree-page.ts`.
- Existing reusable boundary: `HostAdapter.locate`, `checkLocator`, `focus`; `HerdrHost.focus` performs its own locator, occupant, agent-readiness and managed-interaction checks. The existing `tests/fakes/host-adapter.ts` can be reused read-only.
- Required handling: retain the seen frame's fixed row/run/locator identity, compare it with the current view model at dispatch, resolve/recheck through the adapter, and focus only that verified surface. Key-only actions do not authorize resolving a replacement run after collection has changed. The seen frame can supply the immutable target snapshot without widening the public action type, but the implementation must demonstrate that it preserves that snapshot before asynchronous work.
- Do not cast a `HostLocator` or arbitrary `currentState` JSON directly into a `SurfaceLocator`: managed `bindingGeneration` and host `occupantGeneration` are different. `HerdrRegistry.matches` requires the latter and a matching ProcessStamp. Do not call bare `tmux select-pane` or Herdr transport as a fallback around failed adapter checks.
- Production prerequisite: see §5.1. This is not merely adding one switch case.

Sources: [candidate input resolution][S11], [current page dispatch][S12], [HostAdapter][S13], [Herdr host][S14], [locator types and generation separation][S15], [registry match][S16].

### B. Headless Log

- Producer: `delegation-log { key }`; the same frame/target preservation rule applies. Capture the seen currentRun, rather than following a newer currentRun behind the same session key.
- Current page gap: no log action handler or tail-pane composition exists.
- Trusted artifact facts available now: `RunArtifacts.open(hudHome, runId)` is read-only; it validates the run identifier, private directory path and identity. Logs live under the fixed run directory as `stdout.log` and `stderr.log`; `readLog` is bounded and handles a missing stream without manufacturing output.
- Existing host mechanics: `openSurface` plus `runInSurface` are available on HostAdapter. A user-requested log viewer is an unmanaged surface (`managed: null`), never a fabricated new run. Use fixed executable/argv and safe final quoting, not text taken from report, label or log. Do not submit a command into the managed run's own pane.
- Current `hud-run logs` reads one stream/range; it does not expose a follow option. Do not invent a shipped `hud run logs --follow` capability. The actual tail/viewer route and stream policy remain to be specified.
- No host: show the trusted fixed-run path(s). Missing/inaccessible/unsafe artifact or unavailable host must produce truthful diagnostic/path output, not a successful-open claim. Do not create the run directory to make a read succeed.
- Host launch acknowledgment can be unknown: do not retry another surface automatically and duplicate the viewer. Any new viewer process/timer must have a bounded ownership/cleanup policy.

Sources: [RunArtifacts][S17], [existing hud-run CLI][S18], [HostAdapter][S13], [Herdr argv conversion and single submission][S14].

### C. Reconcile copy

- Producer: `delegation-copy { key, descriptor }`. The candidate tests already assert descriptor object identity and exact action keys.
- Required effect: copy exactly `action.descriptor.displayCommand`, including its HUD_HOME, target and quoting, then confirm success with two-second bar feedback. Retain the same descriptor if collection advances before the asynchronous clipboard operation completes.
- No current clipboard implementation is imported by the page. ARCHITECTURE explicitly calls `dist/utils/tmux-copy.js` stale output with no source, so it is not a reusable implementation.
- The page's existing `tmux()` helper resolves even when `execFile` errors. It cannot, without a truthful result boundary, justify `✓ Copied` for a clipboard operation.
- Clipboard transport, unavailable-clipboard behavior and a controllable test seam must be specified. Never fall back to executing `displayCommand`, synthesizing command text, or reporting an unacknowledged write as copied.
- Actual bar feedback requires the ownership disposition in §5.3.

Sources: [candidate copy tests][S19], [contract 03][S9], [page tmux helper][S20], [stale output note][S21].

### D. Resume diagnostic

- Producer: `delegation-diagnostic { key, text }`, with EN/ZH text already translated by the candidate action producer.
- Existing landing point: assign/display the action's text through the page's `navigationMessage`, then repaint; the s3 ruling explicitly permits this until the Inspector exists.
- Preserve the existing rendering sanitation path. Do not interpolate command-like text from reports or replace the diagnostic with a runnable resume command.
- Clipboard calls, RunControl calls, subprocesses, signals, input and pane destruction must all remain absent.

Sources: [candidate action producer][S7], [s3 dispatcher ruling][S6], [page notice input][S22].

### E. Existing Switch and its label

- Keep `switchSession` → `navigateSession` for the permitted Codex-native case. `switchSession` is at `tree-page.ts:1194–1209`, and its current label comes from `uniquePickerLabel(tree, id)`.
- The legacy tree is empty in delegation mode. Exact picker labels depend on `agentPath`, nickname and role, including uniqueness across the root native subtree. B9 currently carries only `NativeMetadata { title, kind }`; `title` is a display name, not an authoritative picker label.
- Do not use a rendered/truncated title, role guess, bare ID shared across sources or a cached legacy node as an exact label. Existing navigation safely refuses ambiguous/no-label narrow pickers and uses UUIDs when the picker prints them.
- The safe interim behavior is ID-based navigation with the existing narrow-pane refusal when exact label data is unavailable. Whether that is the explicit TPD1 acceptance boundary, with exact label support deferred to the queued data package, needs recording; do not silently mark the brief's Switch-label goal fully complete.

Sources: [current Switch dispatch][S23], [exact legacy picker-label rule][S24], [navigation ambiguity handling][S25], [B9 native data shape][S26].

### F. Three reconcile calls

- Current calls: `tree-page.ts:1016` after collection; `:1105` after Git refresh; `:1134` after inspection refresh.
- Candidate signature: `reconcileMonitor(state, tree, git, worktrees, nowMs, delegation)`. Pass the correct current view model **as argument six**, with the intended timestamp; passing it in the fifth slot is wrong.
- Explicit `null` restores legacy behavior and removes the candidate `delegating` marker; omitted/undefined preserves the workaround's selection-skip behavior. Test the difference, especially while a modal prevents `renderMonitor` from running.
- Preserve worktree/file/focus/revealed/scroll reconciliation. Do not touch collector timing, collection, publication, worker wiring, the observation lease or recovery accounting.
- Removing the render-side `delegating` workaround is optional later cleanup, not automatically in TPD1's whitelist. Leaving it compatible is safer than silently editing rendering internals.

Sources: [current page][S12], [candidate reconcile implementation][S27], [s3 Q6][S6].

### G. Activity-hub target

- Current handler: `tree-page.ts:1350–1370` searches only `tree.rootId` and legacy descendants. It falsely calls a delegation target historical when that legacy tree is empty.
- Existing activity action is `{ type: 'target', agentId }`; journal entries are historically legacy identifiers, not necessarily canonical B9 row keys.
- Required page behavior: resolve a current target to a verified canonical delegation row, open details/focus mode, and close the hub. Root still opens diagnostics. A genuinely absent historical target keeps the historical diagnostic. This is navigation only, never Open/Switch/Resume.
- Match canonical keys directly when supplied. If supporting a legacy Codex identifier, constrain it to the actual viewpoint's source/harness and require one unambiguous current identity. Do not select the first equal bare sessionId across homes/harnesses, use a label/cwd match, or invent a mapping.
- Ensure a valid hidden target is revealed using the existing selection/destination rules, without promising Inspector content that belongs to B10B-s4.
- The journal still collects legacy-tree agents. Updating activity ingestion to produce new delegation entries is collector work and outside this package. Fixing an existing target handler does not claim that all delegation agents now populate the hub.

Sources: [page target handler][S28], [activity action generation][S29], [journal legacy ingestion][S30], [B9 identity/selection mapping][S31].

## 5. Concrete prerequisite questions to record before implementation

### 5.1 Host observations and production composition

`HudDelegationCollector.tick` calls `LinkTickCollector.tick` with roots/deadline/ledger availability but **no `hosts`**. Core tick accepts optional hosts; `projectLinkHost` returns a non-null currentState only from exactly one matching checked host observation. In the inspected production composition, adding a dispatcher alone therefore cannot make Open reachable. This remains true on the inspected NEXT branch because these collector files are unchanged.

Also, the page has no HostAdapter instance. The existing Herdr implementation requires a client, registry, context and managed status boundary; its SurfaceLocator freshness cannot be supplied by borrowing the run's bindingGeneration. No concrete tmux HostAdapter composition was identified in the inspected page/host sources. This is an integration dependency, not evidence that tmux focus is already supported there.

**Required disposition:** name the already-authorized owner/producer of current host observations and the safe adapter-composition route, or explicitly bound TPD1 to plumbing that fails closed until that prerequisite lands. If changes to `src/collectors/**`, `src/core/**` or `src/integrations/**` are needed, record the exact ownership/scheduling change first. Do not silently add a host scan to the HUD tick or open from an unverified locator. This report does not authorize that expansion.

Sources: [production tick input][S32], [host projection][S33], [HostAdapter][S13], [Herdr construction][S14].

### 5.2 Exact native picker labels

The s3 ruling and STATE explicitly assign missing picker-label inputs to the later data layer. TPD1's Switch-label goal cannot manufacture them. Record either the safe ID-only/deferred-label boundary or a separate exact producer dependency. Do not pull wave-3 data work forward merely to satisfy an ambiguous phrase.

### 5.3 Copy feedback and localization exceed the literal whitelist

Candidate `BarInput` exposes brief/expired/settingsActive/buttons only, and `RowButtons` only open/recover word+enabled. It has no transient copy-success field. `renderMonitor` passes `notice` to separate warning-colored footer rows, not to the control bar. The inspected candidate i18n table has the Resume diagnostic but no Copied entry.

Thus assigning `navigationMessage = '✓ Copied'` is not the specified **bar** feedback, and a raw English literal misses the architecture's bilingual rule. Record a minimal rendering/i18n ownership extension for true bar feedback, or an explicit design disposition before choosing another presentation. Do not post-process ANSI rows or mutate drawn action words to hide the gap. No such extension is granted here.

Sources: [candidate bar inputs][S34], [candidate notice placement][S35], [candidate localization table][S40], [architecture language/purity rules][S36].

### 5.4 Log-viewer/clipboard transport and testability

Specify supported host/viewer/clipboard transports, missing-file and uncertain-launch outcomes, cleanup, and the production-wired fake seam. There is no need to alter contract 03 to choose a bounded implementation, but a new adapter method, new utility file, new supported host/profile or control capability is not implicitly allowed by the current brief.

The current page unconditionally starts `runLivePage()` at module end. Tests need a minimal seam that exercises the actual page dispatcher without starting real services. Keep any permitted extraction/entry guard inside the owned file unless a separate file is expressly ruled in. Tests of a disconnected helper do not prove production dispatch is wired.

## 6. Eventual file boundaries

The existing whitelist remains:

- `src/tree-page.ts`, action dispatch, related effect-state/test seams and the three reconcile calls only.
- New tests matching `tests/unit/tpd1-*`.
- Segment-3 action types and all imported helpers: read-only unless a recorded Oracle ruling expressly changes that ownership.

Read-only dependencies include `src/render/monitor*.ts`, `src/render/delegation/{actions,selection,panel}.ts`, `src/render/control-bar.ts`, `src/render/i18n.ts`, `src/render/activity-hub.ts`, `src/utils/session-navigation.ts`, `src/core/link/**`, HostAdapter/Herdr implementation, RunArtifacts, fixtures and the fake host.

Not included: B10D collector wiring, worker work, host collection, B9/B16 fields, activity ingestion, Inspector content, real resume capability, CLI commands, adapters/core behavior, contracts/design edits, benchmark-gate changes or local-only qualification. DOC2 owns its design-document amendments. Dispatcher archives and STATE/plan records remain serialized recording work.

The fact that TPD1 and B10D touch different logical regions of `tree-page.ts` does not prove that a future merge is mechanically conflict-free. Compare the actual eventual accepted bases and active ownership again before starting.

## 7. Acceptance/test map for the later authorized implementation

These are required assertions/planned tests, **not tests run by this consultation**. Suggested new filenames stay inside `tests/unit/tpd1-*`; reuse the eventual merged s3 fixtures and `FakeHostAdapter` without editing their owners.

### `tpd1-dispatch.test.ts`: keys through the real dispatcher to fake effects

1. Decode/handle `o`, `L`, `R`, Enter, Space and `v` on rendered synthetic frames, then execute the same dispatcher used by production. Assert the exact effect and no extra effects. Mouse controls must agree with their corresponding keys; delegation row clicks remain selection-only.
2. Valid visible Open focuses exactly the captured surface once through the fake HostAdapter. Cover every disabled gate and absent adapter. Mutate the current model between render, input, locator check and asynchronous completion: removed node, changed run, changed generation/process/occupant, uncertain state and wrong source all refuse rather than retarget.
3. Headless Log works for active/uncertain/ended, report/no report. `o` remains a no-op; visible/root/native/plain/conflict/put-away `L` remains a no-op. Verify the fixed original run, safe argv, both stream/path policy, no-host fallback, absent/unsafe artifacts, denied/unknown surface launch and no automatic duplicate launch.
4. Reconcile copies exactly the displayed descriptor string, preserving target/request identity across model changes and repeated copies. Malicious labels/reports/log strings never enter the command. Assert zero resume/reconcile subprocesses, writes, signals, sendKeys or pane close.
5. Clipboard success alone enables feedback; failure does not. Fake time verifies the two-second feedback lifetime, repeat-copy behavior, no stale timer clearing a newer notice, and cleanup on panel close. Verify its actual approved UI location in EN/ZH and narrow/no-color frames.
6. All four terminal report statuses produce the MVP Resume diagnostic and zero copy/control effects. Reported-but-live and ended-without-report rows do not gain Resume. Reconcile takes precedence when present.
7. Permitted native Switch reaches the existing navigation boundary with exact id. Wrong harness/delegated subtree/root cases preserve existing behavior. Exact labels, if later supplied, require uniqueness; unavailable/duplicate labels fail safely in a narrow picker. Preserve busy-picker and existing-draft protections.
8. Repaint, second ticks, resize, modal changes, notification, reconnect and uncertainty alone produce no effects. Below the drawn-control floor, keys produce no action. Prefix/main-pane forwarding behavior remains unchanged.

### `tpd1-reconcile.test.ts`: every page reconciliation path

9. Exercise collection, Git-refresh and inspection-refresh call sites with the VM in the sixth argument. Selection survives unchanged ticks and intent→session mapping. Hidden/put-away selections follow the accepted s3 resolver, not ad hoc row lookup.
10. Exercise those calls while settings/activity/observability suppress normal monitor renders. Explicit VM→null clears delegation state and restores byte-identical legacy behavior; undefined is not accidentally substituted. Worktree/file/focus/revealed/details-scroll behavior is preserved.

### `tpd1-activity-target.test.ts`: identity-safe hub navigation

11. Current delegation target with empty legacy tree reaches its canonical row and details state; root reaches diagnostics. Historical missing target remains a diagnostic, not a first-row substitution.
12. Same bare sessionId in two sources/harnesses, unknown identity, stale journal entry and removed current node do not silently select another target. Existing valid legacy targets remain supported.
13. Hidden current target has a meaningful revealed destination under existing plan rules. No host, clipboard, resume or reconcile effect occurs merely from Inspect. Do not assert unavailable B10B-s4 Inspector content.

Each added behavior needs a test that fails against the prior accepted implementation, with the test demonstrably reaching the production dispatch/reconcile path. Existing candidate s3 tests prove action generation, not effect execution. Retain them as regressions rather than treating them as TPD1 coverage. Especially reuse the tests for fixed descriptor identity, no repaint effects, narrow control gating, Enter separation and legacy behavior.

### Required check/evidence set, when implementation and compute are actually released

- Runtime: Node 22 at least 22.13 or Node 24, as AGENTS/dots specify. Tests use synthetic data and temporary HOME/HUD_HOME. All spawned processes must be owned and cleaned up by PID.
- Focused after build: `node --test dist-test/tests/unit/tpd1-*.test.js`, plus the applicable merged s3 action/selection/input regressions. Record actual commands and complete raw output.
- Full README set remains: `npm run build && npm run build:test && npm run build:hud-mcp`; `env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=$(mktemp -d) npm test`; `npm run test:core`; `npm run test:visual`; `npm run test:hud-mcp`; `npm run format:check`; `npm run check:fixtures`; `git diff --check`. Ensure the whole test session follows the temporary-home isolation rule, not only the one explicitly wrapped command. `npm test` includes the separate mjs stage; an interrupted unit stage is not evidence that mjs passed.
- Known flakes get the permitted single isolated rerun with **both** logs retained. An environment restriction or an unexplored stage is not a pass. No previous red result is erased by this map.
- Passing a VM into page reconciles touches work associated with HUD updates. Preserve the established segment-3 selection+key+rerender gates and host-labeled timing evidence: n at least 1000, nearest-rank, at least three runs; no-change p99 at most 2 ms, changed compact at most 10 ms, rich at most 15 ms. Do not disguise additional reconciliation cost by measuring only a helper. No new cold-tick gate is introduced; the DOC2 prerequisite disposition remains separate.
- Real Herdr pane opening, real tmux suites, logged-in CLIs and WSL qualification remain local-only and must be listed as unrun/owner verification. Never simulate them, reroute testing to the owner's computer without authorization, or present fake-host coverage as real-host qualification.
- Final Oracle verification/acceptance still precedes integration. Merge is `--no-ff`, with the full green check set on the actual merged tree, then push and STATE/plan updates under the standing workflow. This consultation supplies none of those results.

## 8. Conditions for the next handoff

Before commissioning implementation, the dispatcher should provide the actual S3F merge commit and green merged-tree evidence, refresh the TPD1 source/interface map against that base, pass the archived s3/DOC2 rulings unchanged, confirm exact file ownership, and obtain recorded bounded dispositions for §5. No TPD1 implementation starts solely because this map is complete.

If an unresolved gap would require another package's files, a supported-host/capability change or a contract/gate change, stop that dependent action and route the exact question through the project workflow. Independent read-only preparation may continue. Do not decide that a dispatcher-only fake demonstration is equivalent to production completion.

Uncertainty is explicit: this consultation did not execute code, validate runtime effect behavior, re-review NEXT performance, verify local evidence, qualify any host, or inspect uncommitted executor WIP. The source-derived gaps are based on the pinned GitHub snapshots above. GitHub reads succeeded for the substantive sources; an exploratory nonexistent `src/cli.ts` fetch was not used as evidence and was replaced by inspection of the repository's actual `src/cli/` paths. No denied operation was retried.

## Source links

[S1]: https://github.com/CartmanFatass/codex-hud/commit/48abc4fc5e4b71ef36af720a69cad344ad71ea34
[S2]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/handoff/STATE.md
[S3]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/TPD1.md
[S4]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/rulings/queue-progress-20261103.md
[S5]: https://github.com/CartmanFatass/codex-hud/compare/48abc4fc5e4b71ef36af720a69cad344ad71ea34...00b2d197ce165882a768b86c5c2b650667528486
[S6]: https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/docs/cloud/rulings/b10b-s3.md
[S7]: https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/src/render/delegation/actions.ts
[S8]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/design/hud-information-design.md#L231-L252
[S9]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/contracts/03-lifecycle.md#L132-L147
[S10]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/universal-hud-concept.md#L590
[S11]: https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/src/render/monitor-input.ts#L95-L116
[S12]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/tree-page.ts
[S13]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/core/interfaces/host-adapter.ts
[S14]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/integrations/herdr/host.ts
[S15]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/core/interfaces/session-binding.ts
[S16]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/integrations/herdr/registry.ts#L209-L221
[S17]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/core/run/artifacts.ts#L153-L408
[S18]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/core/run/cli.ts#L14-L95
[S19]: https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/tests/unit/b10b-s3-actions.test.ts#L218-L243
[S20]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/tree-page.ts#L170-L181
[S21]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/ARCHITECTURE.md#L88-L100
[S22]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/tree-page.ts#L655-L690
[S23]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/tree-page.ts#L1194-L1209
[S24]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/collectors/subagent-tree.ts#L190-L224
[S25]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/utils/session-navigation.ts#L223-L303
[S26]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/core/link/types.ts#L13-L17
[S27]: https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/src/render/monitor.ts#L427-L455
[S28]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/tree-page.ts#L1350-L1370
[S29]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/render/activity-hub.ts
[S30]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/collectors/activity-journal.ts#L278-L311
[S31]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/core/link/index.ts#L150-L213
[S32]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/collectors/delegation.ts#L963-L990
[S33]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/core/link/host.ts
[S34]: https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/src/render/control-bar.ts#L50-L70
[S35]: https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/src/render/monitor.ts#L778-L798
[S36]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/ARCHITECTURE.md#L766-L810
[S37]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/AGENTS.md
[S38]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/dots.md
[S39]: https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/README.md
[S40]: https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/src/render/i18n.ts
