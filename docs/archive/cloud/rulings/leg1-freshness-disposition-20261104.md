# LEG1 F1: freshness feasibility and release disposition

Date: 2026-11-04. Role: fresh architecture Oracle, read-only source review.
Repository: CartmanFatass/codex-hud. Input: `leg1-conditional-brief.md`, especially §§5 and 10.

## 1. Decision

**Retain the strict production collection behavior. Do not release replacement of the synchronous bar path by bounded inactive polling, and do not treat watchers or a degraded badge as closing F1.** Exact next-collection discovery for the baseline's stat-detectable same-path rewrite class requires examining all relevant inactive files, or an authoritative complete mutation source. No such source is supplied by the present architecture or by portable filesystem watchers.

This resolves the technical choice without silently weakening a user-visible guarantee. The three-way requirement in F1 is infeasible as written. It does not establish that LEG1, B10D, or any performance gate is accepted. Earlier queue, accepted-base, ownership, compute/lifecycle, review and merge prerequisites remain in force.

**Recommended eventual product direction:** a separately recorded bounded-inactive-freshness mode with fair repair and truthful age/coverage, while retaining immediate priority-path verification and strict selection APIs. It is a policy change. Its actual opportunity and byte envelope must be fixed and proven before production adoption; an arbitrary short wall-clock promise is not a substitute.

For now, continue other authorized queue work. The exact owner-reserved issue is recorded in §9. This is not a request to seek permission for each ordinary implementation decision.

## 2. Authority and scope

The dispatcher supplied the following trusted conversation history:

<transcript_evidence>
用户：“批准 我给你全权 你以Oracle的意见为准即可 不要逐项要权限”
用户：“后续你有本地测试需求可以发给我 然后继续工作即可 我有空会完成测试 队列任务你直接完成即可 无需我批准 有需要抉择的地方请让oracle直接决定”
</transcript_evidence>

This supports choosing architecture, doing the authorized queue work and not repeatedly asking about routine forks. It contains no specific acceptance of a slower LEG1 discovery interval. The current B10D route explicitly reserves slower freshness/discovery for a separate owner decision: §2 requirement 4, §2 decision boundary, and §8. AGENTS and dots preserve reserved owner decisions. Existing delegated Oracle rulings such as the P065 fixed-metadata exception preserve their core guarantees and are not evidence that any arbitrary delay is acceptable here.

I therefore choose the compatible branch of the fork now. If replacing it is required, the owner question must name the actual change, rather than asking for generic permission to continue work. The dispatcher can record this ruling and proceed with unrelated ready packages.

No implementation, tests, builds, benchmarks, dependency installation, git mutation, repository publication or local-computer work was performed. This file is the requested consultation deliverable, not a modification of the repository or an execution admission.

## 3. Sources and baseline verified

The current `universal-hud` files were retrieved read-only during this review. All four collector identities still match the conditional brief's inspected pin `c9f64e5534a855b636bf70398aa4b66d9d0d4374` and its stated parity reference:

| File | Git blob |
|---|---|
| `src/collectors/session-finder.ts` | `30ed4c4d805a492ff49b410311ee11f0ab206fce` |
| `src/collectors/subagent-tree.ts` | `a040d7e0f9220344715c92b5c0bc7d2d6e113160` |
| `src/collectors/hud-status.ts` | `06c67217cf19b04267feea96cc511dd6982e6619` |
| `src/collectors/tree-scan-store.ts` | `67aa8f4704786b64cd8cf8c300a21da6b4b9e042` |

Current authority/document blobs inspected: AGENTS `484370f426d002e97075bdac061c0847b95eb137`; dots `e586f2303819d3cc916a887ee24b0f9f41841add`; B10D route `3c000582ffcf1628f238e6243bc5c2539401fcef`; contract 06 `95b3dab8250a97f64c7b348a78cbcba4c344c879`; STATE `83b6dd34ef64ea31f88e712e2e66c05df9aea9f7`. Also inspected design §6, concept §15, architecture §8 and the collector directory note. A branch-head identity is not inferred from these blob identities; the eventual accepted base must still be pinned at release.

