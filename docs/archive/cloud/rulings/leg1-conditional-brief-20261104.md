# LEG1: bounded incremental legacy catalog, conditional implementation brief

Date: 2026-11-04. Role: fresh read-only architecture Oracle.
Repository: CartmanFatass/codex-hud.
Inspected integration pin: universal-hud@c9f64e5534a855b636bf70398aa4b66d9d0d4374.
Suggested archival destination: docs/cloud/LEG1.md.

**CONDITIONAL / NOT RELEASED.** This is preparation, not implementation admission, a compute window, package acceptance, production enablement, or a merge verdict. Earlier waves, an exact accepted base, an exclusive file reservation, the freshness disposition in §5, and explicit execution/lifecycle admission remain prerequisites. No tests, builds, benchmarks, dependency setup, repository writes, branch/worktree changes, or local-computer operations were performed.

## 1. Decision and remaining hard boundary

Choose one main-process, source-scoped legacy catalog with persistent in-memory inventory and dependency indexes. Update changed entries and the affected legacy tree instead of rebuilding the 20,000-entry inventory, duplicate-resolution map, adjacency map and revalidation sort on every collection. Retain the existing legacy field producers and scan semantics. Do not move the complete legacy collector into the observation worker, translate a universal view into a legacy tree, add a collector service, raise worker limits, or omit the 20,000-header profile.

There are two separately named delivery stages:

1. **LEG1 catalog engine and compatibility adapters:** owned collector code, bounded inventory, incremental query/update APIs, exact legacy semantics at declared observation boundaries, deterministic correctness/work-count evidence and collector-level timing/resource evidence.
2. **Later B10D-2 entry integration:** adoption in src/index.ts and src/tree-page.ts, existing admission/charge plumbing, scope-safe cached paints, worker/null/non-null behavior, and actual-entry end-to-end qualification. This is not part of LEG1's file ownership.

A valid catalog engine is not proof that either production entry uses it. Current entry wiring demonstrably still suppresses legacy trees when the read-only delegation view is non-null; the frozen B10D branch contains the later correction. Do not import that unaccepted branch or claim that collector-only tests close actual-entry parity.

**One design prerequisite remains genuinely unresolved by the existing approved requirements:** an optimized bounded inactive-file polling path cannot retain the current synchronous bar's next-collection detection of every stat-visible same-path rewrite without checking every relevant inactive file, or obtaining an equally authoritative complete change source. Watchers are explicitly only hints. Section 5 gives the counterexample, preserves the strict compatibility path, and identifies the exact release decision. This brief does not silently authorize slower freshness. If no such disposition is supplied, the eventual implementer must stop before replacing the strict scan path, even after other queue gates clear.

## 2. Verified source and evidence

The four requested collector files at the inspected pin are byte-for-byte identical to the required parity reference 6fcf08aef34e2cefa8c7c5ee766b001993e88db9. Both refs were fetched directly; matching Git blob identities are:

- src/collectors/session-finder.ts: 30ed4c4d805a492ff49b410311ee11f0ab206fce.
- src/collectors/subagent-tree.ts: a040d7e0f9220344715c92b5c0bc7d2d6e113160.
- src/collectors/hud-status.ts: 06c67217cf19b04267feea96cc511dd6982e6619.
- src/collectors/tree-scan-store.ts: 67aa8f4704786b64cd8cf8c300a21da6b4b9e042.

Concrete work to remove:

- session-finder.ts:306–350 stats every listed file in the synchronous finder.
- Its yielding path builds the complete listed array and listedPaths Set, sweeps the whole stat cache, drops entries above 4,096, walks every listed file again, and searches results for quiet-file updates (436–513). With 20,000 steady files, trimming to 4,096 before the next pass forces at least 15,904 cache misses when all files remain present. Merely increasing the limit still leaves full-population enumeration/allocation.
- subagent-tree.ts:1015–1169 rebuilds known/links/seen/children, scans and sorts all stale header candidates, walks every listed file, and sweeps linkCache on every build. The yielding wrapper only yields after approximately 4 ms; it does not reduce total service cost (988–1005).
- The actual reachable scan is already parent-before-child and only traverses the chosen root's reachable population (1185–1198). Preserve that useful distinction.
- HudStatus.buildNow invokes the synchronous legacy builder when no tree is supplied (hud-status.ts:140–146). Its supplied tree path avoids the duplicate build.
- SCAN_VERSION is 4. Saved scans retain offsets, fields and ledger with a 4 KiB boundary hash; save threshold is 256 KiB, flush cadence 60 seconds and retention seven days. The dirty map retains callbacks, so disposal must cover callbacks as well as catalog maps.

