# TPD1 effect boundaries and ownership: conditional addendum

Date: 2026-11-04. Fresh Oracle design consultation.

**CONDITIONAL / NOT RELEASED. TPD1 implementation remains blocked until the actual B10B-S3F merge into universal-hud and the recorded accepted-base/check prerequisites.** This addendum resolves the four remaining scope decisions. It does not accept B10B, release a workload, change the queue, or authorize implementation on NEXT.

## 1. Decision in brief

1. **Host Open is a staged, fail-closed boundary.** TPD1 implements the real page dispatcher against the existing HostAdapter interface, with an explicitly unavailable production host port until a separately owned, accepted host-observation/composition producer exists. It does not add host scans or construct a purportedly trusted Herdr adapter from environment hints.
2. **Delegation Switch is ID-only for this stage.** Preserve current exact-ID navigation and its narrow-picker refusal. Exact native picker-label production stays with the queued data work. A display title is not a picker label.
3. **Grant the minimum rendering ownership extension:** src/render/monitor.ts, src/render/control-bar.ts and src/render/i18n.ts, only for a pure transient copy-feedback input and actual bilingual control-bar feedback. The page owns the asynchronous effect, clock and lifetime.
4. **Log is fixed-run, both-stream path presentation in the production stage.** Automatic host tail viewers remain a named deferred dependency, not an unimplemented promise hidden behind a fake. Clipboard has one selected bounded production route for the existing WSL environment: a one-shot Windows clipboard provider with exact read-back acknowledgment. Elsewhere or when unavailable, fail truthfully; neither OSC 52 emission nor a tmux-buffer write counts as system-clipboard success.

This deliberately narrows the eventual TPD1 package acceptance to a **dispatcher stage**, without changing the end-state product design. Its report may say that the dispatcher stage is implemented only after its own checks/review. It must separately state that production managed Open, automatic Log panes and narrow-picker labels are still deferred. It must not claim the original end-to-end UI goal is fully delivered.

The owner delegated project decisions through the dispatcher:

<transcript_evidence>
用户：“批准 我给你全权 你以Oracle的意见为准即可 不要逐项要权限”
用户：“后续你有本地测试需求可以发给我 然后继续工作即可 我有空会完成测试 队列任务你直接完成即可 无需我批准 有需要抉择的地方请让oracle直接决定”
用户：“批准写入公开仓库 你有分支对应的修改写入权限”
</transcript_evidence>

That authority supports the explicit bounded ownership/staging decisions here. It does not supersede safety requirements, the local-execution withdrawal, package order or acceptance gates. No generic repeat owner approval is required to record this conditional decision.

## 2. Exact source basis and limits

- Current integration source: **f248f320d42528fd1eb97db9f1cd2ba97e6d3c86** on universal-hud, rechecked during this consultation.
- Reference-only unmerged NEXT: **60b5959d02516e73d30cd5a55913eb6988a94ea9**.
- The existing prerequisite map used integration 48abc4fc5e4b71ef36af720a69cad344ad71ea34 and NEXT 00b2d197ce165882a768b86c5c2b650667528486. The queue Oracle's complete-tree comparison found only seven added integration ruling documents and one added NEXT owner-review document. I independently read the current relevant source; the dispatcher, collector, native types and Herdr host blobs agree with the map. The current NEXT comparison also confirms its sole new path is the owner review.
- In both current integration and NEXT, src/tree-page.ts is blob **843a9e224444745d00362931be5a392d3fe26fc5**; src/collectors/delegation.ts is **06cb3b0119ce8fafb5cd5e08c6d46b63a8c4ca67**; src/core/link/types.ts is **90ed9be1f038a0b456c7e4e0887fc35ed02463e3**; src/integrations/herdr/host.ts is **a30604722bffd17e85b98238fdfff5f4eb10823c**.
- S3 actions, the S3 action/input/reconcile behavior and the cited candidate control-bar interfaces are **unmerged reference interfaces**, not current integration features. Revalidate them after the actual accepted merge.
- The current NEXT owner review and composite preparation do not supply the required S3F merge. This consultation does not re-review their performance or the separately assigned ledger-audit issue.

