# LEG1: future measurement and qualification plan

Date: 2026-11-04 UTC. Role: fresh read-only Oracle.

Repository image inspected: `CartmanFatass/codex-hud`, `universal-hud@26096e825baeccbce1403c8cbffa964e243f83ff`.

**Preparation only. No implementation, measurement, execution window, ownership, production adoption, package acceptance or merge readiness is released by this report.** All proposed future runs below are unexecuted. The current strict production APIs and their actual callers remain unchanged.

## 1. Decision and reconciliation

Use the owner-accepted bounded inactive-discovery direction to prepare a two-stage evidence program: first an explicitly unadopted catalog engine, if separately released; then a separately released actual-entry test candidate. Production adoption remains held until its concrete service envelope and resulting user-visible delay have been demonstrated, recorded and accepted. Testing a candidate is not enabling it for production.

The [owner-direction ruling §5][OWNER] authorizes this read-only preparation. Its decision supersedes only the premise that the owner has not accepted the general direction. It does not select a quota, a wall-clock SLO, a new supported-profile restriction, a production policy or an implementation start. Do not ask the owner to accept the general direction again. The later question, if a candidate succeeds, is about its **actual specified limits and delay**, not a repeat of the already answered question.

Reuse the [conditional brief][BRIEF] for architecture, the eleven proposed source/test paths, semantic parity, scan-store compatibility and the future command inventory. Reuse the [freshness disposition §§3–8][FRESH] for the F1 impossibility result, strict-baseline limitations, watcher treatment and truthful coverage. This plan supplies the missing measurement contract and staged decision criteria; it does not replace either technical analysis.

In particular:

- Strict next-collection discovery for the baseline-recognized, already-listed inactive mutation class, including same-size/newer-mtime rewrites, and bounded partial polling remain different behaviors. Owner acceptance of the direction does not make them equal; the baseline's append/signature limitations remain as previously recorded.
- Immediate current/root/priority verification, strict source selection and exact legacy field meanings remain obligations. “Immediate” means the applicable collection behavior, not a zero-time promise.
- Equal-observation data parity, discovery delay, fixed-input convergence, resource fit and production qualification require separate verdicts.
- The 200-node/20,000-header supported profile, all existing gates and the serial package order remain intact.
- No 30-second full-inventory claim is selected. The current 30 seconds is an eligibility age, with a strict `>` comparison.

## 2. Verified source image and reuse boundary

The complete Git tree returned for the inspected pin has 1,522 entries and `truncated=false`. The following files were fetched at that exact commit, rather than inferred from a moving branch name:

| File | Git blob |
|---|---|
| `src/collectors/session-finder.ts` | `30ed4c4d805a492ff49b410311ee11f0ab206fce` |
| `src/collectors/subagent-tree.ts` | `a040d7e0f9220344715c92b5c0bc7d2d6e113160` |
| `src/collectors/hud-status.ts` | `06c67217cf19b04267feea96cc511dd6982e6619` |
| `src/collectors/tree-scan-store.ts` | `67aa8f4704786b64cd8cf8c300a21da6b4b9e042` |
| `src/index.ts` | `00b816b401f20a865867ed15e1668185024145d3` |
| `src/tree-page.ts` | `843a9e224444745d00362931be5a392d3fe26fc5` |

The four collector blobs are unchanged from the prior brief and owner-direction ruling. Therefore their existing source analysis is reusable. Relevant behaviors were rechecked without executing them:

1. `session-finder.ts:306–350` stats every listed file on the synchronous path. Its yielding path at 436–513 rebuilds full-population structures and retains the 4,096-cache churn described previously.
2. `subagent-tree.ts:1028–1045` selects **at most** two oldest-due header candidates per build after 30 seconds. This is not evidence of two successful, byte-accounted completions under every shared grant. The later brief must reconcile its retained revalidation obligation with measured service; it cannot declare `q_h=2` merely from this constant.
3. `subagent-tree.ts:1053–1087` distinguishes recognized stat changes from cached/append behavior; 1149–1152 keeps the first enumeration candidate on equal modified time. No stronger baseline guarantee is inferred.
4. `subagent-tree.ts:102–119` limits decoded JavaScript string length, reads 64 KiB chunks and can read past a newline. The constant named `MAX_FIRST_LINE_BYTES` is not an actual-I/O or allocation proof.
5. `hud-status.ts:140–146` still invokes the synchronous builder when no supplied tree exists. `tree-page.ts:1001–1009` still uses its current yielding/null-versus-non-null path and applies consumer context afterward. These are integration boundaries, not collector-only acceptance evidence. This plan neither fixes nor imports the frozen B10D entry changes.
6. The scan store remains version 4, with the existing 4 KiB boundary print, 256 KiB save threshold, 60-second flush cadence, seven-day retention and pending callback ownership.