Retained B10D evidence, not rerun measurements:

- performance-summary.json's matched sync-bar no-change population has n=1,000, legacy p50 84.718 / p99 116.017 ms. Its mixed population has legacy p50 95.310 / p99 131.702 ms.
- The final route records standalone bar paint p99 about 108/93/126/154 ms, simultaneous mixed paint p99 about 168/90 ms, and a 1,184 ms operation maximum.
- Storage tails, native reader parking, retirement recapture, hard allocation accounting and follower propagation are independent blockers. An improved legacy catalog does not close them.
- The frozen B10D 20,000-file fixture uses 200 root/target headers and unrelated history, with valid legacy filenames. Its ordinary headers are small. This does not prove that 20,000 arbitrarily large retained metadata records fit a chosen memory cap.

The current complete recursive tree was also inspected (1,462 entries, not truncated). No published LEG1 brief exists at this pin.

## 3. Goal, interfaces and single owner

The catalog owner is an explicit object, not several uncoordinated module-global Maps. One owner serves the active source in one HUD process; bar and panel remain separate processes and therefore separate owners. Do not claim shared memory or cross-process synchronization.

Identity must include the canonical configured source/home and sessions root, source-instance generation, and current query/root epoch. Root changes within an unchanged source may reuse inventory, but no old-root result or work token can be adopted. Source replacement, source-root realpath/device/inode change, or A→B→A switching invalidates unfinished work and source-bound caches. Paths and bare session IDs alone are insufficient cross-source keys.

A minimal internal interface should provide:

- Construction with the explicit source identity, existing scan-store port, injected clock/I/O test seam and one set of limits.
- invalidate(path or directory, reason): coalesce a hint only; no I/O, parsing, timer or collection starts in the callback.
- collect(request, grant): progress one ordinary collection/repair opportunity using an explicit scope, known subagents, lookback, priority paths, nowMs and the caller's available work budget.
- current(scope): return only the last complete compatible result.
- dispose(): cancel outstanding work by generation, close only owned directory/read handles and release all inventory, queue, transient and dirty-save references.

The collection result distinguishes complete, continued, unavailable and capacity-exceeded, and carries scope/generation, the last successful observation boundary, counts/charges and any compatible retained tree. A continued or failed result is not a successful empty tree and does not advance successful-read freshness. Initial absence of a complete result remains initializing/unavailable. After a root/source switch, an old-root tree cannot be the fallback.

Keep existing synchronous public APIs and their behavior intact. Add an explicit catalog adapter/API rather than silently converting findRolloutsInDays or SessionFinder's root-selection calls to stale reads. Existing explicit listed=[] continues to mean an empty inventory, not permission to scan.

HudStatus remains an assembler. Its incremental caller supplies a complete compatible tree/result; HudStatus must not silently do a synchronous full scan when that caller's catalog is continued or unavailable. Do not change Git/project/title cadences, successful-read meanings, quota, activity, model jobs, timeline or session-selection precedence.

## 4. Bounded representation and work

The following are proposed LEG1 internal acceptance limits, not new supported-profile exclusions or increases in any contract limit:

- **Inventory slots: 32,768 total**, including live, negative, duplicate and repair/tombstone records. A steady 20,000-file population must be fully retained without rotation through a smaller LRU.
- **Directory slots: 4,096 total**, including tracked absent directories and repair cursors.
- **Catalog allocation allowance: 16 MiB total**, shared by inventory records, exact retained key/string storage, directory membership, duplicate indexes, parent/child adjacency, affected-root/dependency references, dirty sets, revalidation ordering, pending repair descriptors and their bookkeeping. Reserve before allocation; do not count only JSON payload lengths. Fixed-width storage and interned path prefixes are preferred. Any object-backed implementation needs a conservative allocation accounting scheme plus measured heap/RSS evidence.
- **Dirty queue: at most one marker per inventory/directory slot**, within the same 16 MiB. Overflow becomes one bounded full-repair-required state with a cursor. It never loses invalidation silently or allocates one callback per event.
- **Catalog-owned transient allocation: 2 MiB**, separately reserved and reported; no retained full session_meta strings or raw transcript history in the inventory. Existing tree-body scan buffers and snapshots are not falsely credited as covered by this cap.
- **Only one complete tree snapshot and one construction candidate may be owned by this catalog at a time.** Consumer-retained snapshots, complete tree fields, ledger/stage data, scan-store dirty callbacks and parser buffers must be counted in whole-process resource evidence. They cannot be hidden in a side cache or called catalog-free memory.

These proposed caps are intentionally not a claim that every existing legal tree payload fits. A byte-cap hit must report capacity-exceeded and preserve the last scope-compatible complete result; it must not silently truncate IDs, fields, duplicate candidates, parent relations or the supported 20,000-file test population. If an in-profile case cannot fit while preserving semantics, LEG1 remains unqualified and requires a bounded design disposition. Do not call that case unsupported or raise the cap without review. This applies especially to very long header identity strings, directory/path expansion and duplicate fanout.

Maintain compact indexes by path, exact header session ID, selected duplicate, parent ID and affected dependency. Do not retain full parsed header instruction bodies. Hashes may accelerate lookup, but hash equality is not exact identity: collisions require exact comparison, with any required source read counted. Derived display identity must keep the current precedence.

Duplicate-file resolution must match the old builder: the newer observed modifiedAt wins; equal modifiedAt retains the first file in the supplied enumeration order. Do not silently change ties to lexical path order. Keep stable enumeration ranks and recompute only an affected duplicate group. When a winner changes, invalidate its old/new parent dependency and all affected root views. A large duplicate group remains real work, not permission to inspect just its previous winner.

Repair is incremental, with one cursor and bounded batches. A directory rebuild may retire/reuse catalog slots while the old immutable display snapshot is retained; no query may call a partially repaired index complete. Avoid copying a second 20,000-entry catalog. Commit a directory generation only after a complete successful enumeration and validation of the relevant directory/source generation. A failed/permission-denied listing is unknown, not proof that its former members disappeared.

There must be no full inventory map/filter/sort, list flattening, all-cache sweep or full dependency rebuild on an ordinary stable incremental opportunity. Persist revalidation ordering and membership indexes. For a fixed 20,000-file fixture with a fixed reachable tree, ordinary work must depend on the reachable/priority population, changed entries and explicitly due probe batches, not on 20,000. Directory-level verification work and its list-entry count are always reported.

The old all-files listing APIs may still intentionally do O(N) work; do not use their costs as evidence for the incremental API. If a consumer still requires an all-files array each tick, change that consumer only in the later owned integration or retain a versioned immutable array without recreating it on no-change. That array and any copies count toward memory.

## 5. Invalidation and freshness: exact compatibility boundary

### Behaviors that remain unchanged