Binding: TPD1 brief; existing TPD1 map; queue-progress ruling; S3 rulings; design §3.7; contracts 03/05; ARCHITECTURE §8; AGENTS/dots/README. The completed DOC2 prerequisite ruling remains unchanged. This is a focused addendum, not a replacement source/action map.

## 3. Host observations and HostAdapter composition

### Selected route

**Keep host-observation collection and trusted adapter composition outside TPD1. Make their absence explicit in production.** An in-file page composition port may hold HostAdapter | null. The current production value is null; tests inject the existing fake through the same factory used by the live page. There is no production environment/configuration switch that accepts an arbitrary adapter, fabricated observation or test verifier.

This is not satisfied by installing HerdrClient alone. The current collector calls LinkTickCollector.tick without hosts. projectLinkHost supplies currentState only from one matching checked observation. Herdr requires an independently trustworthy server instance, registry occupant evidence, source resolver, fixed-run locator lookup and managed status boundary. CliHerdrTransport explicitly cannot establish its instance without its supplied server ProcessStamp. Inherited HERDR_* values or a socket pathname do not fill those gaps.

**Consequences in the current production composition:**
- Managed visible Open remains grey because currentState is absent.
- An unexpected/stale emitted Open reaching a dispatcher without its host port receives a translated unavailable diagnostic and performs zero host calls.
- Do not turn null host into a tmux select-pane path. Do not cast host.currentState or a managed HostLocator into SurfaceLocator.
- Do not instantiate RunControl writers, open a writable ledger, or execute a control CLI to make focus work.

### What the future prerequisite must actually deliver

The existing collection owner and host/data integration owners must jointly supply, under a separate complete brief in their own queue slot:

1. Bounded, charged CollectedLinkHost observations for the exact runId, expected binding generation and canonical managed locator, with checked server/occupant identity and the existing valid/stale/unknown semantics.
2. A trusted composition supplying the page's existing HostAdapter interface, including independent occupantGeneration and ProcessStamp evidence, fixed-run locator lookup and a read-only managed status boundary. Managed bindingGeneration is never substituted for occupantGeneration.
3. Shared per-server preflight/cache ownership and bounded lifecycle. No additional uncharged paint/tick scan or per-consumer polling daemon.
4. Real host qualification distinct from fake tests. A future tmux HostAdapter is not presumed to exist because the legacy page uses tmux.

This addendum does not name a new released package, assign B10D extra implementation work, or pull queued B9/B16 work forward. Those are the precise deferred producer/composition requirements.

### Dispatcher behavior that is still owned by TPD1

At the key/click boundary, capture the seen frame's canonical node identity, row key, fixed runId, binding generation, managed locator and relevant gate facts **before any await or repaint**. Do not resolve a key against a newer frame later.

For Open, require the current view model still identifies that same target, with non-null verified host state, no conflicting/mismatched target and no uncertain state. Resolve that fixed run through HostAdapter.locate; obtain and check its genuine SurfaceLocator. Match its host address/process evidence to the captured managed target, without equating the two generations. Repeat the current-view gate after asynchronous lookup/check and immediately before focus. Then call HostAdapter.focus, which retains its own final interaction/occupant checks. If any check is missing, stale, unknown, changed or throws, refuse. No alternate row/run/pane is chosen.

A fake positive establishes dispatch/interface correctness only. Production Open stays a separately outstanding requirement until the named prerequisite is accepted and wired.

Sources: [collector call][H1], [host projection][H2], [HostAdapter][H3], [Herdr focus/lookup][H4], [transport instance][H5], [registry evidence][H6], [contract 05][C5].

## 4. Native Switch and picker labels

### Selected route

When a delegation frame emits Switch, call the existing navigateSession path with the captured authoritative session ID and **no guessed label**. Keep the legacy non-delegation uniquePickerLabel behavior and root/home behavior unchanged.