Retained B10D timing/failure summaries remain historical evidence only. None was rerun. The inspected commit is a **documentary/source pin for this report**, not a claim that all LEG1 release prerequisites at that image have been accepted.

## 3. Required finite workload envelope

The later released measurement brief must contain one machine-readable, versioned envelope manifest per declared population. Every field below must be finite and concrete before its qualification run. An unset field is `UNQUALIFIED`, not zero, unlimited, “typical” or an implicit default. Calibration may compare a predeclared finite set of candidate envelopes, but those are experimental inputs, not accepted production limits.

### 3.1 Input and state dimensions

| Quantity | Required definition and evidence |
|---|---|
| `N` | Maximum simultaneously retained file records in the case: live, inactive, duplicate winners/losers, negative, absent/tombstone and in-progress repair records. State both physical files and allocated slots. A steady 20,000-file supported case must not rotate through a smaller cache. |
| `D` | Existing and absent tracked directories, independent discovery roots and live repair cursors; state maximum depth and lookback/day layout. |
| `E` | All directory entries actually examined in a complete membership sweep, including non-rollout names and entries that fail validation. Report largest directory separately. `D` alone does not bound one `readdir`. |
| `B_dir`, `L_path` | Actual directory/name/path bytes and maximum accepted path/key sizes, including Unicode and prefix expansion. Count retained and transient copies. An entry-count allowance does not bound an unbounded directory-result allocation. |
| `P`, `G` | Root, reachable, explicit priority and previously growing paths that require prompt service; include the undisplayed root's charge input. Identify overlaps without double-counting I/O. |
| `M_s`, `M_h`, `M_e` | Finite signature changes, headers requiring revalidation and membership changes queued at the settling boundary; include changed duplicate groups and negative-to-valid entries. |
| `H_i`, `H_max`, `B_h,total` | Actual work for each accepted legacy header: bytes read, verification/reread bytes, chunk overread, decoded code units, parse work, retained metadata and transient peak. State total content work for the burst, not just a per-header bound. |
| `B_body`, `R_body` | Reachable/priority body and restore work that shares the original operation allowance; exact finite bytes/records and partial-tail state. A header-only bound is not a whole-collection bound. |
| `U`, `F_dup`, `A_dep` | Distinct affected identities, worst duplicate group and dependency/adjacency work, including winner replacement, both old/new parents, cycles and reachable-tree copying. |
| `Q`, `B_live`, `B_transient` | Queue/slot limits, conservative reserved bytes and measured live/retained/transient totals, including retired candidates, strings, parsed objects, snapshots and dirty-save closures. |
| `W_compete` | Finite competing priority/native-recovery/publication work and its admitted allocation. For a continuing-change claim, also specify burst and arrival-rate bounds for each class; fixed-input convergence alone needs no claim for arbitrary ongoing writes. |

Retain the prior proposed internal limits as **unproven candidate limits**, not as measurements: 32,768 inventory slots, 4,096 directory slots, 16 MiB catalog allowance, 2 MiB catalog-owned transient allowance, one complete catalog-owned snapshot and one candidate. Neither these numbers nor a bounded `N/D/E` declaration may silently remove an existing supported case. If a supported case cannot fit, record a qualification failure and return the design/profile issue for the applicable decision. Do not silently trim identity, omit losers/negative entries, redefine support or raise a cap.

The ordinary 20,000-header fixture contains small headers; it does not establish worst-accepted-header capacity. Future input manifests must include small, near-boundary, multibyte and parsed-object-expansion cases according to the **actual legacy reader behavior**. First derive that reader's finite accepted-input/read/parse bound on the released source, then test it. Do not import the native reader's 1 MiB record rule into legacy parsing, truncate legacy inputs, or count only JSON payload length to manufacture a fit.

### 3.2 Preconditions and failure-domain declaration

A fixed-input convergence claim starts at a recorded `t_settled`: the declared source bytes and membership stop changing, the same source/root generation remains current, the finite input is readable, and the declared service envelope is available. Header eligibility may still add delay. This is a statement about convergence to that finite input, not an atomic filesystem snapshot or detection of a transient mutation that vanishes before observation.

List the supported runtime, OS/filesystem/mount assumptions and storage/CPU contention profile. Keep all failures in the trace. Permission denial, source replacement, suspension, I/O stall or lost grants do not become successful validation. Preconditions must be observable and fixed before the run; do not label slow operations “unhealthy” afterward merely to delete them from the population.

For a fixed-input healthy-service proof, a breach marks the bound unestablished/breached for that interval and preserves the original age. For failure-recovery tests, identify the failure interval and a new **explicit recovery/settling boundary**, while retaining end-to-end age from the original mutation. A finite recovery bound after readability returns does not erase an earlier outage.