Concrete baseline behavior:

1. `session-finder.ts:306–350` obtains a fresh stat for every file in the synchronous listing. The list itself can be cached using a directory signature.
2. `subagent-tree.ts:1053–1087` re-peeks an existing header for a same-size rewrite with changed mtime, shrink or detected replacement, or a changed negative entry. Duplicate choice at `1149–1152` uses the newest observed mtime; equal times keep the first enumeration candidate.
3. `subagent-tree.ts:62–65,1028–1045` selects at most two oldest-due header re-peeks after 30 seconds. This is a separate protection for mutations invisible to stat.
4. The yielding finder keeps new/growing/priority files current and has two quiet probes. Its 4,096-cache eviction at a 20,000-file population means actual baseline work/freshness is not the theoretical two-probe steady state. Removing that churn changes observed detection timing unless explicitly accounted for.
5. `hud-status.ts:140–146` still falls back to the synchronous tree builder when no tree is supplied. Retaining a strict public function while silently replacing this actual caller would not preserve production behavior.

### Do not overstate the baseline

The preserved next-collection property concerns files already present in the baseline listing and mutations that cause its strict logic to revalidate. It is not a guarantee for every conceivable rewrite:

- Same-signature header rewrites already rely on the two due re-peeks.
- The positive-cache growth fast path assumes append-only header stability. A rewrite that grows can initially reuse its header.
- A permission-only repair with no recognized stat-signature change can leave a negative header cached until revalidation.
- A same-signature directory membership change can evade the existing directory cache. The conditional brief's forced directory sweep is stronger recovery, not proof of existing exact membership detection.
- Bounded body signatures do not certify arbitrary untouched-looking interior history. Contract 06 F11 explicitly retains this limit.

The F1 same-size/newer-mtime counterexample is sufficient despite those limitations. Do not use baseline limitations as permission to remove a guarantee it really has, or silently expand “parity” to promise an atomic filesystem snapshot.

## 4. Why exact next-collection parity and bounded inactive polling conflict

Let a settled inventory have N inactive paths. An incremental opportunity examines a strict subset. Choose a path X outside that subset. Construct two source states that are identical on every path, directory signature, queue item and hint the algorithm observes:

- State A: X remains unrelated to the displayed root.
- State B: X is rewritten in place, with the same length and a newer mtime, so its header parent is now the displayed root. Deliver no hint and preserve directory membership.

The incremental algorithm must produce the same answer for both states because it has identical observations. The strict baseline stats X and re-peeks it in B, so its answers differ. The incremental algorithm cannot match both. The argument also applies to an inactive duplicate becoming the newest winner or a stat-visible negative entry becoming valid.

An index of the current reachable tree cannot exclude X: discovering that X has become reachable is the missing information. Random probes yield a probability, not the exact guarantee. Moving, yielding or parallelizing an all-file stat pass changes execution cost, not its O(N) information requirement. A full scan spread over several opportunities gives eventual convergence, not next-collection equivalence.

Even an authoritative journal would need a well-defined drained-through barrier relative to the collection boundary, complete path/identity coverage and bounded replay. A callback queue that happens to be empty is not that barrier. Under a burst that changes all N headers, any mechanism still has O(N) changed-work and the actual header bytes to process; no watcher can create a constant total-cost bound for arbitrary mutation volume.

## 5. Event mechanisms: useful hints, not the missing authority

### Portable Node watchers

Node documents platform inconsistency, unavailable or unreliable network/virtualized-filesystem notifications, optional filenames, and inode-based watches that remain attached to an old inode after delete/recreate on Linux/macOS. Windows also has directory move/rename limitations. Recursive watching does not establish complete delivery or a collection-time barrier. These are reasons to invalidate and repair, not to certify an unchanged tree. [Node 22 filesystem watcher caveats](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats).