Before dispatch, retain the seen root-Codex-native eligibility and complete source/harness identity. If the viewpoint or canonical identity changes, do not switch a different bare session ID under the old intent. The existing producer's eligibility remains: the Codex native's native-edge ancestry reaches the viewpoint root. Other harnesses and natives underneath delegated sessions remain ineligible.

If the picker displays IDs, its exact-ID match is the authority. If it displays only labels and this stage has no authoritative unique label, retain the existing translated instruction to widen the pane. Preserve existing busy-picker, draft and ambiguity protections.

Do not reconstruct a parallel legacy tree, rescan the native source, reuse a cached legacy label, treat native.title as exact, or invent agentPath/nickname/role. NativeMetadata currently contains only title and kind. The missing producer must later carry enough exact picker-name data and the correct root-native uniqueness domain; that is the data package's responsibility.

**Acceptance wording:** “Exact-ID delegation Switch works; label-only narrow pickers refuse safely until the exact-label producer lands.” It is not “Switch labels implemented.”

Sources: [native metadata][P1], [legacy exact label][P2], [navigation matching/refusal][P3], [candidate eligibility/action type][P4].

## 5. Two-second bilingual control-bar success

### Exact eventual ownership extension

Additive edits are permitted to:
- **src/render/monitor.ts:** a transient copy-feedback input on MonitorInput and forwarding of its currently active status to controlBar. No new effect execution or I/O.
- **src/render/control-bar.ts:** a non-interactive success-status segment in the existing bar layout, including width and hit-span handling.
- **src/render/i18n.ts:** Copied → 已复制 and the small set of TPD1 failure/unavailable/path notices actually introduced.

These files currently belong to S3 rendering, so this is an explicit **post-S3F** transfer of the bounded addition, not permission to edit the active B10B branch. No ownership of actions.ts, monitor-input.ts, projection/facts/rows/selection, general layout or Inspector is transferred.

### State and lifetime contract

The page owns an operation token, closed/root epoch, pending-copy slot and optional feedback record. A suitable minimal shape is page-owned { token, expiresAtMs }, with MonitorInput.copyFeedback carrying only the immutable timing/status data the renderer needs. BarInput gains feedback?: 'copied', selected by renderMonitor using its supplied nowMs. The renderer never reads the clock, schedules work or writes state outside its normal returned frame.

- Begin the two seconds only after acknowledged exact clipboard success, not on keydown or subprocess spawn.
- Render **✓ Copied** in EN and **✓ 已复制** in ZH. Use t(), theme roles, visualLength and truncateAnsi.
- At ordinary usable widths the text is in the actual control bar, not the warning footer. It is a status, not a button and not a changed Reconcile/Resume action word.
- Reserve the status region in layout and exclude it from all click spans. Apply existing fit/drop rules; at extreme widths a status glyph may replace its word, and a zero-sized frame draws nothing. Any action omitted by the resulting frame remains unavailable to its key. Do not post-process completed ANSI lines.
- Do not add rows to the bar solely for feedback or change unrelated bar geometry. Prefer available space and normal lower-priority layout reductions. Preserve main/held-key affordances and test every affected narrow case.
- A pending duplicate is coalesced or answered “copy in progress”; do not queue additional writes. A later explicit copy after settlement may copy the same captured descriptor again and starts its own success interval.
- Each acknowledgment/timer is checked against its operation token and page/root epoch. An old timer cannot clear newer success, and a late old result cannot overwrite a newer failure or display success in a new root.
- A failed/unconfirmed attempt clears its success claim. Repaint, resize, language change, notifications, reconnection and expiry never call a clipboard/host/control effect.
- Expiry is based on the same supplied page time used to render, at nowMs >= expiresAtMs. Fold the next expiry into the existing page repaint scheduling and re-arm it on acknowledgment; do not add a permanent polling interval.
- Close/root change/VM departure disposes the page feedback lifetime. An overlay may hide the bar; elapsed time still expires normally and feedback is not replayed when the overlay closes. Language changes translate current feedback without copying again.
- If selection changes within the same root while a copy is pending, the operation still concerns its captured descriptor, never the new selection.