## 4. Required service contract and derivation

### 4.1 Ordinary opportunities and allocation

Use an explicit monotonic ordinary-opportunity sequence tied to the existing collection stream. Include busy, coalesced, refused, expired, continued, failed and missed-service opportunities; do not define “ordinary” as only opportunities that successfully supplied repair. Link multiple coalesced demands to the actual logical operation without creating another operation or budget. Paint-only result/ACK/resize/key work is recorded separately and grants no collection service.

The service record must give, for each work class, **both** its maximum charged work and a successful progress floor:

- `q_s`: successful file-signature validations per designated service-bearing ordinary opportunity.
- `q_e`: successful directory-entry work quanta, plus explicit directory open/stat/close/generation/commit overhead. If variable path bytes require an independent byte floor, record that too.
- `q_h` and/or `b_h`: complete validated headers and/or guaranteed useful actual header-byte progress. Count signature reads, rereads, decoding, parsing and final verification; attempted reads and repeatedly discarded work are not useful completion.
- `K_gap,s`, `K_gap,e`, `K_gap,h`: finite maximum gaps, in the full ordinary-opportunity sequence, between service-bearing opportunities for each nonempty due class. Report `K_gap` as their conservative maximum. A common gap is valid only if every named class has the promised service within it.
- `K_assemble`: finite ordinary-opportunity bound from verified changed inputs to a complete compatible candidate tree, including duplicate/dependency propagation and snapshot copying.
- `K_adopt`: later actual-entry bound from a complete compatible candidate to adoption/frame enqueue. For the complete visible-tree claim, `K_tree = K_assemble + K_adopt`. Engine-only evidence can establish at most `K_assemble`; it cannot invent `K_adopt`.
- Eligibility delay and fair order for every class. Preserve original due/enqueue time and stable repair progress through repeated hot hints, expiration and continuation.

If a service floor applies on every ordinary opportunity, its gap is one. Otherwise name the opportunities that receive the reserved share and prove the finite gap; the denominator still contains all ordinary opportunities. This makes the older `q_*`/`K_gap` notation explicit rather than treating a configured batch maximum as a minimum.

Service must be allocated inside the existing once-per-logical-operation 8 MiB and cooperative deadline, with the existing single native-reader grant and selected publication limit. It cannot be an extra callback grant, extra root budget, worker service, timer or “whatever is left” allocation with no non-starvation proof. Show how prompt legacy work, directory/signature/header repair, native recovery/fairness and publication coexist. A LEG1 catalog calculation cannot alter B10D's separately approved at-most-2N native traversal rule or RCP1's service needs.

**Unresolved allocation decision:** no inspected source/ruling supplies numeric LEG1 success floors or proves their coexistence with the shared scheduler. The future released design must settle this with the relevant B10D/RCP1 owners. If the scheduler cannot honor all existing obligations, stop for that exact cross-package/design decision; a measurement result is not permission to steal another class's service.

### 4.2 Falsifiable bounds

For fixed readable input and a retained fair signature cursor:

`K_signature <= K_gap,s * ceil(N_due / q_s)`

This includes a mutation placed immediately after its path's previous visit, not only a conveniently next-in-queue path. Add any recorded eligibility delay. A successful `stat` alone is detection, not a validated new header or visible tree.

For independent membership discovery, derive `K_directory` from the complete finite `D/E/B_dir` workload and the actual service policy. One valid form is `K_gap,e * ceil(W_directory / q_e)` **only** when the manifest defines bounded work quanta covering every entry, fixed directory overhead, retained continuation, path-byte handling and successful generation commit. Merely putting `E` in this formula while one directory read allocates or processes all its entries is not a proof.

For header completion, derive a bound from the real packing/continuation/parse policy. If complete headers have a guaranteed floor `q_h` under their declared maximum sizes, a count bound can be used. If progress is byte-based, a conservative serial construction is:

`K_header <= K_gap,h * (sum_i ceil(H_i / b_h) + W_header_nonbyte)`

Here `H_i` includes the actual charged byte work and bounded rereads, while `W_header_nonbyte` is a proved finite number of additional service opportunities for verification/parse/finalization not already covered. The released policy must establish both useful progress and finite overhead. Do not automatically use `ceil(sum(H_i)/b_h)` when packing can waste the remainder, or take the minimum of count and byte bounds without proving both guarantees simultaneously. A non-preemptible parse remains timed and memory-accounted; splitting reads does not make parsing free.

For a complete fixed-input recovery, a conservative sequential bound is:

`K_catalog <= K_directory + K_signature + K_header + K_assemble`

`K_visible <= K_catalog + K_adopt`