### Native mechanisms do not remove the general failure cases

Linux inotify can overflow and lose events; its documentation recommends cache reconstruction. Directory watching has subdirectory-installation races and does not report modifications through an external hard link. Network-side changes and mmap-related modifications are further limitations. Rename events need not appear as an atomic pair. A Linux-specific backend could improve common-case latency, but these properties do not give the required universal mutation certificate. [Linux inotify manual](https://man7.org/linux/man-pages/man7/inotify.7.html).

Windows ReadDirectoryChangesW discards its buffered changes on overflow and instructs callers to enumerate the directory/subtree. Its documentation also distinguishes notification from actual storage visibility. A successful watcher call is therefore not proof that the cache contains every intervening change. [Microsoft ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw).

The architectural inference is that a truly authoritative journal/cooperative-writer protocol would be a new separately scoped mechanism: source identity, gap detection, registration races, cursor recovery, journal retention, replacement handling, supported filesystems/platforms and a collection barrier must all be specified. Restricting support to a particular filesystem is itself a profile change. It is not LEG1's existing watcher-hint optimization. Per-file watchers, extra polling services and callback-triggered collection remain outside its whitelist.

### Required hint handling in either mode

- Coalesce bounded path/directory invalidation only; do no collection in the callback.
- Missing filename, overflow, registration loss or watcher error requests bounded repair with a retained cursor.
- Independently scheduled directory enumeration and file/header revalidation must converge with every hint dropped.
- A directory read failure is unknown membership, not successful empty enumeration.
- Source/root replacement or scope ABA invalidates old work; a stale result cannot become the current-root fallback.
- Repeated hints must not starve oldest due work, create unbounded queue allocations or grant an extra operation.

## 6. What the existing budgets actually permit

Preserve the supported 200-node/20,000-header population; the once-per-logical-operation shared 8 MiB allowance and cooperative deadline; the reader limits; the no-change p99 <=2 ms share; and all three latency gates. No new service, per-callback allowance or hidden native-reader grant is available. LEG1's proposed 32,768 inventory slots, 4,096 directory slots, 16 MiB catalog and 2 MiB owned transient caps are not extra whole-process budget and are not proven sufficient by this review.

### Count and time arithmetic

For a fixed inactive set of N files, with a real guaranteed q successful signature validations per ordinary opportunity, one fair sweep takes at most `ceil(N/q)` opportunities. With only an upper limit of q, and no minimum service reservation, there is no such progress bound.

At N=20,000:

| Completed probes per opportunity | Opportunities for one sweep | Nominal active C=1 s | Nominal idle C=5 s |
|---:|---:|---:|---:|
| 2 | 10,000 | 2 h 46 m 40 s | 13 h 53 m 20 s |
| 64 | 313 | 5 m 13 s | 26 m 5 s |
| 128 | 157 | 2 m 37 s | 13 m 5 s |

These are illustrative scheduling arithmetic, **not approved quotas, measured timings or unconditional wall-clock bounds**. Add scheduling delay, work continuation, read/parse failures and tree assembly. For age-gated header revalidation add its initial eligibility delay and any remaining content work. Thirty seconds makes a header eligible; it does not mean every header is checked within 30 seconds. The actual strict `>` comparison also matters at the boundary.

Increasing signature probes alone does not accelerate content verification when many changed headers queue behind two re-peeks. A stat-visible rewrite requires both detection and validated header/tree adoption. Duplicate groups and negatives must participate, not only current winners.

Even idealized 20,000 headers of 1 MiB each contain about 19.53 GiB. At an otherwise completely unused 8 MiB allowance they require at least 2,500 operations before delimiters/signatures; actual overhead can require more. At C=5 s this is at least 3 h 28 m 20 s, before any other work. A claimed full arbitrary-header recovery in 30 seconds at C=5 s has only six ordinary opportunities, 48 MiB total before competing work, and is not feasible for that legal-size exercise.

### Newly identified legacy byte-bound issue

`subagent-tree.ts:102–119` does **not** enforce a 1 MiB byte limit. It compares decoded JavaScript `chunk.length` with `MAX_FIRST_LINE_BYTES`, reading 64 KiB chunks. Multibyte UTF-8 input can consume substantially more than 1 MiB of actual reads before that character threshold, and the final chunk may overread the newline. The session finder's other first-line reader has different behavior.

Consequently, contract 06's native-reader maxRecordBytes cannot simply be used as a per-legacy-header I/O or allocation bound. A release proof must account for actual bytes, chunk overread, decoded strings, parsed objects and verification. If the implementer proposes changing accepted header limits or parsing/restore meaning, that is a separate explicit compatibility disposition; it cannot silently truncate supported headers. The 2 MiB transient proposal cannot be deemed sufficient merely because the constant is named MAX_FIRST_LINE_BYTES.

### Service and capacity obligations

1. Reserve repair service inside the original operation grant, not from “whatever is left” forever. State how this coexists with priority work, native-reader fairness and one selected publication. If the shared scheduler cannot honor both, stop for the cross-package allocation decision.
2. Counts of directories alone are insufficient. Charge every enumerated entry, including nonmatching names, and actual buffers/path storage. A one-directory `readdir` can still process the full population.
3. Bound both metadata operations and bytes. A byte ceiling by itself does not bound 20,000 stats; a record ceiling by itself does not bound large headers.
4. Preserve the original enqueue/due time through busy/expired/continued opportunities. A failed read is not completed validation. Persistent failure makes freshness unknown/stale, not a successful finite-time repair.
5. A continuously mutating source or service demand exceeding admitted capacity cannot have unconditional convergence. Show the overload/backlog and keep compatible prior output. Do not remove supported cases from measurement merely because they return partial or capacity-exceeded.
6. Scheduled no-change verification, periodic sweeps and save work belong in the no-change population when the input is unchanged. Do not call them cold or changed work to evade the 2 ms share.

## 7. Concrete release criterion

### A. Production-compatible criterion selected now

F1 is **not a performance exemption**. Production replacement is released only if the candidate satisfies both of these, plus the original package gates:

1. With hints disabled, it preserves the strict next-collection behavior for the class in §3, as verified against the actual baseline code at equal fixed bytes, clocks and observation boundaries. Same-path parent changes, duplicate winner changes and negative-to-valid changes are required cases.
2. It meets the unchanged no-change work/resource/latency requirements without claiming a watcher as authoritative or reclassifying ordinary work.

The present bounded-polling design cannot satisfy both. The feasible compatible action today is therefore to **retain the strict production facade and its callers**, with no optimized-adoption acceptance claim. A strict full-stat pass may be optimized and measured, but retains O(N) validation and cannot be reported as satisfying LEG1's no-full-population-work criterion. The retained 85–132 ms legacy measurements are evidence of the current problem, not a proof that every possible full-stat implementation has that cost or a waiver of the gate.

### B. Non-production catalog preparation can remain separately useful

The existing brief already separates the catalog engine from later B10D-2 entry integration. Preparation or, after a separate scheduling/ownership release, an unused engine can establish representation bounds, incremental affected-tree updates and data parity at controlled observation boundaries while all strict APIs/callers remain unchanged. Its result must say **engine-only, no production freshness qualification**.

This ruling does not itself release that implementation or amend the current checklist to bypass F1. If the dispatcher wishes to release engine-only implementation before the policy decision, its separate brief must expressly keep the optimized adapter unadopted, retain the F1 counterexample, prohibit global fallback/default changes and reserve final production acceptance. Do not call an engine-only result final LEG1 or B10D acceptance.

### C. Exact qualification contract required for the recommended bounded mode

Before a slower mode can replace production, record one approved finite service envelope with all of the following concrete quantities and claims. Leaving any of them as “periodic”, “eventually”, “when idle” or “a few ticks” fails release:

- `N`, `D`, `E`: maximum admitted file records, directories and actual enumeration work for the declared supported population; negative/duplicate/absent entries are included. A larger retained-capacity ceiling is not permission to shrink support.
- `q_s`, `q_e`: minimum fair signature and directory-entry progress per ordinary opportunity under the stated healthy-service preconditions, plus maximum work ceilings. If each directory open/close/stat also consumes a quantum, account for it explicitly.
- `q_h`, `b_h`: minimum header-completion service and/or guaranteed header-byte progress, including actual rereads/signatures and an explicit handling of a maximum accepted legacy header. Quantify parse/assembly work rather than assuming all headers cost one cheap probe.
- `K_gap`: a finite maximum number of ordinary opportunities between repair service grants, with missed/failed grants retained in the trace. No definition that removes all busy opportunities from the denominator and then claims an ordinary-opportunity bound.
- `K_tree`: finite service for validated changes to propagate through affected duplicate/dependency groups and a complete candidate tree; detection alone is not delivery.
- Age eligibility and scheduler order, including independent directory sweep, duplicate losers, negative entries, creation/deletion, root lookback and midnight changes; stable queues must not restart on each hint.

A valid fixed-input bound is derived from that envelope, for example:

`K_detect <= K_gap * ceil(N / q_s)` for one signature sweep;

`K_discover <= K_gap * directory_work_quanta(D,E)` for one independent successful membership sweep;

`K_visible <= K_detect_or_discover + K_headers + K_tree`.

`K_headers` must be derived from both completion-count and byte-service bounds, with the implementation's actual scheduling/packing overhead. It cannot be inferred from a maximum budget. For a concrete conservative construction that guarantees only one header in progress at a time and at least `b_h` charged useful bytes per repair grant, summing `ceil(actual_header_work_i / b_h)` over the finite queued headers gives a valid byte-progress bound, then add count-limited/parse/verification overhead. A faster batching bound requires proof of its actual service policy.

These are count/service guarantees under fixed, readable input and stable scope. An advertised wall-clock bound additionally requires a qualified bound on opportunity spacing and operation completion. Ordinary C=1/5 seconds is a cadence, not a guarantee against I/O stalls, suspension, loss of grants or failures. The supported production configuration must report breaches and pass all retained latency/resource populations; it cannot be qualified solely on an isolated empty-budget scheduler test.

I do not select arbitrary `q_*` or a promised wall-clock interval without measurements and a recorded freshness policy. The numeric examples in §6 expose the tradeoff; they do not authorize one. This is a concrete release checklist with falsifiable formulas, not a claim that the currently proposed limits have already been demonstrated compatible.

## 8. Honest parity, freshness and degraded semantics

Keep four distinct facts:

1. **Data parity at equal observation boundaries:** equal inputs actually observed yield the same complete legacy fields/tree/frame as the pinned reference, except separately approved fixes. This is required of the engine.
2. **Discovery/freshness parity:** the same mutation becomes visible on the same eligible collection. A bounded inactive mode intentionally does not have this for F1's class, and must say so.
3. **Fixed-input convergence:** all retained due work finishes within the proved service envelope once inputs/scope settle and service is healthy. It is not a promise to catch arbitrarily short-lived unseen mutations or to converge under unbounded writes.
4. **Production qualification:** actual bar/panel entries adopt compatible snapshots with truthful state and meet complete latency, resource, fairness and propagation gates. Engine evidence does not establish this.

For a future bounded mode, metadata should distinguish last complete compatible snapshot, per-class successful verification/frontier age, due backlog/oldest age, watcher/repair state and failure reason. A fresh root/body read must not refresh the entire inventory's successful-read time. The catalog does not invent B16 freshness, heartbeat activity, stateSince, native sourceGeneration or observation commits.

Completeness means the declared known input/observation boundary is consistently represented; it does not mean every file is current at render time, all history is authenticated, or a multi-op sweep is an atomic filesystem snapshot. Keep immutable old output while repairing; never expose a half-rebuilt topology as complete. Root/source changes invalidate incompatible fallback.

A known overflow, repair backlog, failed verification or missed promised service bound must preserve/age old evidence and disclose catching-up/unavailable/unknown as appropriate. Silence is not proof of freshness. Conversely, displaying a warning forever is not successful progress, and a “degraded” label does not make slower behavior compatible with the strict contract.

The existing LEG1 whitelist owns no renderers or shared freshness schema. If existing health/coverage channels cannot represent these facts accurately, obtain the exact interface/rendering amendment before adoption. Do not hijack root `health.lastReadAt` as a catalog certificate, or unilaterally change B16 classifications.

## 9. Owner-reserved question and recommendation

Suggested recording destination: `docs/handoff/questions/LEG1-freshness.md`, linked to the ruling and conditional brief. The dispatcher owns repository recording.

**Question:** May the optimized production legacy collector replace next-collection detection of otherwise-inactive stat-visible same-path changes with a separately quantified bounded inactive-discovery policy, including duplicate losers and negative entries, while preserving immediate priority verification, strict selection APIs, exact field meanings, complete compatible snapshots, supported profile and all resource/latency gates?

**Recommendation:** permit that policy direction only with the explicit finite service envelope and truthful coverage in §§7C–8, after its actual supported-runtime feasibility has been demonstrated. Do not approve an unconditional 30-second full recovery promise, watchers-as-authority, a reduced 20,000-header profile or an unmetered sweep. If the owner does not accept the resulting concrete delay, retain strict production semantics and commission a genuinely authoritative source mechanism separately; do not hide the mismatch.

The default selected by this ruling is the compatible strict behavior. No answer is needed for unrelated ready queue work. A future broad “continue” is not a measured numeric freshness SLO; record whichever concrete replacement is actually chosen before implementation/adoption depends on it.

## 10. Required evidence when execution is separately admitted

No test was run in this consultation. Future release evidence must include:

- The F1 two-world counterexample for every eligible cold position, duplicate winners/losers and negatives, with no rescue hint or append. Retain strict-baseline success and bounded-mode delay as distinct expected observations.
- A fixed 20,000-file inventory beyond the old cache cap; adversarial probe ordering; all hints dropped; dirty-queue overflow; source/root A→B→A; same-signature membership changes; unreadable→readable recovery; midnight/lookback changes.
- Large and multibyte legacy headers with actual read/parse/allocation accounting, byte continuations, deadline exhaustion, failures and retried verification; no incorrect 1 MiB assumption from a character counter.
- Fixed-input convergence across the full promised sweep, not just a 1,000-op benchmark that ends before a 10,000-op repair cycle. Include whole-run/backlog age and all missed grants. An abbreviated test window is not proof of the full recovery bound.
- Repeated hints/hot work cannot starve older inactive, duplicate or negative records; directory repair includes all actual entries and failures never delete the old membership by assertion.
- No full-population traversal/allocation in a stable incremental opportunity, no cache-churn rescue, finite memory/queue/disposal accounting, no stale scope publication and immutable retained snapshots.
- Full legacy-field/frame parity at equal verified inputs, with source selection and scan-store compatibility unchanged. Classify stronger invalidation fixes separately from baseline equivalence.
- Actual B10D-2 main/panel integration, no-ledger/worker/null/non-null cases, native-reader fairness and publication limits, C=1/5 propagation, original full intervals, no-change periodic costs, separate/simultaneous populations and soak/drain. Keep B14's formal obligations separate.

**Final status:** feasibility contradiction confirmed; strict behavior selected; watcher-only remedy rejected; bounded-policy recommendation and exact release proof obligations supplied. F1 is not cleared for optimized production replacement. No new guarantee, gate waiver, package acceptance, implementation or compute authority is granted.