- Session selection preserves daemon binding → shell snapshot → CWD fallback, rootThreadOf behavior, live-before-archive lookup, shallow today/yesterday search, two-second fallback throttle and 30-second deep fallback cadence. The catalog does not introduce newest-mtime selection into the strict facade.
- Tree lookback remains at least three days, extended to the root's creation day or surviving known children. Priority paths outside the window remain eligible. Midnight/timezone/day rollover changes discovery scope even without a watcher hint.
- Every normal incremental opportunity checks the selected root, reachable/priority paths and previously growing paths as the yielding path does. Parent/root charge input is included even though the root is not a displayed node.
- Changed size, mtime, device/inode where available, truncation, replacement, negative-header completion and invalidated context demand revalidation. ctime may be additional invalidation evidence; it is not permission to weaken existing checks.
- Directory signatures remain hints, not membership certificates. A settled equal size/mtime is insufficient for lost-notification or same-signature rename/create/delete recovery. Include a forced directory-enumeration cursor independent of watcher silence, and compare generations around each repair.
- Header signatures require content re-peeks. Preserve the existing oldest-due ordering and at least the existing two re-peeks per ordinary build after 30 seconds; no repeated global sort. **Thirty seconds is an eligibility age, not a 30-second guarantee for every one of 20,000 headers.** At two probes per opportunity, a fixed due population can require 10,000 opportunities, plus byte-budget continuation. State the actual bound rather than saying “a few ticks.”
- Preserve verified byte offsets, header identity, inode, boundary hash and before/after source checks. Growth is not proof of append. Truncate-and-regrow, concurrent rename/rewrite and a second source change during verification reject the candidate. A partial final record does not advance the committed offset past its complete-record boundary.
- Watcher error, dropped/duplicate hints and an unknown filename cannot make data fresh by assertion. Coalesce them into bounded discovery/repair demand on the ordinary collection stream. New per-file watchers, polling services or result-triggered scans are outside scope.
- Revalidation work retains its original due time while continued. Busy or expired grants do not reset age and do not count as a completed probe. Report backlog and oldest age; eventual convergence must not need another append or hint.

### F1: decision required before replacing strict bar collection

Counterexample: warm a catalog with an unrelated file X. Rewrite X in place with the same size but a newer mtime so its parent becomes the displayed root; deliver no watcher event and leave directory membership unchanged. At the next synchronous build the old finder stats X, the old builder re-peeks it, and the child appears. A bounded inactive-file polling implementation that does not select X returns the old tree. The same issue occurs when an inactive duplicate becomes the winner by mtime, or an initially unreadable/negative header becomes valid.

Therefore these three promises cannot all be asserted from current sources:
1. no O(N) inactive-file validation on a stable ordinary opportunity;
2. no authoritative complete change journal;
3. exact next-collection parity with the synchronous path for arbitrary stat-visible file mutation.

**Selected safe boundary now:** retain strict API semantics, and keep incremental-path production adoption unreleased. Before release, a fresh recorded disposition must either (a) establish an authoritative supported change mechanism with no weaker guarantees and approved ownership, or (b) explicitly approve a stated bounded inactive-file freshness/discovery policy, including duplicate candidates, negative entries, directory lost-hint recovery and failure/continuation behavior. Option (b) is a policy change, not a cache optimization; this brief does not approve it.

Recommendation for that decision: retain immediate verification of current/priority/growing files and root-selection semantics, and specify a finite fair inactive-file/directory recovery schedule rather than trust watchers. The exact count/time/byte guarantee must be reconciled with the unchanged per-operation budget and supported profile before implementation. Do not choose an arbitrary “30-second full recovery” that cannot fit legal 1 MiB records or a 5-second idle cadence. Until the bound is recorded, there is no honest complete production-freshness acceptance claim.

The advertised yielding path's two quiet stats are not evidence of equal observed timing at 20,000 files: its present 4,096 cache churn causes many more stats. Removing churn can change observed freshness even when a two-probe algorithm matches the old comment. Tests must record this distinction.

## 6. Snapshot parity and scan-store compatibility

Keep the exact existing legacy semantics:

- filename parsing, root/known-agent fallback, parent resolution, missing-root lookback, duplicate resolution and cycle handling;
- canonical task path, nickname/role/kind precedence and unique picker labels;
- event-time status precedence, unknown status, startedAt/turnStartedAt/statusAt/lastEventAt;
- parent-before-child charge derivation, preface bounds, task/report channel privacy, model/effort, stages/actions/peers and link-evidence inputs;
- tree ordering/counts, timeline/activity inputs, main rollout data and nonempty Git/file-list inputs;
- immutable already-returned snapshots. Later body scans or child-list changes must not mutate a previously returned tree.