A case that provably needs only signature detection or only membership discovery can use that named path. Mixed bursts use the sum unless actual scheduling proves a tighter bound. Full header revalidation of same-signature changes is a separate class with its eligibility delay; signature sweeps do not detect it. Newly discovered files that were not in the initial `N_due` must be included in the fixed envelope before using the formula.

Successful measured minima do not, by themselves, establish a guaranteed `q_*` or finite `K_gap`. Require a source/scheduler argument, adversarial deterministic validation of the actual API, and trace checking of every qualifying opportunity. The trace's observed minimum and maximum are evidence fields distinct from the proposed guaranteed values.

### 4.3 Time claims

Record opportunities and monotonic elapsed time separately. Nominal active `C=1 s` and idle `C=5 s` do not bound opportunity spacing, operation completion, stalls or suspension.

Only after a supported configuration establishes an explicit maximum opportunity spacing `J_max`, completion allowance `L_max` and eligibility-delay bound `A_max` may a conservative time expression such as `A_max + K_visible * J_max + L_max` be evaluated, with the exact start/end convention specified. It remains conditional on that qualified service configuration, not a universal hard-real-time promise. Without those premises, report the proved opportunity count plus measured time distribution/range, and leave a wall-clock guarantee unqualified.

Do not confuse inactive-source mutation-to-visible delay with B10D's commit-to-paint gate. Both are needed; neither replaces the other.

## 5. Evidence fields and measurement endpoints

Future evidence must make each assertion reconstructible from raw rows and the source manifest. Use synthetic IDs only.

### Manifest

- Exact accepted base, candidate commit/tree, build digest, instrumented source digest, frozen baseline `6fcf08aef34e2cefa8c7c5ee766b001993e88db9` and eventual accepted-base comparator; exact runner/harness revision.
- Runtime family/version, actual relevant SQLite version/settings, host/CPU/OS/kernel/filesystem, contention profile, process topology, temporary HOME/HUD_HOME/CODEX_HOME/session root/TMPDIR, fixture seed/hash and all dimensions from §3.
- Declared population, mode, cadence, service-vector/hash, warm-up, sample count, complete repair/drain bound, timeout, repetition order, command group, execution owner and cleanup/return point. Separate cold initialization, steady no-change, changed, repair and disposal endpoints before the run.
- Which guarantees are proposed, which are observed, which were proved, which remain unqualified, and the authority for any later production-policy acceptance.

### Opportunity and work rows

- Global opportunity index; logical operation/request identity; original enqueue/due time; monotonic start/end; nominal cadence; actual inter-opportunity spacing; busy/coalesced/refused/continued/failed/missed status and reason; per-class requested/granted/successful work; native regular/inserted grant identity where applicable.
- Full canonical source identity and source generation; query/root epoch; repair sweep/cursor generation; compatible old snapshot and candidate identities. A source A→B→A must not reuse an old token.
- Directory opens/stats/reads/closes, entries and bytes returned/examined, generation validation/commit; file-signature attempts/completions; first-line/body/tail/signature/restore bytes; decoded units; parse records; useful versus rejected/reread work.
- Duplicate-group and dependency visits; reachable copy/assembly counts; full-population iteration/sort/copy counters; queue/backlog sizes; oldest original due age; per-class last successful verification/frontier; missed bound flags.
- Per-allocation reservations, charged/live/retired/reusable bytes, object/string/buffer ownership, dirty-save closures, snapshot retention, heap/external/arrayBuffers and whole-process RSS samples. Count main and worker work without summing per-thread process RSS.
- Scan-store save/flush/dispose work and actual operation timing; continuation phase, retained cursor and exact terminal result. A failed validation cannot advance the successful frontier or delete former membership by assertion.

### Mutation and delivery rows

Record `t_mutation_visible`/`t_settled` from the controlled synthetic writer boundary, last prior path verification, eligibility boundary, first signature detection, header verification, membership commit where needed, complete catalog snapshot, entry adoption and final frame enqueue. Record their opportunity indexes as well as monotonic times. Distinguish “detected,” “validated,” “complete,” and “delivered.”

For each finite case, retain expected final full legacy data/frame, actual final result, all mismatches, exact settled-record counts, remaining backlog, oldest age and bound verdict. Failure, timeout, unknown cleanup or an unfinished sweep is not a successful latency/convergence sample and is not omitted. Mark the endpoint as **frame enqueue**, not a measured physical terminal display.

### Public truthfulness

Qualify the mapping from internal evidence to existing public health/coverage channels separately. Required facts are the last complete compatible snapshot, per-class verification age, backlog/oldest age, repair/overflow/failure state and missed promise. A current root/body read cannot refresh the whole inventory's age. An empty callback queue cannot certify it. Completeness is relative to declared verified boundaries, not a multi-operation atomic snapshot.