Null/absent feedback must preserve existing legacy output byte-for-byte. Passing nowMs explicitly is required on the affected production/test route.

Sources: [candidate BarInput][F1], [candidate footer/bar split][F2], [page rendering/repaint][F3], [architecture rules][F4], [design §3.7][D1].

## 6. Log, clipboard and effect lifetime

### 6.1 Fixed-run Log: production path fallback, no viewer launch in this stage

For the captured managed headless run, use **delegationCollector.home**, captured from the actually opened collector, as the core HUD_HOME. It is already readonly/public on HudDelegationCollector. **Do not use getHudHome(): that function denotes CODEX_HOME/hud, a different store.** Do not re-read a changed environment to select another home midway through the operation.

Use RunArtifacts.open(home, capturedRunId), never create. Check available RunMeta against the captured run/link/source identity. Derive exactly:
- <validated run directory>/stdout.log
- <validated run directory>/stderr.log

Both streams are part of the action, labelled separately. Preserve the fixed run even if a later collection presents a replacement currentRun; do not follow the replacement. Path output is local to the user and passes the existing external-text sanitation route.

If a stream is probed, use the existing bounded readLog API. A zero-length result does **not** distinguish an empty stream from a missing stream in this API. Therefore do not label it “file exists”, “complete log” or “missing” from that result alone. Expected paths may be shown as expected paths with an honest no-data/presence-unconfirmed note. Unsafe directory/file ownership, symlink, replacement, invalid identity or access failure is an unavailable diagnostic, never a successful open. Never create directories or empty logs to make the action succeed.

**This stage starts no log process and creates no surface**, even if a test supplies a host port for Open. The production Log effect is the two trusted fixed-run paths and their truthful availability status. It neither concatenates stdout/stderr into a fictitious chronological stream nor automatically copies a path.

Automatic Log panes are deferred with the host/viewer composition prerequisite. That future work must use an unmanaged surface (managed: null), fixed executable/argv, the existing HostAdapter, both-stream identification, safe bounded reads and a concrete viewer lifetime. A bare tail -F on a pathname after one validation loses RunArtifacts' subsequent no-follow/replacement protections. Do not introduce it here. The current hud-run logs command has no shipped --follow option.

For the future viewer, dispatch/launch acknowledgment unknown means possibly launched: no second pane, no fallback launch, no automatic retry. HostAdapter currently exposes no general close/cancel operation for an unmanaged viewer. A brief must settle ownership, limits and cleanup before adding such a viewer; TPD1 must not invent a close method or destroy a managed pane. Recording this dependency is the resolution, not a new runtime release.

Sources: [collector home][L1], [core artifacts][L2], [existing logs CLI][L3], [distinct legacy HUD home][L4], [HostAdapter][H3].

### 6.2 Clipboard: an acknowledged one-shot route, not terminal escape optimism

The selected initial production clipboard provider is **Windows clipboard through the already supported WSL environment**, when its installed Windows PowerShell is available. This is a copy transport inside tree-page.ts, not a new HostAdapter method, new harness/launch profile, public CLI command, dependency or setting.

Production selection is explicit: on the WSL route, resolve the existing powershell.exe executable once to an absolute path and freeze that choice. Do not install software, modify PATH/Windows settings, enable interop, bypass execution policy or probe arbitrary executables. If the route cannot be established, clipboard is unavailable. A cloud Linux executor without it exercises the unavailable path; that is not a platform qualification failure disguised as a copy pass.

Invoke the provider with a fixed argv including -NoLogo, -NoProfile, -NonInteractive and -STA, and a compiled-in constant command body. Pass the captured descriptor.displayCommand only as encoded **stdin data**. Never put it in -Command, use -Command - to read it as code, evaluate it, interpolate it into the fixed script, trim it, append a newline or reconstruct it from descriptor fields.