The current panel adds context and model-job material after building the tree (tree-page.ts:1009–1010). Do not let these consumer mutations enter the catalog's canonical cached graph. Keep the canonical result separate from the caller-owned legacy tree, using a bounded reachable-tree copy/overlay at the boundary when necessary. Its allocations and cost count; neither freezing a caller's existing mutable object unexpectedly nor changing model-job behavior is an acceptable shortcut. Copying at most the supported reachable population is different from copying the 20,000-entry inventory.

Compare against 6fcf08a at identical synthetic source bytes, knownSubagents, observation boundary, clocks and render context. Also compare against the eventual accepted integration base to expose approved intervening changes. Use actual baseline code obtained read-only, isolated caches and full field/frame comparisons, not an implementation-defined summary hash.

Separate:
- **data parity at equal observation boundaries**, required in LEG1;
- **discovery/freshness parity across opportunities**, blocked by F1 until its disposition;
- **actual production bar/panel delivery**, later entry-integration evidence.

No suppression based on worker existence, null/non-null universal view, or an empty universal tree. No universal-to-legacy substitution. The existing B10D parity fixture is reference-only; do not import unaccepted production dependencies.

Keep SCAN_VERSION=4 when only ownership/indexing changes and the parser/restore semantics are unchanged. If any persisted field meaning or applyRolloutLine/applyLedgerEntry reading changes, stop for the explicit version/compatibility amendment and corresponding tests. Never reinterpret old saves in place. Preserve path/id/inode/offset/4 KiB-print validation, 0600 atomic writes, read-only mode, 256 KiB save threshold, 60-second flush cadence and seven-day retention.

The narrowly allowed scan-store extension is explicit removal of pending save callbacks for disposed/reset source records, without deleting durable files or changing the saved schema. It must prevent a stale closure from serializing a later source or retaining abandoned tree state. Any different persistence format, catalog-on-disk index, new storage backend or raw incomplete-record persistence is outside this brief.

## 7. Complete proposed whitelist and cross-package boundaries

No implementation ownership is released now. On the eventual accepted base, propose only:

Production:
1. src/collectors/legacy-catalog.ts (new): source-scoped catalog, limits/reservations, indexes, invalidation/repair scheduling, internal result and telemetry types.
2. src/collectors/session-finder.ts: bounded catalog adapter and explicit compatibility path; shared parsing helpers only as needed. Preserve selection/daemon/archive behavior.
3. src/collectors/subagent-tree.ts: incremental topology/affected-tree assembly, source-owned cache lifecycle and adapters around existing scan/field logic.
4. src/collectors/hud-status.ts: consume supplied complete catalog result without hidden synchronous fallback; retain all other data.
5. src/collectors/tree-scan-store.ts: pending callback disposal only, subject to §6.

New tests and harnesses:
6. tests/unit/leg1-catalog.test.ts.
7. tests/unit/leg1-invalidation.test.ts.
8. tests/unit/leg1-parity.test.ts.
9. tests/unit/leg1-fixture.ts.
10. tests/int/leg1-catalog-performance.mjs.
11. tests/int/leg1-fixture.mjs.

Existing tests are read-only regressions unless a later precise amendment grants an edit. Do not update baselines to make a changed result pass. No package.json, dependency, tsconfig, renderer, schema, contract, shared type, source watcher, entrypoint or other utility edits are included.

Dispatcher-serialized records, not implementer source ownership:
- this brief, its rulings and questions;
- docs/cloud/handoff/leg1/ reports/reviews and linked raw evidence;
- design §6 cache boundary only after the relevant disposition;
- factual STATE and plan updates only at real milestones.