Keep the previous immutable compatible output during repair. Initial absence is initializing/unavailable; incompatible source/root output is not fallback. A persistent failure remains unknown/stale as appropriate. A warning forever is not progress. If existing channels cannot communicate these facts accurately, a named interface/rendering amendment is a prerequisite to adoption; LEG1 does not invent B16 classifications, native `sourceGeneration`, heartbeat activity or observation commits.

## 6. Future qualification matrix

The following matrix extends the prior brief's mandatory tests with the explicit endpoint/bound being tested. It is not a claim that these cases ran.

| ID | Finite case | Required evidence/outcome |
|---|---|---|
| M1 | Same fixed reachable tree and due batches with 1,000 versus 20,000 valid legacy files; three fresh settled initializations | Steady work does not perform full inventory map/filter/sort/copy or evict/reopen the supported set. Report scheduled periodic work and its maximum, not only average costs. Compatibility all-files APIs remain separately labeled O(N). |
| M2 | F1 same-size/newer-mtime inactive parent rewrite, duplicate loser becomes winner, stat-visible negative-to-valid; every fair-queue position including just after visit; hints disabled | Strict baseline succeeds at its applicable next collection. Candidate discovery/validation/delivery delay is explicitly measured, with no false cross-opportunity parity claim and no rescue event. Bound uses the worst position. |
| M3 | New/delete/rename membership with unchanged directory signature, nested and single-large directories, irrelevant names, absent directories, rollover/lookback extension | Independent `D/E/B_dir` sweep converges with every hint dropped. Partial/failed enumeration never commits an empty membership. Largest-directory operation/allocations are bounded and charged. |
| M4 | Same-signature content rewrite; exact 30-second boundary and just beyond; negative entry without a recognized stat change | Eligibility and header service, not signature service, explain completion. Preserve original due age. Do not overstate strict-baseline immediacy for this class. |
| M5 | All declared `M_h` headers change together; maximum accepted ASCII/multibyte/newline-boundary legacy headers, parsed-object/key expansion and byte continuation | Actual I/O, overread, decode, parse, verification and memory fit pass; every record completes under the derived finite count/byte bound, or the case fails. No truncation or unsupported reclassification. |
| M6 | Continuous bounded hot/priority work and repeated/coalesced/unknown hints while oldest inactive/negative/duplicate/directory work is due | Every class receives its declared floor within its declared gap under the admitted competing-work envelope. Preserve native-reader/publication fairness and original demand ages. An empty-budget mock alone is insufficient. |
| M7 | Append, shrink, truncate/regrow, same-size changed stat, inode/device replacement, unknown inode, mutation during read and again during verification | Reject mixed/stale candidates, maintain complete-record offsets and source checks; record discarded work and its accounting. Stronger-than-baseline cases are labeled separately. |
| M8 | Source/root A→B→A, symlink retarget, deletion/recreation, scope change at every continuation phase | No old-source adoption/fallback; returned snapshots stay immutable; all owned handles/queues/dirty callbacks are released or remain charged. |
| M9 | Unreadable→readable, directory failure→recovery, expired grants, storage stalls, source keeps changing, declared capacity exceeded | Truthful no-success/unknown/overload states, retained ages and compatible old output; post-recovery convergence checked from a declared boundary. No guarantee for unbounded writes; no silent exclusion of failed rows. |
| M10 | Exact proposed slot/byte limits and boundary exceedance, duplicate-heavy fanout, long Unicode paths, queue overflow, repeated disposal and consumer-retained snapshots | Reservation precedes allocation; bounded overflow cursor; in-profile cap failure blocks qualification. No forced-GC assumption, hidden side cache or “clear() therefore freed” inference. |
| M11 | Equal bytes, clocks, knownSubagents, enumeration order and declared observation boundaries against frozen reference and accepted base | Full field/tree/HudData/frame parity, including charges, private/report boundaries, model/effort, identity labels, duplicate ties, cycles, status/time/stages, nonempty Git/file-list and timeline/activity. No summary-hash-only oracle. |
| M12 | v4 saved scans, replacement/hash/truncation rejection, corrupt/old saves, read-only mode, due 60-second flush and disposal callbacks | Existing restore/version/durability meaning retained. Changed parsing/restore meaning requires its separate version amendment. Periodic/save work remains in the operation that caused it. |
| M13 | Later real bar/panel: worker absent, initializing/null and non-null delivered view; no-ledger/CLI; busy/coalesced results, result/ACK/key/resize paints; root/source changes | Actual caller uses the accepted mode only after adoption release. Zero extra collection/budget from paints, no legacy suppression/universal substitution, full current panel context and no hidden synchronous fallback on continued/unavailable catalog output. |
| M14 | Later separate and simultaneous bar/panel populations, native 200-target recovery/fairness/retirement contention, both cadences, 30-minute soak then declared no-rescue drain | All timing/resource/publication/follower gates and exact final settlement hold. Engine success or 200 allocations is not 200/200 durable settlement; LEG1 does not close RCP1/storage/retirement blockers. |