The fixed provider may load the system Windows Forms clipboard assembly and call SetText(text, UnicodeText), then GetText(UnicodeText) and ordinally compare the result with the same decoded input. Only a successful exact comparison produces a fixed acknowledgment token. The parent accepts success only with that token and exit code zero. Use lossless transport encoding with a validated round-trip; reject unrepresentable/NUL/oversize input rather than alter it. A 256 KiB payload cap, 1 KiB acknowledgment-output cap and 5-second operation deadline are adequate bounded IPC limits for this route. They are transport resource bounds, not a relaxation or replacement of any project performance gate.

The provider reads back only to verify this requested write; it does not print, save, send or log the clipboard's contents. Clipboard contention, mismatch, nonzero exit, malformed acknowledgment, launch error or timeout must not display Copied. Distinguish a known pre-write unavailable result from an unconfirmed outcome after submission. Do not restore old clipboard content or clear the clipboard on shutdown, because that could overwrite a later user copy.

Microsoft documents the UnicodeText clipboard API, its STA requirement and clipboard-contention failures. The fixed code/data separation and exact acknowledgment are this ruling's implementation design, **not a claim that the WSL bridge has been executed or qualified here**. [Clipboard.SetText](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.settext?view=windowsdesktop-10.0), [Clipboard.GetText](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.gettext?view=windowsdesktop-10.0), [PowerShell executable options](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1).

Do not treat a successful tmux load-buffer as proof of system clipboard delivery. Do not use unacknowledged OSC 52 as success. Do not add xclip/wl-copy background clipboard owners, browser clipboard, network relays, macOS transports or configurable shell snippets in this stage. These would need an explicit follow-on transport scope rather than an opportunistic fallback.

At most one provider child is in flight. Capture the text at dispatch, then retain it unchanged through completion even if the VM changes. A later attempt is an explicit new user action, not a timer retry. Kill/abort only the exact owned child on page close or deadline, clean listeners/timers, and suppress late UI updates. If termination cannot be established, report an unconfirmed operation and disable further provider launches for that page rather than accumulate children. No process-name or pattern kill and no other user's process control.

Unavailable clipboard leaves the existing captured command available for manual copying through the page's bounded sanitized diagnostic presentation, labelled “not copied”; do not fabricate an Inspector implementation or silently truncate a command and present the truncated text as copyable. When it cannot be displayed in full in the owned surface, report that limitation rather than execute or alter it.

### 6.3 Control semantics remain unchanged

Reconcile uses the exact captured ActionDescriptor object and its displayCommand. No fresh descriptor lookup, substituted run/requestKey/HUD_HOME, writer call, shell evaluation of the descriptor, reconcile CLI invocation, cancel, resume, signal or managed-pane input is allowed.

MVP Resume remains diagnostic-only with the existing translated text, never a clipboard call. Enter/Space/v and activity targeting inspect only. The clipboard helper process is not execution of a run-control command.

## 7. Production-connected test seam

Keep the seam inside src/tree-page.ts. No new utility module or adapter API is needed.

1. Guard the module entry so importing it does not start runLivePage, attach terminal listeners, instantiate collectors/writers/model services, run profiling or launch children. Move eager page-start initialization such as runtime identity capture into the guarded launch path where necessary; this is a bounded import/lifecycle change, not a collector rewrite.
2. Extract/export one in-file page-dispatch factory or equivalent controller. Its monitor-input route must actually call handleMonitorInput with the retained drawn frame and execute that result through the new action branches. The live page's existing dispatch loop must call this same implementation; do not leave a second production-only action switch.
3. Pass explicit ports for current state/VM, fixed core HUD home, optional HostAdapter, clipboard child runner, clock/scheduler, notice/render callbacks and disposal. The default clipboard wrapper is production code; tests replace the child runner beneath it, not the complete copy behavior in every test. There is no environment-selected fake in production.
4. Capture frame/target/descriptor before dispatch can render or await. Async work may consult the current VM only for gate revalidation, not retargeting.
5. Keep the three actual page reconcile paths and activity-target handler connected to the controller/helpers used by tests. Each call must pass the current VM in argument six, the intended nowMs in argument five, and explicit null when leaving delegation. Test and review the actual three call sites, not an illustrative reconstruction.
6. Preserve the surrounding prefix/main-pane forwarding, settings/activity/observability routing and cleanup. The extraction does not move collection/worker ownership into the dispatcher.

