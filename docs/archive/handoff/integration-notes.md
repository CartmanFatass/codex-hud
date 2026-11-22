# Integration notes (copied from the local orchestrator scratch, 2026-11-03)

Handoffs between work packages: what each merged package leaves for the next. Paths under `tmp/tasks/` refer to
the former local scratch and are not in git; the reviews they cite are in `docs/reviews/` where they were published.

- B4 brief: own the launch-message format; B8 parses a provisional '[hud-launch]' + JSON {linkId, claim} fallback marker (retains uuid/linkId/SHA256 only); normal path = env claim, no plaintext claim in prompt.
- Ledger/hud-mcp runtime floor: Node 22.x >=22.13 or >=24 (decided 2026-11-01 from B2 finding: readOnly ignored before 22.12, flag needed before 22.13). Update plan A9 conditions row B1.
- B4: launch hud-run as process.execPath + B3a's exported supervisor flags + bin/hud-run (memory saving); the shebang path is unoptimised.
- B6 (from B45 acceptance): packages/hud-mcp/src/server.ts catch returns raw error.message as the tool outcome code;
  normalise to a whitelisted code set (busy / internal_error / known refusal codes) so SQLite or fs messages
  (possibly with paths) never reach the parent model.
- B11: B45's DelegationService.resumeLocal is the management resume entry; trusted executable/version discovery for
  capability attestation is a B11/release requirement (main supplies none, so production stays unverified).

## B12R (merged 81f0e95) → B16 / B10 / B6
- Keep the acquired ObservationStore, its lease and the lazy reader lookup alive together for a writer's lifetime.
- Capture checkpointBoundary from the same ReaderResult before the single merge; store.prepareCheckpoint(checkpointFormat, base ref); witnessPreparedObservationBoundary → publishPrepared. Keep the prepared token for unchanged recovery; never derive content identity from offset/mtime.
- B6/status/wait/paint read readProjection (keeps the original observationStamp); collectors use readRecovery with the exact target and budget; readCurrent is compatibility only.
- recovery_catching_up with coverage when slices run out; record_needs_larger_slice only for a real inline-byte shortage.
- P-06-7 per-sample tick budget unmet on native WSL disk (COMMIT under DELETE/FULL); Oracle 6 Q2.

## B3a-R1 (merged a31809b) → B3b / B6 / B14
- Shared GroupExit from src/core/types/supervision.ts (verified_wait | native_unknown). Default headless = native_unknown, native_exit/shell_exit null, reason scope_ended. B3b must consume the same type.
- Production dependencies: /bin/sh (any POSIX sh incl. bash-as-sh), /usr/bin/env (GNU, -i/-S/--default-signal), /usr/bin/mkfifo; cold preflight refuses before registration.
- launchNodeGroup is compatibility only (trusted seam, exact-native tests); remove after B14 acceptance of the light leader.
- Waiter-only death: scope held, result unknown, explicit INT/KILL ends control; not auto-completed (documented limitation).
- B14/G02 formal matrix (B45/MCP H/R=1/1 and 2/10, real WAL, distributions) still to do; file-fake numbers in tmp/tasks/B3a-R1/report.md are not that gate.

## B16 (merged 969f2cf) → B6 / B10
- Collector: StatusWriter over the SAME acquired ObservationStore (lease, lazy reader lookup alive together); prepare(readerResult, transcript sources from that result, target) → publish(token, external facts, ruleVersion, nowMs). New ReaderResult needs a new prepare even at the same offset.
- B6 status/wait and B10 paint read readProjection: summary.statusProjection, continuity, notices/seqDomain and the ORIGINAL observationStamp; never re-emit notices on read, never re-classify.
- B6 composes lifecycle (currentRun/runHandshake/latestReportForRun) from its own ledger snapshot; the writer does not.
- Report notices need the real ledger report.received seq (else report_seq_unavailable, no notice).
- Open for Oracle 6 (Q7): appendix rows C01/C04/C21/C30/C33/C46.

## B3b (merged 49b1735, eval X2 arm C) → B6 / B13 / B14 / NOTIFY