Mandatory meaningful controls from the prior brief remain: baseline >4,096 cache churn/full-population work must be observable; suppressing repair service, excluding duplicate losers/negatives, restarting due age or adopting a stale generation must reach a relevant semantic assertion. Import/build errors or unavailable facilities do not count as successful negative controls. Control images must be isolated and separately identified, never patched into an in-flight qualification image.

## 7. Method and sampling discipline after separate release

1. **Preflight on paper.** Reconcile the accepted base, ownership, parser bounds, expected work and maximum run length. Freeze fixtures, service candidates and instrumentation. No benchmark begins with unknown lifecycle custody, unsupported facilities or a run whose complete sweep cannot fit the assigned window.
2. **Deterministic correctness.** Use injected clocks and actual catalog/compatibility APIs with real synthetic temporary sources. Explore fair-order positions and continuation phases, verify all counters against actual I/O/allocation seams, and compare isolated baseline/candidate caches. Accelerated clocks establish semantics only.
3. **Bounded calibration, if specifically released.** A predeclared finite list of candidate service vectors may measure feasibility. Preserve all vectors/results, including failures. Select a candidate with a documented argument; tuning runs are not qualification samples. If none fits, return a design finding rather than extend the search indefinitely or relax the gate.
4. **Frozen engine validation.** Use real monotonic timing on Node 22 >=22.13 and Node 24 in separately admitted runs, with the actual required runtime/profile settings from the accepted base. Keep the prior brief's three fresh-process repeats and at least 1,000 retained measured opportunities per declared collector population per repeat. Report cold initialization and full fixed-input repair convergence separately. No “best run.”
5. **Complete horizon.** The run must cover the full prederived worst-case repair cycle, not stop at 1,000 samples if the sweep needs more. Include due header verification, independent directory sweeps, normal save cadence and day/lookback changes. Real-time performance evidence crosses real relevant periodic intervals; deterministic clock shifts do not substitute for elapsed timing. If the prescribed population cannot fit its approved outer cap, obtain a correctly sized bounded window before launch, without silently reducing the population.
6. **Measured endpoints.** Report n, raw rows, nearest-rank p50/p95/p99/max, each repetition and range, all relevant rolling windows and uncompleted/refused/failed attempts. Keep whole-operation intervals and stage timings on the same monotonic trace. Do not add stage quantiles, remove I/O/scheduling wait or relabel slow ordinary work as cold.
7. **Instrumentation integrity.** Freeze a complete counter schema before qualification. Account for its overhead and any buffered trace allocations. A cheaper instrumented surrogate or I/O mock cannot establish production performance. If output buffering would break resource/latency assumptions, resolve it before release and identify timing versus diagnostic images explicitly; do not infer unmeasured production counters.
8. **Evidence custody.** Preserve commands, stdout/stderr, direct/outer exits, timestamps, fixture/source/build hashes, raw work/timing/failure rows and authoritative owned-child/handle cleanup. Read back archived artifacts and verify hashes when publication is separately authorized. A missing artifact remains missing; recreating it does not recover the original.

The existing [conditional brief §9][BRIEF] remains the future command/check inventory and timeout reference. This report does not run, add or waive a command, nor grant dependency setup. The full README check set and known-flake once-alone rule remain; preserve original and rerun outcomes. Focused evidence does not make an unknown/red aggregate green.

## 8. Gates that remain unchanged

At the engine level, prove exact equal-observation semantics, fixed-input work/progress bounds, finite capacity/allocation/disposal and the unchanged no-change collector/wiring p99 share of <=2 ms, with maximum reported. Regular scheduled verification, repair when due and save work on unchanged input cannot be omitted from no-change evidence.

Later B10D-2 actual-entry evidence must still satisfy [contract 06][CONTRACT]:

- Paint: p99 <50 ms, max <200 ms, and at most 10 samples >=50 ms in every 1,000-sample window.
- Selected observation operation: p99 <100 ms, max <1,000 ms, and at most 10 samples >=100 ms in every 1,000-sample window; uncommitted updates are not successful samples.
- Local durable-COMMIT-to-containing-frame enqueue: p99 <50 ms, max <200 ms.
- Follower commit-to-paint: p99 <C+100 ms, max <C+1,000 ms at nominal C=1 s and C=5 s.
- No-change wiring p99 <=2 ms, maximum reported; all original stage shares and full-operation intervals retained.