Required evidence includes a key and mouse action flowing through the real production-used monitor-input/controller path to its effect, plus proof that the live dispatch site uses that same path. A unit test of an orphaned executeAction helper alone does not pass. The final reviewer must verify this wiring in the diff and the executed test coverage.

## 8. Complete minimal eventual whitelist and conflict check

Production files, and only the described slices:
1. src/tree-page.ts — action dispatch; captured targets; optional fail-closed host port; ID-only delegation navigation; core-HUD_HOME log path handling; bounded clipboard provider; effect state/lifetime; module entry/test seam; activity target; three reconcile calls.
2. src/render/monitor.ts — copy-feedback input/forwarding only.
3. src/render/control-bar.ts — pure non-interactive copy-success status and its layout/hit spans only.
4. src/render/i18n.ts — the introduced TPD1 messages only.

New test files:
- tests/unit/tpd1-dispatch.test.ts
- tests/unit/tpd1-effects.test.ts
- tests/unit/tpd1-feedback.test.ts
- tests/unit/tpd1-reconcile.test.ts
- tests/unit/tpd1-activity-target.test.ts

Test helpers stay inside those tests. Existing fixtures, fake host, S3 action/types/input helpers and all other sources are read-only. No snapshots/baselines are blindly updated to bless a regression.

Dispatcher-owned records, serialized and not part of implementer source ownership:
- docs/cloud/rulings/tpd1-effect-boundaries-20261104.md for this returned ruling;
- an exact conditional amendment to docs/cloud/TPD1.md when the dispatcher records the handoff;
- docs/cloud/handoff/tpd1.md and evidence under docs/cloud/handoff/tpd1/;
- factual STATE/plan updates at the appropriate stage.

The implementation branch is not created now. No other source, docs, CLI, bin, contract, package/dependency/configuration or generated file is added to the whitelist.