Conflict check:
- B10D historically owned collectors broadly; its route §2 explicitly proposes releasing the named legacy files to LEG1. Record that exact reservation before code starts. delegation.ts, core/link, worker envelope/client, observation-store and B12/B16 APIs stay outside LEG1.
- RCP1 owns native reader/checkpoint/disposal semantics. LEG1 cannot implement a second continuity or durable-recovery mechanism. Its scan-store callback disposal is only legacy display-cache lifecycle, not native accepted-reader parking.
- TPD1 owns tree-page action dispatch/reconcile and its explicit renderer extension. LEG1 owns no tree-page hunk. B10D-2 later integrates collection serially after checking the accepted TPD1 image.
- Inspector is renderer-only; LEG1 supplies no missing universal fields by bare session-ID joins.
- The queued data producer brief is not yet available at this pin. Its exact source ownership must be compared before release, especially if it uses subagent-tree.ts or session-finder.ts for picker identity or digest inputs. An unspecified file set is not disjoint.
- DOC2/design and shared status records remain serialized. No additional wave is released.

## 8. Required deterministic tests

All future tests use synthetic temporary HOME, HUD_HOME, CODEX_HOME/CODEX_SESSIONS_PATH and TMPDIR as appropriate. No real home/session data or local harness. Test the production catalog methods and compatibility adapters, with counters around actual I/O/allocation seams, not only a disconnected scheduler mock.

A. Stable inventory and work:
- Exactly 20,000 valid legacy filenames, 200-node profile, three fully settled initializations. Retain all records beyond 4,096. Over repeated no-change opportunities assert no supported-entry eviction/reopen churn, no full inventory iteration/sort/copy and no unrelated body scan.
- Report directory stats/enumerations/entries, file stats, first-line reads/bytes, tail/signature bytes, parse records, changed dependency visits, new node/array allocations, saves, queue length and reserved/live bytes for every opportunity.
- Compare 1,000 versus 20,000 inventory files with the same reachable tree and due batches. The incremental path's work counters must not scale with unrelated inventory count. Explicit due probes remain included.
- Run across revalidation age, directory refresh, 60-second save cadence and day rollover. A warm-up that stops before these costs occur cannot establish stable behavior.
- All-files compatibility calls remain separately labeled O(N); no substituted benchmark path.

B. Invalidation and identity:
- Append, shrink, truncate/regrow to larger size, same-size newer-mtime rewrite, inode/device replacement, zero/unknown inode, same-signature header rewrite and header-ID replacement.
- Root/home/source A→B→A, source symlink retarget, deletion/recreation, midnight, old-root/known-child lookback, priority path outside window, duplicate tie/winner replacement and changed parent/cycle.
- Empty/malformed/permission-denied header recovering; directory read failure never becomes affirmative deletion.
- Drop all watcher hints, overflow/coalesce hints, unknown path events and duplicate events. Prove the recorded recovery bound with a fixed input and no rescue append/hint. F1's next-collection counterexample must remain explicit until policy approval, not be removed from the matrix.

C. Consistency, cancellation and capacity:
- Change a file during a yielded scan, then during verification; do not mix old prefix/new suffix or advance partial offsets.
- Lose the scope/generation during directory repair/body scan; reject the result and free owned allocations/handles without publishing old-root data.
- Interrupt every continuation phase. A prior snapshot remains immutable and complete; candidate work cannot change it.
- Exact count/byte limit, one-byte-over, long Unicode paths/metadata, duplicate-heavy population and burst rename/creation. Assert reservation before allocation, bounded overflow marker and no silent truncated “complete” state.
- Repeated source/root changes release queue/index/dirty-save references. Retention is measured, not inferred from calling clear().

D. Semantic parity:
- Full tree/HudData comparisons for all fields in §6, nested descendants, parent-before-child charges, reports/private channels, model/effort changes, stages, known agents without rollouts, inactive/unknown states, cycles and duplicate ordering.
- Nonempty Git/file-list data and timeline/activity consumers.
- Existing v4 save resume, replacement/hash/truncation rejection, corrupt/old save, readOnly zero mutation and cleanup callbacks.
- Demonstrate meaningful failing-before controls against the pinned baseline: >4,096 churn and per-tick full inventory work must fail. Existing correctness tests must pass unmodified; new stricter invalidation cases may intentionally identify baseline limitations and must be labeled as such.