Retain the single shared 8 MiB allowance/deadline, <=200-node profile with 20,000 headers, <=16 native readers, worker V8 64/8/4 MiB, <=24 MiB owned external buffers, <=2 MiB result payload, whole-process RSS delta <=32 MiB steady/<=64 MiB peak, bounded operation/result queues, 15-second lease TTL and existing renewal limit. Main catalog allocations are not an additional whole-process allowance. No extra publication, timer, service or authority renewal follows from this plan.

WAL+FULL, fencing, atomic observation/checkpoint/continuity/notice publication and durable reader ACK remain. LEG1's display scan cache does not become a native recovery mechanism.

B10D-2's >=1,000 operations per declared separate/simultaneous population, actual panel propagation, full soak/drain and fresh final review remain separate from LEG1's component evidence. B14 still needs its >=10,000 continuous samples per declared population, >=3 fresh application starts, rolling-window and supported-platform requirements. WSL, Herdr, real harness and live-home work remain owner-local, skipped and recorded here, never simulated. No formal production qualification is inferred from cloud evidence.

## 9. Ownership and release dependencies

### Current ownership comparison

| Area | Boundary |
|---|---|
| LEG1 conditional whitelist | New `legacy-catalog.ts`; bounded adapters/indexing in finder/tree/HudStatus; only pending legacy-save callback disposal in scan store; the six new LEG1 test/harness paths in the prior brief. No present reservation is granted. |
| B10D | Existing broad collector/link ownership requires explicit relinquishment of LEG1's named paths. Native scheduling/accounting/retirement changes precede LEG1/RCP1 under the route; actual `src/index.ts` and `src/tree-page.ts` adoption follows serially. |
| RCP1 | Native reader/checkpoint/store/resource work plus its explicitly serialized link capture seam. Its `src/collectors/rollout.ts` allocation/lifecycle work preserves legacy behavior and remains outside LEG1. No LEG1 shortcut into its continuity/disposal semantics. |
| B9-ICR producer | Its recorded eight-path core/link whitelist excludes all collectors and entry/render paths, so that particular producer is structurally separate from LEG1. It does overlap later B10D link work and remains serialized there. |
| Remaining B9/B16 additions | Root-parent, native digest, picker-label and remaining source fields still need an exact accepted ownership/interface reconciliation. A missing or unspecified whitelist is not disjoint. In particular, recheck whether finder/tree identity helpers are needed. |
| TPD1 / Inspector / DOC2 | TPD1 owns action dispatch and its explicit UI extension, not LEG1 collection. Inspector is a consumer, not a license for raw-session-ID joins or producer invention. Shared design/STATE/plan and policy/schema records are dispatcher-serialized. |

No source file is released by a disjointness observation. Recheck all of these on the **actual accepted** future base, not on an unaccepted combined WIP tree.

### Ordered decision gates

**G0: this report.** Save the read-only plan and link it from the owner-direction record if the dispatcher records it. Status is prepared, all measurement outcomes unqualified.

**G1: queue and base.** Finish the earlier ordered waves and B10D route's serial prerequisites. The inspected STATE records C3's named set merged, but B10B-S3F remains unresolved and DOC2/TPD1/later waves are not thereby released. Pin the actual accepted integration commit and current contracts/producer APIs. A documentation commit or old status row is not accepted integration.

**G2: design and ownership.** Reconcile the exact LEG1 whitelist, native/shared allocation and coverage-interface needs; record exclusive handoffs, any minimal design/interface amendment and the final experiment envelope. Confirm retained strict API behavior and actual caller non-adoption. No unsupported input or gate reduction may be introduced as calibration setup.

**G3: engine implementation/measurement admission, only if separately issued.** A specific engine-only brief must expressly retain strict callers, keep optimized adapters unadopted, assign a collision-checked branch/worktree, name the frozen source/runtime/command group, bounded execution window and authoritative supervisor/cleanup/return. Existing executor/lifecycle holds are not lifted. Different tool processes on one executor are not independent machines. Do not run local tests or retry denied facilities under a different wrapper.

**G4: engine evidence review.** A fresh Oracle reviews source plus the full retained evidence and separately disposes of parity, service proof, resource fit and timing. Passing this stage is **engine-only, no production freshness qualification**. It neither closes B10D's independent storage/liveness/retirement findings nor creates an accepted user-visible delay.

**G5: candidate integration release and policy preparation.** Assemble the proposed finite supported envelope, service floor/gap proof, worst-case opportunity count, measured time claims, failure/overload semantics and public coverage mapping. Explicitly mark actual-entry `K_adopt` and any corresponding visible-delay claim as unqualified if only engine evidence exists. After accepted dependencies, an explicit B10D-2 test-candidate whitelist/window may permit the actual-entry measurements needed to close those fields, without enabling the policy in production. This report does not issue that release. Keep strict production behavior while the candidate is evaluated.