Conflicts:
- **B10B:** monitor/control-bar/i18n are overlapping S3 files, intentionally owned here only after actual S3F merge. Do not work on them concurrently with an active B10B remedy.
- **B10D:** tree-page is a same-file overlap. Its collector/worker wiring stays untouched; record hunk ownership and serialize if a later change is not mechanical. No src/collectors/** change is granted.
- **B9/B16 data:** no new NativeMetadata, host projection, conflict descriptor, resume gate or collection field. Exact labels and host observation production remain with their separately briefed owners.
- **DOC2:** its design-document work is disjoint from these code files. This addendum does not extend DOC2's permitted amendment list; shared records remain dispatcher-serialized.
- **Host/integrations/core:** all read-only. No new HostAdapter method, native host profile, ledger writer or capability promotion.

## 9. Acceptance delta and required tests

Retain the existing TPD1 map's full action/reconcile/activity invariants. Add the following concrete failing-before assertions.

### Dispatch and targets
- Render a frame, send actual o/L/R and control clicks through the production-used dispatcher, and assert the recorded effect. Test Enter/Space/v and repaint produce none.
- For Open, use distinct bindingGeneration and occupantGeneration. Test valid focus, adapter null, missing observation, uncertain state, stale/unknown check, occupant replacement, changed current run, changed root/source, locator mismatch, exception and change during awaited lookup/check. No raw tmux call or replacement focus.
- Preserve the exact seen descriptor object and command through VM/selection changes. Include quotes, spaces, dollar signs, semicolons, newlines and Chinese paths as data; never a control-process invocation.
- Switch sends the exact permitted Codex native ID without a delegation title label; narrow/no-ID picker and duplicate names refuse. Legacy exact labels and root/home behavior remain.

### Log and clipboard
- Headless active/uncertain/ended, with/without reports, maps to the same captured run's two stream paths. Visible/native/root/conflict/put-away rows do not acquire Log.
- Set core HUD_HOME and CODEX_HOME/hud to different synthetic locations; assert only the opened collector home is used. Replace the environment/VM after dispatch and prove no retarget.
- Missing/empty streams are not falsely distinguished; unsafe permissions, symlink, inode replacement, missing/mismatched metadata and inaccessible artifacts are truthful failures. No mkdir/create/write or viewer launch.
- Exercise production clipboard request construction with a fake child runner: fixed executable/argv, data only on stdin, exact encoding, fixed acknowledgment plus zero exit required, no hidden fallback.
- Success, unavailable binary, output mismatch, clipboard contention, nonzero exit, timeout, oversized/unrepresentable payload, page close and uncertain child termination. None of the latter displays success or queues/retries another child.
- Repeated input while pending yields one child. After settlement a new explicit copy may run. A stale completion cannot overwrite newer state. Resume diagnostic creates no child.

### Feedback and integration
- EN/ZH success in the actual bar at acknowledgment+0 and +1999 ms, absent at +2000 ms; changed language, repeated successful copy, stale expiry callback, close/root change and overlay return.
- All five looks, representative normal/narrow widths including 48/32/24 and extreme/zero sizes, color/no-color and icons-off; exact visual widths and no clickable feedback region. Rendered controls and key availability agree.
- No-feedback legacy frames stay byte-identical. No renderer reads the clock or performs effects.
- All three real reconcile call sites use argument six correctly; explicit VM→null differs from omitted/undefined, including modal-suppressed monitor rendering. Preserve file/worktree/focus/revealed/details scrolling.
- Activity target reaches an unambiguous current canonical row with an empty legacy tree; root diagnostics, missing historical target, duplicate bare IDs across source/harness, removed target and hidden destination are handled safely. No claim of new activity ingestion or B10B-s4 Inspector content.
- Importing the testable page starts no live services; the live page uses the same dispatch implementation the tests exercise.

### Checks and evidence, only after release

Runtime remains Node 22 >= 22.13 or Node 24. Every test command must have synthetic inputs, isolated temporary HOME/HUD_HOME and owned-process cleanup. Preserve all existing failures, incomplete stages and the permitted single named-flake rerun with both logs.

Focused after the actual builds:
- node --test dist-test/tests/unit/tpd1-*.test.js
- the applicable merged S3 actions/input/selection/width/legacy regressions.

Full unchanged README check set:
- npm run build && npm run build:test && npm run build:hud-mcp
- env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=$(mktemp -d) npm test
- npm run test:core
- npm run test:visual
- npm run test:hud-mcp
- npm run format:check
- npm run check:fixtures
- git diff --check

Apply temporary-home isolation to the complete session, not only the illustrated npm test invocation. If npm test stops before its separate mjs stage, that stage is not passed. Record exact source/build/runtime, commands and complete raw outputs.

Preserve existing S3 timing: at least 1,000 samples after 200 warm-ups, nearest-rank and at least three runs under the governing runtime protocol; no-change p99 <=2 ms, compact changed <=10 ms and rich changed <=15 ms. The real reconcile/key/rerender work belongs in measurement. Do not measure only the new helper, trim tails, change fixtures or invent a cold-tick gate. Existing broader HUD gates remain unchanged.

Real Herdr, real tmux/CLIs, system clipboard under WSL and formal WSL performance qualification are **local-only owner verification**, not simulated cloud passes. This consultation ran none. Provide a focused owner prompt when useful and continue independent authorized cloud work; do not revive assistant-run local testing. Fake dispatch/provider tests cannot be reported as actual host/clipboard qualification.

## 10. Release prerequisites and usable handoff

Before implementation:
1. Record the actual accepted S3F merge commit on universal-hud and required green merged-tree evidence. NEXT submission, local strict subsets, composite source acceptance or a saved ruling is not a substitute.
2. Revalidate this four-file/test whitelist and the referenced S3 interface blobs against that accepted base; confirm no concurrent overlapping owner.
3. Record the explicit staged acceptance wording and the three deferred deliverables: trusted production host Open composition, automatic safe Log viewer, exact narrow-picker labels. Keep them tracked, not silently marked complete.
4. Supply this addendum plus the existing TPD1 map, S3/DOC2 rulings and original brief unchanged to the eventual implementer. Use the selected bounded clipboard route and null production host deliberately.
5. Obtain the ordinary compute/lifecycle release through the existing queue workflow. This read-only consultation grants none.

Eventual assignment: implement the TPD1 dispatcher stage on the actual accepted base, only in the whitelist; produce the listed tests and exact evidence; return remaining producer/local qualification items honestly. Do not resolve a new dependency by editing another package. A materially changed interface, needed new file, unsupported transport or inability to keep the provider bounded returns a scoped design question before expanding.

**Contract/gate/profile disposition:** no contract, numerical gate, harness/host supported-profile matrix, run-control capability, real-resume gate or queue order changes. The rendering ownership extension and staged package goal are explicit decisions. The WSL clipboard transport is new implementation of the already requested copy effect, not a new verified host/harness capability; its actual environment result remains untested here. The host/data/viewer dependencies remain unsatisfied and separately owned.

Final acceptance still requires the fresh Oracle verdict and verified evidence. Integration still requires the authorized history-preserving --no-ff merge, the complete green check set on the actual merged tree, then push and factual status updates. Never touch main, force-push, rewrite history, stage node_modules or import an unaccepted dependency.

## Sources

All repository links are immutable pins. “Candidate” links refer to unmerged NEXT.

[H1]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/collectors/delegation.ts#L963-L990
[H2]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/core/link/host.ts
[H3]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/core/interfaces/host-adapter.ts
[H4]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/integrations/herdr/host.ts#L176-L290
[H5]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/integrations/herdr/transport.ts#L29-L85
[H6]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/integrations/herdr/registry.ts
[C5]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/contracts/05-capabilities.md
[P1]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/core/link/types.ts#L11-L15
[P2]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/collectors/subagent-tree.ts#L190-L224
[P3]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/utils/session-navigation.ts#L223-L303
[P4]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/delegation/actions.ts
[F1]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/control-bar.ts#L50-L70
[F2]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/monitor.ts#L778-L798
[F3]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/tree-page.ts#L655-L753
[F4]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/ARCHITECTURE.md#L766-L810
[D1]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/design/hud-information-design.md#L231-L252
[L1]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/collectors/delegation.ts#L820-L840
[L2]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/core/run/artifacts.ts#L153-L408
[L3]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/core/run/cli.ts
[L4]: https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/src/utils/codex-path.ts

Additional governing sources:
- [Original TPD1 brief](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/TPD1.md).
- [Existing prerequisite map](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/rulings/tpd1-prerequisite-source-action-test-map-20261103.md).
- [Queue ruling](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/rulings/queue-progress-20261103.md).
- [Candidate S3 ruling](https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/docs/cloud/rulings/b10b-s3.md).
- [Contract 03](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/contracts/03-lifecycle.md).
- [DOC2 prerequisite](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/rulings/doc2-prerequisite-20261103.md).
- [README checks](https://github.com/CartmanFatass/codex-hud/blob/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86/docs/cloud/README.md).
- [Current NEXT documentary delta](https://github.com/CartmanFatass/codex-hud/compare/00b2d197ce165882a768b86c5c2b650667528486...60b5959d02516e73d30cd5a55913eb6988a94ea9).

Method: read-only repository/source inspection and official API documentation lookup. No repository edit, branch/worktree, dependency installation, build, test, benchmark, process probe, host/clipboard action, local-computer session or subagent was started. The only write is this requested standalone ruling artifact. All tests above are requirements, not executed passes.