- Visible launch is admitted only as the pane shell's direct foreground job (TTY stdin, PID == PGID == terminal
  foreground PGID); wrapper and background forms are refused before registration. Skills/templates (B13) must
  launch `hud-run` exactly in the documented direct form.
- Visible cancel never signals: `cancel.unconfirmed` with `visible_scope_control_unavailable`, slot held, until
  Oracle 6 Q5 rules on a stable group-control mechanism. B6 `delegate_cancel` must surface this honestly.
- Supervisor death: run `uncertain`, slot held, nothing automatic; containment question is Oracle 6 Q10 (NOTIFY).
- Idle cost R=1, 60 s: 1 tick, 12 heartbeat writes, RSS ~79 MiB (B14 baseline input).

## Batch 4 (merged a12d188: B16-P, B3-H, B6; B12D 696e36c; O6APPLY 8d20949)

- B6 → B11: the wait core lives in `src/core/wait/` (snapshot → subscribe → snapshot → wait, drain to high-water);
  `hud run wait` must reuse it unchanged. Client timeout: conservative short wait unless `waitTimeoutVerified`
  (B11 wires verified client-profile evidence).
- B6 → B13: visible cancel returns `cancel.unconfirmed` / `visible_scope_control_unavailable` (Pro: MVP limitation,
  tell the user to stop the run in its pane); status/wait never write; stable error codes; blocked report →
  needs_human (H12); first baseline silent (H11).
- B6 real-process matrix is opt-in: `B6_PROCESS=1 node --test dist-test/tests/unit/b6-cancel.test.js` — part of
  every acceptance that touches run control.
- Open P1 (fix in progress in B3-H): heartbeat ledger_busy stops supervisor control (`tmp/tasks/B6/heartbeat-busy-repro.md`).
- Pro (2026-11-02): P-06-7 = p99 < 50 ms and max < 200 ms over full ticks (≥ 10 000 samples, 3 starts, rolling
  windows); store open must not happen inside an incremental tick (first open 292 ms); SQLite linked version must
  be recorded (WAL-reset fix ≥ 3.51.3 / 3.50.7 / 3.44.6). Contract wording to be applied by PROAPPLY.

## B11 Oracle ruling (oracle-1.md, 2026-11-02) — open items for B14/release

- **Evidence convention for local initiation (owner: B14/release, decide before B14 promotion).** The shared capability key has no initiator field and no defined `versions.mcpClient`/topology encoding for local_user→hud-run→Codex (CLI-initiated `hud run resume`). B11 ships the matcher input and caches executable facts, but production local resume stays `capability_unverified` until B14 publishes the convention (how one cell represents coverage of MCP-parent vs local-initiated routes without duplicate complete keys). No `local_user`/`none` sentinel.
- **MCP long-wait attestation:** needs an exact parent/client cell whose accepted evidence covers the configured client deadline + transport margin (T-05-14). `capabilitySupport()` alone is insufficient (accepts placeholder versions). B14 must ensure the promoted parent cell includes this.
- **B6 profile selection:** `DelegationService.invoke` picks timeouts from the first harness/source-root match; B11 guards it in main.ts (duplicate matches → false). Cleaner fix (pass the selected profile through the service) needs a `delegation.ts` edit — candidate follow-up.
- B13 documents the shipped refusals and the waiter cursor rules; B19 reuses B11's fixed-run read-only drain and parent binding.

## B3-H heartbeat busy fix (merged 10d6e7f)