E. Deferred actual-entry matrix:
- Worker absent, initializing/null and delivered non-null native-root states; no-ledger/CLI zero-worker behavior; result/ACK/resize/key paints do zero collection; busy/continued admission gets no second root grant.
- Main/panel scope ABA, failed repair, old result rejection, immutable cached output and correct health.
These belong to the later integration whitelist and do not count as completed LEG1 production coverage.

## 9. Checks, timeouts and evidence after release

The following is a command inventory, not permission to run it. Before execution, the dispatcher names the exact frozen tree/build, executor, runtime/profile, owned process supervisor, command group, time budget and cleanup/return point. Respect current lifecycle holds and the withdrawal of assistant-run local tests. Known-denied operations stay blocked, not retried through a new wrapper.

Use Node 22 >=22.13 and Node 24 in separately admitted runs. Every command retains stdout/stderr, actual exit/direct/outer status, UTC and monotonic interval and authoritative owned-child cleanup. A timeout/incomplete output is not a pass.

1. npm run build && npm run build:test && npm run build:hud-mcp — outer cap 300 s.
2. node --test --test-concurrency=1 dist-test/tests/unit/leg1-catalog.test.js dist-test/tests/unit/leg1-invalidation.test.js dist-test/tests/unit/leg1-parity.test.js — 300 s.
3. node --test --test-concurrency=1 dist-test/tests/unit/session-finder-cache.test.js dist-test/tests/unit/tree-scan-store.test.js dist-test/tests/unit/tree-order.test.js dist-test/tests/unit/hud-health.test.js dist-test/tests/unit/adaptive-scan.test.js — 300 s.
4. node --test tests/unit/test-subagent-tree.mjs tests/unit/test-session-finder-pane-binding.mjs — 300 s; preserve any environment-limited stage as blocked.
5. env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=<fresh temporary directory> npm test — 900 s.
6. npm run test:core — 600 s.
7. npm run test:visual — 300 s.
8. npm run test:hud-mcp — 600 s.
9. npm run format:check — 300 s.
10. npm run check:fixtures — 120 s.
11. git diff --check — 30 s.
12. node tests/int/leg1-catalog-performance.mjs — separately admitted 900 s cap per runtime series; the new harness's fixed configuration runs three fresh-process repeats, each with at least 1,000 retained measured opportunities per declared collector population, plus separately reported cold initialization and fixed-input repair convergence. If its predeclared required workload cannot fit, report before launch and obtain a revised window; never shorten a sample population after starting.

Expected assertions are §8, plus complete sample accounting and actual return/cleanup. The benchmark must emit raw rows, not just aggregate percentiles. Use a deterministic correctness clock only for semantic tests; timing/resource series use a real monotonic clock. State host, CPU/OS/filesystem/runtime, fixture content/size counts, warm-up, nearest-rank method, all repetitions and ranges.

Evidence destination: tmp/tasks/LEG1/<exact-candidate>/<runtime>/<run>/ with manifest, commands, stdout/stderr, I/O-work rows, raw timing rows, scope/repair outcomes and memory/reservation counters. Dispatcher archives a synthetic-only report and source-identifiable artifacts under docs/cloud/handoff/leg1/ using the existing approved recording workflow. Preserve predecessor failures and unrun stages.

The package's no-change collector/wiring path must be measured against the unchanged p99 <=2 ms design share, with maximum reported; no timing claim is made here. New changed/cold/repair measurements are evidence, not a replacement gate. Final B10D-2 must still satisfy paint p99 <50 ms/max <200 ms, operation p99 <100 ms/max <1,000 ms, local commit-to-paint p99 <50 ms/max <200 ms and follower p99 <C+100 ms/max <C+1,000 ms at C=1 s and 5 s, with original rolling-window rules and full-operation intervals retained.

Worker 64/8/4 MiB V8 limits, <=16 native readers, <=24 MiB owned external buffers, <=2 MiB result, whole-process RSS delta <=32 MiB steady/<=64 MiB peak, shared operation accounting, 15-second lease TTL, WAL+FULL and atomic commit/ACK remain unchanged. Main-process catalog bytes and both main/worker allocations count. Do not sum per-thread process RSS.