**G6: actual-entry qualification and concrete production-policy decision.** The separately released candidate must exercise the actual final bar/panel paths and all gate populations, including native contention, fairness/publication, follower propagation, simultaneous soak/drain and final-state settlement. Present the resulting actual service envelope and user-visible delay, and record acceptance of that exact production policy through the owner-reserved workflow before production adoption. The earlier “both” answer is not acceptance of whatever delay the candidate produces; a materially changed resulting envelope requires its own applicable disposition. If unacceptable or infeasible, retain strict production behavior and return the specific alternative. A fresh prescribed Oracle verdict and green required checks on the actual history-preserving merged tree remain mandatory before status promotion. No main changes, force-push or history rewrite.

**G7: B14 formal qualification.** Complete its separate platform/capability obligations. Neither this plan nor component/B10D cloud measurements waive them.

## 10. Stop conditions and decision record

Stop the dependent action on any missing ordered prerequisite or accepted base; unknown/reused source identity; unresolved service allocation, ownership or truthful coverage mapping; unbounded accepted header/directory/parser work; supported-case cap failure; inability to retain strict callers during the engine-only stage; a new contract/profile/gate change; denied/uncertain execution or cleanup; or a required out-of-whitelist edit. Preserve independently useful evidence and return the exact blocked action, target, reason and known execution outcome.

The future final evidence summary must contain separate rows for:

1. Equal-observation data/frame parity.
2. Direction accepted, concrete production policy not yet accepted / accepted with exact reference.
3. Service-floor/order proof and worst-case opportunity bound.
4. Measured discovery/validation/catalog/adoption/paint latency, with wall-clock guarantee status.
5. Capacity, hard allocation/reservation and whole-process resource evidence.
6. Engine/component gate evidence.
7. Actual-entry B10D-2 gates, full settlement and soak/drain.
8. Full-check/review/merged-tree status.
9. Formal B14 platform/capability qualification.

Do not collapse these rows into “LEG1 passed” while later rows are absent. At this report's completion, rows 1 and 3–9 are **not measured by this consultation**; row 2 has only direction-level acceptance.

## 11. Source record and method

Relevant document blobs at the inspected pin:

| Document | Git blob |
|---|---|
| Owner-direction ruling | `f9ed82d266a0ff9ba1c08b897102e996e76f8fde` |
| Conditional LEG1 brief | `9eb27d22eb213bd26786c42ee48a241767406782` |
| LEG1 freshness disposition | `f78bcff21173fcc60831bfc2298f9b2c43fbdd85` |
| B10D route | `3c000582ffcf1628f238e6243bc5c2539401fcef` |
| RCP1 conditional brief | `26c07636a1c90288d0dde941ab45a165a664c6cf` |
| B9-ICR prerequisite | `48fa0caf5453f325c52eee4694fa10452407796d` |
| Contract 06 | `95b3dab8250a97f64c7b348a78cbcba4c344c879` |
| Design | `68674711a3a38855e9bb69fbdc5bbfcf9a03e452` |
| STATE | `7bb106a539102ea09c513f90bd3e8507f2260b30` |
| AGENTS / dots | `484370f426d002e97075bdac061c0847b95eb137` / `e586f2303819d3cc916a887ee24b0f9f41841add` |
| Queue / resource-window rulings | `0ce22868ffee35211c18a1079dfcc6d3284e0967` / `20bded878c6b77601634fde1c223dd0f378b6ba2` |

[OWNER]: https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/leg1-owner-direction-20261104.md
[BRIEF]: https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/leg1-conditional-brief-20261104.md
[FRESH]: https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/leg1-freshness-disposition-20261104.md
[CONTRACT]: https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/contracts/06-observation.md#L258-L304

Additional primary references:

- [B10D route and order](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/b10d-route.md).
- [RCP1 ownership/service boundaries](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/rcp1-conditional-brief-20261104.md).
- [B9-ICR producer ownership](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/inspector-conflict-prerequisite-20261104.md#L153-L196).
- [Design §6](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/design/hud-information-design.md#L849-L888), [STATE](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/handoff/STATE.md), [queue ruling](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/queue-progress-20261103.md).
- [AGENTS](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/AGENTS.md), [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/dots.md), [README checks](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/README.md), [resource-window rules](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/wave1-resource-windows-20261103.md).

Method: read-only GitHub file/tree retrieval at the assigned pin; comparison of source blob identities; inspection of relevant source and prior local reports; preparation of this standalone local report. No repository/worktree/branch changes, tests, builds, benchmarks, probes, dependency operations, implementation, production change or subagents were performed. No execution permission was requested or inferred.

**Final disposition: measurement/qualification preparation is complete; numerical service and delay claims remain unqualified; strict production behavior and all implementation/execution/adoption gates remain in place.**