- Transient `LedgerBusyError` on heartbeat publication keeps control alive; fence loss still stops it. One stderr line per busy episode (visible mode: may appear in the supervisor's stderr).
- `tests/run/b3h-heartbeat-busy.mjs` (~80 s, real processes) is not in `npm test`; B14 runs it with the other `tests/run/*.mjs` process suites.

## B7 Herdr layer (merged f47feed) — handoffs

- B11/B4: one shared Herdr client/registry per explicit socket; supply a trusted server ProcessStamp for that endpoint and a source resolver returning {sessionRef, harness}. Ambient HERDR_* is not proof.
- B11/B4/H08: the registered supervisor calls `host.recordLocator` with its own verified foreground stamp → `recordRunLocator(ledger, runId, supervisor, fixed)`. Supply the committed locator reader for restart reconstruction and the core status reader for focus/sendKeys.
- First prompt: `InitialInputPermit` minted only in the original launching composition, after locator/readiness and interaction.input permission; never reissued after recovery.
- `closeSurface` refuses every close (protocol 22 has no guarded compare-and-close); B3b-C owns any future close. User closes visible MVP panes.
- B14: real harness/source behaviour, delivery-time replacement, product cells, performance matrix unverified. `npm run test:herdr` now runs fake + private-server tests (no live workspace).

## B11 launcher (merged 6035ff0) — handoffs

- `hud run wait`: fixed run, read-only, 2 s parent checks, 29 s ledger/watch recovery slices, default deadline 2 h; `--json` returns one page (drain with runId/nextSeq while hasMore), `--notify` one bounded line that does not advance the parent's cursor. B19 reuses this read-only drain and parent binding.
- Production launch/resume cells unverified → `capability_unverified`; hook-bearing shell forms refuse (`shell_hook_target_unverified`). hud-mcp `waitTimeoutVerified` composition passes `actual:null` (always false until B14 supplies parent/client evidence).
- Herdr host composition (B7 handoffs: locator recording, first-input permit) is NOT wired by B11; visible delegated launch through Herdr remains an integration item (B14 prerequisite).
- Process suites to run by hand: `tests/int/b11-process.mjs`, `b11-drain-signal.mjs`, `b11-wait-performance.mjs`.

## B9 (in progress) — decided 2026-11-02

- B9 reads `claims.claimHash` only inside its own read-only adapter; projection carries the verification result only.
- B9 never calls `HarnessAdapter.children()` on the tick; B10 wiring must supply budgeted native child lists (charged bytes/records, loaded flag) per B9's stated input contract.

## B17 (in progress) — decided 2026-11-02

- Oracle ruling (B17/oracle-1.md): explicit old backend opt-in + historical feature defaults = legacy grant (no regression for current Codex-only users); original trusted agy profile only.
- Cross-restart account/profile continuity behind an unchanged endpoint is unprovable (old settings carry no nonsecret account identity). MVP: no persisted baseline; documented limitation. v1.1 candidate: persisted nonsecret baseline identity as compatibility metadata.

## B21 (in progress) → B22 — decided 2026-11-02

- B21 attribution (oracle B21/oracle-1.md §6): caused = cancel.step.requestSeq == retire.requested.seq + acknowledged first INT + validated later scope-alive + later full R/Q; not_caused = complete R/Q strictly before the retire request; everything between retire intent and first signal, and competing user/policy actions → unknown.
- B22 owns: writing requestSeq on retire-initiated cancel steps, and the evidence for post-intent/pre-signal natural exits and competing requests, satisfying B21's validator (inputs/outputs in B21 report). User/trusted_local/orphan-stop `cancelled` semantics unchanged; policy never yields `cancelled`.

## B22 (in progress) — decided 2026-11-02

- Idle quiescence: B16 projection cannot prove it (no selectedSources/native completion/no-pending witness; Oracle-binding) → quiescence null in MVP, idle retirement disabled; pending approval/question may be read conservatively. Follow-up: typed quiescence witness in B16 (owner B16) plus the tail reader below. Earlier note: the facade transcript tail is unavailable (forward-only readers), so otherwise quiescence = null → idle retirement disabled, max-runtime still applies. Follow-up (not MVP-blocking for headless): bounded-tail facade reader (≤ 64 KiB, ≤ 20 ms) for Codex/Claude/pi — matters for visible retirement (B3b-C).
- Hint coordination: B19 owns `touchHint(home, runId, seq)` in `src/core/wait/hints.ts`; B22 consumes via hintSubscription plus a recovery read ≤ once per `wake.recoveryMs`. Verify the pair after both merge.

## Merge B19 × B20 segment 2 (read-control.status)

- B19 spreads `wakeProjection(...)` → `wake` + `advice:{wake}`; B20 s2 adds `advice:{...cache advice}`. A naive merge lets one spread overwrite the other's `advice`. Merged form must be `advice: {...cacheAdvice, wake}` in status (and spawn, if B19 adds advice.wake there). Add a test asserting both parts are present after the merge.
- `touchHint(home, runId, seq)` landed in `src/core/wait/hints.ts` (B19), used by report/reconcile/hud-run; B22 consumes it.

## B9 link projection (merged) — handoffs to B10/B16/B14

- API: `openLinkLedgerReader(path, scope?)` (open OUTSIDE incremental ticks, retain), `reader.read(launchMessages?)`, `projectLinkTree(input)`, `linkStatusInput(tree, key)` (B16 fragment), `planLinkRead(tree, {remainingMs, afterKey?, minimumBytes?})` (one read grant at a time).
- Cost: 20 nodes p99 ≈ 3–6 ms; 200 nodes × 20k anchors p99 28.6 ms / max 38.8 ms (snapshot + projector). B10 must call it only when the ledger high-water/data_version or the collected envelopes changed (memoize), not every tick; B14 measures the full tick.
- B10 supplies metered native topology (children with charged bytes/records, loaded, coverage); B9 never calls `children()`.
- B14: larger histories/conflict closures under active writers; row decode volume is not bounded by the 200-row display cap.

## Load-dependent ledger_busy failures in existing tests (watch; B14 item)

Seen under 4–5 parallel agents running suites: B3-H `H07 real headless supervisor receives SIGINT…`, hud-mcp `accepted spawn`, hud-mcp `G03 old request key replays…` (resume-expected-run). All pass alone; cause = the 20 ms lock / 30 ms precommit budget under CPU/disk contention. Production impact = a transient `ledger_busy` to the caller (retryable), not corruption. B14: run the suites under a declared concurrent load profile and decide whether tests should retry `ledger_busy` explicitly or the profile is out of scope.

## F08 under concurrent write load (pre-existing; B14 decision item) — from B19 paired benchmark 2026-11-02

- Fresh spawns with 4 background writers (each: one synthetic INSERT transaction + 1 ms pause): base f5b1dea 59 ok / 941 busy (94%), accepted p95 58 ms / max 68 ms at ~18 commits/s per writer; B19 315 ok / 685 busy, accepted p95 30 ms / max 52 ms at ~52 commits/s per writer. Artifacts: tmp/tasks/B19/paired-*.json. B19 does not worsen it.
- The 20 ms lock / 30 ms precommit budget makes `acceptIntent` mostly return `ledger_busy` under sustained ~70+ commits/s; realistic MVP write rates are far lower (heartbeat 1 per 5 s per run, reports, terminal imports). B14 must declare the supported write-load profile, measure F08 under it (spawn busy rate, accepted p95), and decide whether callers retry `ledger_busy` (skill/MCP) — not silently widen the budget.

## B22 headless policy retirement (merged baff507) — handoffs

- Policy is frozen into the digest-bound launch input (`src/core/run/retirement-policy.ts`, `freezeRetirementPolicy`); `prepareCodexLaunch` takes `retireRecoveryMs` (hud-mcp passes `config.wake.recoveryMs`). Launch/ticket digests now include the policy; capability/profile fingerprint algorithms unchanged.
- B19 merge: B22 consumes `hintSubscription` + exact-format hints only; producer wiring (`touchHint` on report/terminal/uncertain) is B19's. After B19 merges, run one integrated check: a real `delegate_report` hint wakes the after-report deadline (not only the 30 s recovery read).
- B13 (what users see): headless reports hold the slot until real termination. Defaults: implementer 10 min / reviewer 2 min after report, blocked-wait 60 min, max-runtime 4 h, grace 10 s. Policy end = `ended` with its own outcome/cause/attribution; `unknown` timing stays explicit. Visible: user closes the pane.
- B14/P-N6: tests are synthetic processes; run real Codex/Claude/pi signal, transcript-preservation and resume-integrity probes before promoting cells. Perf: armed run 0.13% CPU, 1 snapshot per recovery interval; ladder adds 35–37 ms.
- Owner-accepted limits: idle retirement off (no positive quiescence witness); supervisor death mid-ladder → uncertain + slot held, explicit Q/R releases.
- Flake seen: `b3h-heartbeat-busy` 4/5 once (ReadControlService.cancel caller-budget LedgerBusyError), 5/5 on rerun; same load class as the ledger_busy note above.
- A/B 2026-11-02 (load avg ~2–3, B17/B19 running): `b3h-heartbeat-busy` "real instance fence loss…" fails with `ledger_busy` from `ReadControlService.cancel` → `remaining()` (caller write-lock budget, test line 132) on base 9e348e0 1/3 and merged baff507 2/3, identical stack. Pre-existing; B14 to fix the test's cancel budget or retry under load (logs: tmp/tasks/B22/merged/ab/).
- Test temp-dir leak: ~2600 `/tmp/hud-*` dirs accumulated in 3 days (hud-keys, hud-model-cache, hud-reply-language, hud-health-cwd, hud-cmd, hud-model-runtime…); those tests do not remove their temp dirs. B14 item.

## B17 materials (committed 7f07c5a, merge pending acceptance) — handoffs

- B10/B10A: any model-bound text goes through `materialRequest`/`buildMaterials` (`src/core/materials/`, README there) with verified refs/origins/record identity, positive `MaterialAuthority`, resolved recipient and declared coverage; derived/delegated notes via `DerivedMaterialStore`. Material building stays off the tick (p99 2 ms/call, outside paint). B17 added one field to `src/tree-page.ts` progress.update (`rootRolloutPath`); B10A edits tree-page.ts too — keep it.
- `src/collectors/{small-model,briefing,model-jobs,progress-summary,model-probe,model-runtime-store}.ts` are B17-owned now; B10A may read, not change, them.
- B14/v1.1: cross-restart account/profile continuity is unproven (no persisted baseline identity, owner decision); exercise provider-hidden routing/account changes on real profiles.
- Flake seen at B17 merge (concurrent B19 suites): `b6-wait-status` "B6 idle wait has zero writes…" read count 4 !== 3 (exact `reads === 3` in a 100 ms wait); 5/5 alone. Add to the B14 load-flake list.

## B19 parent wake (merged with B17/B20s2/B22) — handoffs

- Integrated: real `delegate_report` hint arms B22's after-report deadline in ~171 ms (vs 30 s recovery), with a negative lost-hint control (`tests/int/b19-merge-report.mjs`). Advice in status/spawn = `{...cacheAdvice, wake}` (tested).
- B13: Claude parents run `advice.wake.armCommand` via real `run_in_background`; keep the parent's own per-run cursor, drain `hasMore`, resync lost cursors with status/`asOfSeq`; ignore stale-generation waiter lines; a native wake is only a hint, validate ownership before acting (Codex stale queued-row residual accepted).
- B14: P-N1/N3/N4/N5/N7 on real harnesses (thread-id equality, queue pickup, pi extension scheduling, Claude notification content, inherited-pipe death binding). Fake transports prove sender/lifecycle only. Production pi identity is `none` until phase C supplies verified pi session facts.
- Approved amendments (pre-send charged attempts, separate retry batch, strict page allowance, bounded terminal tail max(5 min, 10×recoveryMs)) are applied in contracts 02 A1 / 06 A6 and design §3.1/§3.4/§3.10.
- B10A: consume `wakeProjection` (design row #27); do not reimplement.

## B10A decisions (2026-11-02)

- Approved: pure `wakeProjection` types/projection move to `src/core/wake/projection.ts`, re-exported by `packages/hud-mcp/src/wake-state.ts` (readWakeState and I/O stay); capacity counting rule moves to core, re-exported from `src/ledger/intents.ts`; additive optional `termination`/`terminalNote`/`reconciliation{cause,missing}` on `RunExecutionProjection` (reuse B21 Termination). No behaviour, schema, contract or writer change; B19/B21/B9/B16 tests unchanged and green.
- Approved: optional `collectTopology(ref, budget)` on `HarnessAdapter` (children() unchanged; Codex forwards to B10A's metered collector; Claude/pi return explicit unknown coverage). Read-only current-context/scope validation inside the B9 read snapshot for wake-state parity (no writes, cost in the B9 share).

## B10b rendering (started 2026-11-02 after B10A M1)

- Worktree MyHUD-wt/B10B, branch b10b-render from 2681513 + 93fa6b1 = read-only snapshot of B10A M1 contract files (view-model.ts, capacity.ts, link/limits.ts, link/terminal.ts, wake/projection.ts, types/observation.ts). Merge order: B10A first, then b10b; on add/add conflicts in those six files take universal-hud (B10A) and rebuild/fix b10b.
- Segments: s1 presentation core + bar + statusline; s2 panel tree/cards/scenarios (a)–(h); s3 Inspector + actions + full perf. Frontend-implementer implements; DESIGN-Q items go to a Fable max subagent; review per segment by a Codex sol max reviewer in its own tab.

## B13 review findings that are product gaps (2026-11-02; skill now describes current behaviour)

- Role templates are not delivered to children: `role` selects model/effort only; parents must put the template in the brief. Candidate: a role-template loader in launch preparation (v1.1 / B15).
- `hud claude|codex|pi --brief <path>` does not exist; `hud pi` is `invalid_command`. Design §6 assumes it.
- Brief bytes are not persisted to `$HUD_HOME/runs/<runId>/brief.md`; `recordHandoff` (`src/ledger/notify-events.ts`) has no production caller. Design §6 assumes both.
- Successor sessions (different OwnerKey) cannot read the predecessor's runs via MCP (`unauthorized`); design §6 "observe-only" has no read path. Decide: cross-owner read grant, or carry facts in the handoff (current skill does the latter).
- Bug: visible `delegate_spawn` surfaces as `internal_error` because `visible_launch_not_in_this_build` (`packages/hud-mcp/src/delegation.ts` ~291, thrown before the capability check) is not in the `errors.ts` whitelist; should be a typed refusal. Small fix for a follow-up (owner: hud-mcp).
- B14 must check B13's skill end-to-end in the real delegation (segment 2).
- B13 s2 (2026-11-02): real-delegation acceptance uses the B45 composition (no wakeExecutable → advice.wake none) and the bounded delegate_wait path; native Codex queue pickup on an interactive parent stays B14 (P-N1/P-N3). Suspected gap to confirm: production hud-mcp may register codex_queue_v1 for a `codex exec` parent that exits at end-turn (undeliverable registration). CONFIRMED from code (`packages/hud-mcp/src/main.ts:62-68`, `wake-registration.ts:25-28`): production registers the native queue regardless of parent interactivity → fix candidate (register `none` for non-interactive parents), owner hud-mcp, B14/B15.

## B10A data layer (committed ca45a21) — handoffs

- Bar and panel share `src/collectors/delegation.ts` + `src/core/link/tick.ts`; B9 reader opened outside ticks; metered `collectTopology` (Codex real, Claude explicit unavailable); B16 merges ≤ bounded; view model `src/core/link/view-model.ts` (+ m1-shape.md). In delegated mode the legacy `buildSubagentTree` is bypassed: render `delegation.tree`.
- Perf (production collector + legacy render, n≥1000): 200 changing p99 33.9/34.5 ms, max 41.7/42.8; B9 p99 23.7/25.6. No-change wiring p99 3.33/3.45 ms > 2 ms design share → orchestrator accepted for merge; follow-up `b10a-perf` (cache unchanged zero-charge envelope snapshots, cheap memo key), target ≤ 2 ms.
- OPEN (MVP-relevant): no production path wires the B12 observation publisher, so committed observations (status/freshness from ObservationCommit) only exist where a publisher runs; until then `statusSource` is `ledger` (bounded B16 merge) or `unavailable`. Decide owner before B14 (likely B14 integration or a small BINT package).
- B14: full entry-point P-06-7 incl. root parsing, publication/render/paint, ≥10,000 samples, ≥3 fresh starts; real host/capability/launch-to-first-paint evidence.
- B10b s1 (2026-11-02): presentation core + bar + statusline pure functions done (97 tests, 42 new baselines, perf: rows p99 5.1 ms, no-change render p99 0.8 ms). DESIGN-Q 1–12 sent to Fable max for rulings before review.
- OPEN scope (orchestrator): no Claude Code statusline renderer exists in this repo; `statuslineDelegation`/`joinFirstLine` have no call site. Candidates: a `hud statusline` CLI entry injected by `hud claude --settings` (B11 area) or deferred to B15. Decide before B14.
- B10b test helpers added outside literal ownership (accepted): tests/fixtures/b10b-{delegation,bar}.ts, b10b-legacy-bar.json. Visual baselines: run prettier after `test:visual:update` (writer uses indent 1).
- B10b s1 design rulings (Fable max, tmp/tasks/B10B/design-rulings-s1.md): 12 DESIGN-Q ruled (mostly keep; alert counts form when >1 node alert, kind order `▸ · ⚑ ? ⚠ ✗ ✓`, attention/agents priorities with a delegation tree so counts survive at 80 cols); 29 design-doc amendments → v1.2 (applied by the design owner).
- NEW data requirement (design §7 #33, MVP): `LinkTreeNode.native: {title, kind} | null` (non-null iff edge native), title = Codex agentDisplayName / Claude description, kind = AgentTaskKind; filled from the collector's existing AgentIdentity (no new I/O). Without it native rows read `codex:51aa`. Owner: B10C (with the B12 publisher wiring), after b10a-perf merges.
- B10C scope (2026-11-02): native title from Codex catalog header identity; kind only via B17's authorized local-display path, else null. Claude native topology is unavailable in this build (ClaudeAdapter.collectTopology → unavailable), so Claude natives have no rows and native stays null; Claude native topology + description/agentType is a follow-up (v1.1/B15).
- B10C M1 done (in worktree): `LinkTreeNode.native?: {title, kind} | null` in `src/core/link/types.ts`, filled iff native edge by `MeteredCodexTopology.collect` from session_meta (`identityFromMeta` + `agentDisplayName`), copied by `core/link/index.ts`; kind null today (no authorized taskKind on that path). B10b renders it in segment 2 (mirror the optional field in its snapshot until B10C merges).
- B12M follow-up (opened 2026-11-02, after B10C): B12 recovery reads are unmetered — `readRecovery` selects projection_body/blob/identity before any size check and returns no I/O stats; `RecoveryIndexLookup.get/page` likewise. B10C counts their wall time and charges compact checkpoint bytes conservatively; exact 8 MiB SQLite/index accounting unverified. B12M: size check before select, return stats; B10C report lists call sites and stats shape. Codex, core, tier S/M.
- HUD_HOME default (decided 2026-11-02): CLI defaults to ~/.hud; hud-mcp requires explicit HUD_HOME (profile sets it); the HUD collector (B10C) now resolves `HUD_HOME ?? ~/.hud` like the CLI, opens only an existing private ledger, never creates it. B10C publishes by default from bar (src/index.ts) and panel (tree-page.ts). `hud claude` launches no bar/panel/statusline collector → no publisher on its own (B14/B15 scope with the statusline call-site question).
- B16 provenance gap (accepted 2026-11-02, B10C): when run.state{uncertain} and a later cause-only run.reconciliation both precede the next publish, B16's single runSource cannot carry both the latest cause seq/time (stateKey/stateSince) and the earlier uncertain-entry seq/time (first notice). B10C uses the latest selected reason + episode anchored to the real entry event. Follow-up (v1.1/B14): separate cause vs entry provenance in B16 runSource.

## B10C perf (2026-11-02, in progress)
- Retained 820 ms panel sample: lease renewal 752.7 ms, publishPrepared 21.4, B9 24.6, render 1.9, residual 19.6.
  The collect-lease renewal (an SQLite write) runs on the paint tick; if the readHead rerun still misses the gate,
  moving lease renew/publish off the paint tick is the leading structural option (route to Oracle).
- 2026-11-02 resolved: owner approved the Oracle worker route (contract 06 B10C 增补, e9e31fe). B10C merged at 44ec342
  with publishing OFF in both entries (200-node changing p99 33.2/36.1 ms, max 38.1/54.9; no-change wiring p99 1.23/1.69).
  B10D (worker) started in the same session on branch b10d-worker. B10b can consume LinkTreeNode.native now.
- Flakes seen under concurrent load in B10C interim checks (each passed alone): hud-mcp B20 advice test ledger_busy;
  focused int "Claude initial activity unknown instead of idle". Watch for recurrence (B14).
- 2026-11-02 B10b segment 1 merged (see merge commit). Flake under load (B10D soak running): run-control
  "cancel escalates INT then TERM then KILL; lost KILL wait..." failed once in npm test, passed 20/20 twice alone.