LEG1's minimum three collector-level runs do not substitute for B10D-2 actual separate/simultaneous entry populations, its 30-minute soak/no-rescue drain, or B14's >=10,000 samples, >=3 fresh starts and supported-platform obligations. Formal WSL, Herdr and real-harness evidence stays local-only and is not simulated.

## 10. Release checklist, hierarchy and stop conditions

Before any implementation:
1. Finish the earlier ordered waves and recorded B10D route prerequisites. Do not treat publication, an old STATE row or a source-composition verdict as accepted integration.
2. Pin the actual accepted universal-hud base and revalidate all interfaces and four source blob identities above. Do not build from unaccepted NEXT/worker interfaces.
3. Record F1's exact freshness/discovery disposition and applicable authority. Reconcile byte limits, due-work ordering and duplicate behavior with it; revise this conditional text if needed.
4. Complete and compare the queued data/RCP1 briefs; record exclusive LEG1 ownership including the narrow tree-scan-store addition.
5. Record the minimal design §6 amendment and any policy changes through the dispatcher. No numerical gate or profile reduction is proposed here.
6. Assign a branch/worktree only at release, with collision checks, then an explicit independent execution/lifecycle window. No reservation or compute authority is created by this report.

Hierarchy after release: dispatcher schedules and records; one Astra-high implementer owns the exact whitelist; a fresh Astra-max Oracle handles any material design fork and the final diff/report/evidence review. Do not add workers from this consultation. The normal bounded fix/re-check policy and eventual --no-ff merge plus green full merged-tree check set remain mandatory.

Stop the dependent scope on absent accepted base, unresolved F1, byte/count failure within the supported fixture, an unsatisfied producer or missing ownership, required out-of-whitelist edit, uncertain/denied workload or cleanup, a proposed slower policy without its disposition, or a gate/profile/contract change. Return exact completed work and the named blocker. Do not infer permission from time elapsed, successful file publication or a quiet process listing.

**Final disposition:** the incremental catalog architecture, ownership and proof obligations above are suitable conditional preparation. It is not a released implementation brief until F1 and the queue/base/ownership/execution prerequisites are settled. No production correctness, speedup, memory fit, package acceptance or merge readiness has been established.

## Source links

All current-source links below are pinned to the inspected integration image:

- [AGENTS](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/AGENTS.md), [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/dots.md), [STATE/queue](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/handoff/STATE.md).
- [Queue preparation ruling](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/queue-progress-20261103.md), [B10D route §2](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/b10d-route.md#L28-L65).
- [Finder](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/src/collectors/session-finder.ts), [tree builder](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/src/collectors/subagent-tree.ts), [HudStatus](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/src/collectors/hud-status.ts), [scan store](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/src/collectors/tree-scan-store.ts).
- [Architecture §4/§8](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/ARCHITECTURE.md), [contract 06](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/contracts/06-observation.md#L258-L278), [design §6](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/design/hud-information-design.md#L849-L878), [concept §15](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/universal-hud-concept.md#L590-L650).
- [B10D §11 legacy ruling](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/handoff/b10d/oracle-1.md#L165-L179), [final review](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/handoff/b10d/oracle-review-2.md), [retained performance summary](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/handoff/b10d/performance-summary.json), [report](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/handoff/b10d/report.md).
- [Frozen B10D fixture](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/int/b10d-fixture.mjs), [frozen parity test](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/int/b10d-legacy-parity.test.mjs).
- [TPD1 boundary/ownership](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/tpd1-effect-boundaries-20261104.md), [Inspector consumer boundary](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/inspector-consumer-source-field-brief-20261104.md), [resource-window rules](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/wave1-resource-windows-20261103.md).
- [Existing same-size/stealth rewrite tests](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/tests/unit/test-subagent-tree.mjs#L380-L484), [scan-store regressions](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/tests/unit/tree-scan-store.test.ts), [README check set](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/README.md#L69-L79).

Method: read-only GitHub source/doc/tree retrieval, read-only comparison of returned source bodies/blob identities, and inspection of retained summaries. The requested standalone brief is the only output written.

