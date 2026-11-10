# TEST-SLIM-0 consolidation proposal

**Draft for orchestrator decision. No tests, product code, manifests or baseline bytes changed.**
Only `docs/testing.md` belongs in the worktree. This proposal and its census/helpers are
external under `<repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/` (QA q1 ruling).

## Evidence, counting and limits

- Snapshot `f1d086e` includes A5, excludes in-flight R5UX-P3B and PIROLE-PR4. Current map
  has 190 behaviour rows (compound ownership and remaining identified routes split after independent reviews; final corrections are not independently re-reviewed). The 400-record inventory is a file census, not a sampled report.
- Default suites: 320 `.test.ts` -> compiled unit `.test.js`, 43 direct `.mjs`, 22 hud-mcp
  `.test.ts`: **385 files / 136,315 lines**. Plus 4 mutant drivers, 5 performance scripts,
  6 MCP benchmark/trace scripts: **400 files / 138,126 lines**. Bench support scripts count
  as one standalone carrier, not one assertion. Audit 173k/382 uses an earlier, broader
  source set; do not subtract these figures from that headline.
- Static AST index has **3,715 test declarations** (including hostTest/sqliteTest aliases). Template/loop expansion and standalone
  script carriers are not static declarations. `number_of_cases` uses historical expanded
  unit cases where available; direct mjs/MCP counts now use the authorized baseline's
  expanded results, explicitly labelled `case_count_basis`. The measured default total
  is **5,473 = 4,493 unit + 761 mjs + 219 MCP**. Scripts and mutation variants remain
  labelled carrier/variant counts; declarations and test executions are not interchangeable.
- All **4,493** historical gate cases associate to the current 320 unit files: literal or
  template-pattern title matching (including empty interpolation), then nested/file
  ordering. All titles resolve: B12R's optional restart suffix and dispatch's absent phase
  are empty interpolation, not removed tests. Three child B21 reporter lines are excluded
  from the total (saved in `embedded-gate-cases.json`), because the parent process test
  already contains their time. `gate-cases.json` records every association and method.
- Gate result: 4,466 pass, 1 fail, 26 skip; wall **350.680 s**, summed test time
  **1,332.547 s**. Failure: `P2 measured quiet/change/large-history/scroll/resize rendering,
  three runs on named host`, quiet p95 2.034565 ms > 2 ms. It is not a passing current
  baseline. 180 cases exceed 1 s; 52 exceed 5 s. Historical gate timings cover unit only;
  null means no historical measurement, not zero. The new baseline timings are separate
  in §3h. Sums are not wall time or additive parallel speedups.
- `stand_ins` captures literal fixture paths, recursive local test imports, fake references,
  inline port candidates and own `mkdtemp` setup. The current syntax count is **192**
  unit/mjs files with temporary roots (audit said 193 at another snapshot); it does not
  mean every root is HOME. Source hashes make later drift visible. `file-map.py` explicitly
  associates every one of the 400 files with its tested product boundaries; there is no
  filename-family fallback. `map_evidence` retains named owning proofs and supporting
  declaration titles. Supporting facets are not permission to delete unique assertions.
- **123 scoped files are frozen** by WP0 mapping or visual layer. `wp0_roles` includes
  coverage, tests keys, branch carriers and mixed-file membership. No savings below count
  editing those files, moving their perf cases, or weakening their assertion/hash checks.

## 3a. Duplication clusters: retain invariants, consolidate repeated scaffolding

`fold` means **fold into owner as named table rows**, not delete a failure condition.
Preserve real entry paths, unique branch coverage, per-row authority/environment and
cleanup. Existing tests already using tables need no conversion merely for style.
`keep` includes distinct-layer integration evidence. Every case not selected below stays
**keep** by default. A source title or line is a handle into `inventory.json`; line numbers
are snapshot locators, not permanent test IDs. Savings are engineering estimates from
repeated setup spans, not measured after-results. Lowered-layer time reductions are not
credited before profiling. All folds are gated on §3h's before/after coverage proof.

### C1 — P02/P04: current QA versus apparent activity

Owner: `tests/unit/work-card-p2.test.ts:82` — **P2 current unanswered QA outranks working; historic QA and a written answer do not request another answer, and per-worker observation loss stalls**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `work-card-p2-request.test.ts:16` — P2 q19: facade helper QA requires current helper and question proof; protocol hints cannot override negative Task evidence | fold | P02: old/unknown helper epoch, QName before start, answered negative Task evidence; keep the real buildWorkboard/projectWorkCard/draw path. |
| `work-card-p2-request.test.ts:97` — P2 q21: live answered root pause uses answer time; stale freshness, threshold and old-episode answers do not fake progress | fold | P04: answer timestamp plus live corroboration; exact 599999/600000ms edge and stale/new-episode negatives remain separate rows. |
| `work-card-p2-request.test.ts:153` — P2 q20: losing/regaining helper and QA proof never revives stalled work; primary and helper transitions date separately | fold | P04: losing/regaining proof is not progress; primary/helper transition clocks remain independent. |
| `work-card-p2-request.test.ts:224` — P2 q19: dispatch without Task evidence never infers helper QA, but primary wait and direct-Pi protocol remain authoritative | fold | P02: absent Task evidence differs from negative Task evidence; preserve direct-Pi and primary-wait authority. |
| `work-card-p2-request.test.ts:287` — P2 q24: a replacement primary and current helper can rewrite an identical question; physical proof is not content novelty | fold | P02: identical rewritten question is current only with physical primary/helper proof; not content novelty. |
| `work-card-p2-request.test.ts:346` — P2 q24: replacement root identical question and answer stop asking; new-episode answer anchor survives touches and proof loss | fold | P02: replacement-root answer anchor survives touches and proof loss; do not reduce this to the q19 row. |

Estimated net saving: **90–170 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C2 — P05: primary result currency and continuation

Owner: `tests/unit/work-card-p2.test.ts:405` — **P2 a replacement episode cannot reuse an old primary output or impossible settle time; execution status remains the producer status**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `work-card-p2-output.test.ts:12` — P2 q22/q23: identical physical current report is a result, old/no write is not; semantic touch and legacy initial fallback stay unchanged | fold | P05: primary output has no report-mtime <= settle upper bound; preserve output_written, old/no write, same-byte rewrite and legacy initial-start fallback. |
| `work-card-p2-output.test.ts:87` — P2 q22: same-session facade continuation admits identical rewritten output only with the new start/floor and actual current write | fold | P05: same-session continuation floor/new start plus actual current physical write, not a different-session-only test. |

Estimated net saving: **40–80 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C3 — P03: review evidence and Inspector refinements

Owner: `tests/unit/work-card-p2.test.ts:270` — **P2 review evidence is exact, matching, settled and written; CR fixing requires resumed primary and latest round survives compacting**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `work-card-p2-output.test.ts:133` — P2 q22: identical review bytes rewritten by a current settled/written helper admit the phase; old or out-of-settle writes never supply it | fold | P03: review output DOES require mtime <= settle; retain this stricter rule separately from primary output. |
| `work-card-p2-review.test.ts:21` — P2 review: reused/unknown helper timing cannot fail a replacement primary; current failure and root authority survive | fold | P03: reused/unknown helper timing cannot fail a replacement primary; current failure/root authority remain. |
| `work-card-p2-review.test.ts:217` — P2 review: readable current QA/default/evidence reaches compact, expanded, and source Inspector; unavailable details fall back | keep | P06: production compact/expanded/Inspector propagation, not another evidence-validation case. |
| `work-card-p2-review.test.ts:283` — P2 review: real facade multi-round history reaches existing job Inspector without removing any native/job detail or controls | keep | P06: multi-round Inspector history retains native/job controls, not evidence admission. |

Estimated net saving: **30–60 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C4 — M03: no text across revocation/publication fences

Owner: `tests/unit/job-materials.test.ts:1328` — **synchronous compose and queued/running lifecycle revocations cannot cross the send fence**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `job-materials.test.ts:1385` — an external-style atomic revoke inside compose cannot consume a cached reply | fold | M03: external atomic policy replacement inside compose cannot consume cached reply; preserve exact cache bytes. |
| `job-materials.test.ts:1421` — a telemetry clock callback cannot invalidate the final send fence | fold | M03: telemetry clock callback revokes at final send fence; retained post-reserve charge is intentional. |
| `job-materials.test.ts:1463` — job worker cache hits are free and revocation before their microtask releases no cached text | fold | M03: cache-hit worker microtask revocation is free, no transport/no text/no cache rewrite. |
| `job-materials.test.ts:1505` — worker validation cannot prune a cached reply after its callback revokes consent | fold | M03: response validation callback revokes before cache pruning; not just a transport-failure row. |
| `job-materials.test.ts:1622` — cancel or revoke between job submit and its microtask sends nothing | fold | M03: cancel/revoke between submit and microtask starts no transport. |
| `job-materials.test.ts:1648` — settlement observers revoke transport results and worker cache hits before text publication | fold | M03: settlement observers fence both transport results and worker cache hits. |
| `job-materials.test.ts:1715` — telemetry-time revocation is fenced before successful job publication | fold | M03: telemetry-time revocation fences successful publication, not only send. |
| `job-materials.test.ts:1753` — settlement cancellation honors individual handles and cancelAll before publication | fold | M03: individual cancel and cancelAll at settlement do not release text. |
| `job-materials.test.ts:1542` — natural late expiry is job pending without cap/cache/failure effects, and fresh-budget retry succeeds | keep | M04: natural deadline expiry is pending and retryable, NOT authorization denial. |
| `job-materials.test.ts:1587` — a real revocation found during compose wins over simultaneous deadline expiry | keep | M04/M03: real revoke wins simultaneous deadline expiry; preserve distinct error precedence. |
| `job-materials.test.ts:1792` — post-reserve budget exhaustion before running cleans ownership and permits same-input retry | keep | M04: post-reserve ownership cleanup and original charge accounting differ from publication denial. |

Estimated net saving: **170–300 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C5 — F12: Jev facade lifecycle and projection

Owner: `tests/unit/role-facade.test.ts:1544` — **a closed jev job stays closed**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `role-facade.test.ts:1807` — hud_read does not reopen a closed jev job | fold | F12: append closed-read-after-close/racing read to closed lifecycle owner; preserve no re-open and serialized close/create race. |
| `role-facade.test.ts:1629` — a transient jev error leaves the job state unchanged | keep | F12: ECONNRESET read/send keeps receipt state, not a terminal runtime failure. |
| `role-facade.test.ts:1689` — a jev retry uses the binding stored on the receipt | keep | F02: immutable receipt binding after routing mutation; not generic idempotency. |
| `role-facade.test.ts:1743` — hud_read carries the runtime error code | keep | F12: terminal runtime error is successful observation with typed status, not transport unavailability. |
| `role-facade.test.ts:1788` — a jev create points at hud_read | fold | F12: wait command/argv is hud_read, no brief path; add as named assertions to oracle-create mapping at line1275, not closed lifecycle. |

Estimated net saving: **50–100 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C6 — F02: roster parser and CLI projections

Owner: `tests/unit/roster.test.ts:100` — **fixture errors name the field**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `roster.test.ts:439` — prototype preset and backend ids are unknown, and a path after = is rejected | fold | F02: prototype IDs and equals-path refusal become named parser table rows, retaining precise error fields. |
| `roster.test.ts:318` — hud roster JSON is stable and sessions do not share a selection | keep | F02: JSON CLI projection and per-root selection remain a boundary owner. |
| `roster.test.ts:401` — roster help and argument errors do not read HUD_HOME | fold | F02: help/invalid arguments invoke real CLI handler with injected streams/env; retain no HOME read, one installed-bin smoke at line588. |
| `roster.test.ts:424` — roster reports a bad home and a bad file without launching | fold | F02: bad HOME/file errors become CLI boundary rows under line318; assert no launch. |
| `roster.test.ts:588` — installed hud entry lists the example roster | keep | F02: sole installed-entry smoke retains executable dispatch and example roster composition. |

Estimated net saving: **40–80 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C7 — X10: signal/waiter matrices share a process harness, not an expected result

Owner: `tests/unit/run-light-leader.test.ts:300` — **mid-read ${signal} preserves DONE bytes under ${JSON.stringify(shell)}**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `run-light-leader.test.ts:345` — mid-read ${signal} preserves forwarder control bytes under ${JSON.stringify(shell)} | keep | X10: forwarder control bytes differ from DONE bytes; share process harness only. |
| `run-light-leader.test.ts:403` — repeated group signals preserve exact wait status at stopped-waiter exit boundary ${JSON.stringify(shell)} | keep | X10: stopped-waiter exit boundary and repeated signals retain exact status. |
| `run-light-leader.test.ts:460` — signals after real wait returns preserve exact completion status ${JSON.stringify(shell)} | keep | X10: signal after wait returns is a separate interleaving; no fake timer replacement. |
| `run-light-leader.test.ts:517` — waiter ignore is post-fork and preserves ${observation}-ignore workload and exec defaults ${JSON.stringify(shell)} | keep | X10: post-fork waiter ignore must not alter workload/exec dispositions. |
| `run-light-leader.test.ts:591` — terminal-style group SIGINT reaches default workload ${JSON.stringify(shell)} | keep | X10: terminal-style real group SIGINT reaches default workload. |
| `run-light-leader.test.ts:625` — reader ignores do not leak to ${fork}-ignore workload or exec descendant ${JSON.stringify(shell)} | keep | X10: reader ignores cannot leak across fork/exec. |
| `run-light-leader.test.ts:908` — light leader keeps ${result} sourced as native_unknown and completes scope | keep | X10/L04: sourced native_unknown differs from exact stamped native wait status. |
| `run-light-leader.test.ts:953` — compatibility native waiter retains exact ${result} with full subject stamp | keep | X10: exact native exit and subject stamp need real source topology. |
| `run-light-leader.test.ts:1530` — portable Bash source matrix ${JSON.stringify(shell)} ${result} | keep | X10: portable Bash/exit matrix is already parameterized; preserve all shell variants, share only launch/cleanup setup. |

Estimated net saving: **80–150 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C8 — Shared herdr stand-in, three implementations

Owner: `tests/unit/role-facade.test.ts:326` — **create read send respond close against the fake herdr**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `panel-control.test.ts:218` — panel intent precedes split, unique tokens, duplicate open is idempotent, display-only paths and exact env | keep | X07: panel split/env/token/generation protocol differs from role tab lifecycle; migrate setup to shared herdr profile, not assertions. |
| `panel-control.test.ts:1115` — panel production adapter sends exact no-focus split env and quoted argv to subprocess fake herdr | keep | X07: one real subprocess fake proves exact argv/no-focus env; in-memory fake cannot replace it. |
| `pi-owned-orchestration.test.ts:244` — owned launch: intent/outer transaction precede effects; structured argv; passive reads write nothing | keep | X01: ownership journal-before-effect ordering remains; shared fake adds owned-worker/editor/stamp profile. |
| `pi-owned-orchestration.test.ts:276` — owned crash matrix: lost ${step} reply ${window}; same-key retry has zero duplicates | keep | X02: before/after lost-step rows survive; no collapsing launch_unknown into a successful acknowledgement. |
| `pi-owned-orchestration.test.ts:514` — SIGTERM requires full process stamp and exact contract/session argv; no workload SIGKILL | keep | X03: full stamp/contract argv is required for SIGTERM; never replace with fake success. |

Estimated net saving: **180–330 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C9 — Shared pi scenario model, four different adapters

Owner: `tests/unit/pi-owned-orchestration.test.ts:1020` — **real pi loader worker ${role} startup and two-entry ownership**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `pi-dispatch-facade.test.ts:130` — dispatch facade maps ${role}.${phase ?? ''} with frozen task contract | keep | F01/F02: all role.phase dispatch rows remain; new shared fake supplies STATUS/QA/artifact scenarios. |
| `pi-owned-orchestration.test.ts:1074` — real pi loader ${mode} fails before prompt | keep | X05: loader failure/model mismatch/effort mismatch remain separate refusal rows with the real pinned loader. |
| `pi-package.test.mjs:302` — REAL package entry start -> reload -> shutdown preserves synthetic p10k fields; exactly six proxies and no footer or message calls | keep | R04/E03: real package host event wiring/UI ownership is not the same protocol as an owned worker. |
| `role-facade.test.ts:1203` — pi-role uses args-json and does not inherit notify env | keep | F03: launcher args-json and no notify-env leakage remains its own boundary row. |

Estimated net saving: **120–220 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C10 — R02: release validation envelopes and corruption

Owner: `tests/unit/runtime-package.test.mjs:18` — **manifest validates complete bounded payload and exact locked production identities**. Keep the owner.

| Other case (current file:line — exact title) | Decision | Why / retained distinction |
| --- | --- | --- |
| `runtime-package.test.mjs:110` — malformed manifest is refused before copy | fold | R02: malformed manifest errors become named validation rows before copy. |
| `runtime-package.test.mjs:193` — frozen shared metadata envelope rejects malformed or unknown fields | fold | R02: malformed/unknown metadata stays rejected even with a valid bounded payload. |
| `runtime-package.test.mjs:198` — valid optional metadata stays inert; dirty development bundles remain valid | keep | R02: optional inert metadata/dirty dev validity is positive compatibility, not a negative duplicate. |
| `runtime-package.test.mjs:257` — fix1 SemVer rejects numeric prerelease leading zero: ${version} | fold | R02: numeric prerelease-leading-zero rows retain every SemVer variant. |
| `runtime-package.test.mjs:271` — fix1 SemVer accepts standard prerelease/build: ${version} | fold | R02: valid prerelease/build remains independent positive table rows. |
| `runtime-package.test.mjs:281` — fix1 bundle rejects unsafe full permission mode: ${name} | fold | R02: full unsafe permission modes retain real filesystem assertions, not just schema validation. |
| `runtime-package.test.mjs:286` — exactly MAX_ENTRIES payload files plus manifest is valid; one extra is rejected | keep | R02: MAX_ENTRIES exact boundary and one-over are correctness, not removable throughput. |
| `runtime-package.test.mjs:334` — fix1 interrupted builder ${signal} reaps owned child and writes failure receipt | keep | R03: actual interrupted builder owns/reaps its child; stay real process. |

Estimated net saving: **60–110 test lines; 0 s credited**. Named logical cases and their distinct assertions survive; no runtime speedup is inferred from fewer wrappers.

### C11 — inherited display overlaps (no editable duplicate)

`monitor.test.ts` (52 declarations / 1,960 lines), `settings-page.test.ts`,
`cards.test.ts`, `cards-l1.test.ts`, `b10b-s2-*`/`b10b-s3-*` files where `wp0_mapped=true`,
`work-card-p2-frames.test.ts`, `workboard-frames.test.ts` and `visual-baselines.test.ts`:
**keep every case and baseline**. The P2/current Work owners refine evidence and current
layout; they do not supersede the inherited monitor selection, Git, tabs, help or control
contracts. `work-card-p2-review.test.ts`'s Inspector/linger cases also stay as distinct
production integration proofs. Similar width or status words are not deletion evidence.
There is no monitor file shrink in this authorized proposal, despite its audit size.

### C12 — exact duplicate mutation (one deletion proposal)

Delete only the `old-generation-close` **variant** from `tests/role-summary-mutants.mjs`,
not its target test or the driver. `tests/panel-control-mutants.mjs` already has
`old-generation-end`: same control module guard, same before/after replacement removing
`o.generation !== r.generation`, same `panel intent precedes split` assertion. The latter
is the owning negative control. Retain all positive/negative controller tests unchanged.
Estimated **9 driver lines / one opt-in mutation invocation** saved; seconds unmeasured.
There are **no other unconditional case deletion proposals**. In particular, historical
ledger tests are not removable just because the new facade bypasses that machinery.

Cluster subtotal C1–C10: **860–1600 scoped test lines** saved, excluding fake files.
C12 adds 9 lines outside default suites. Cases retain original expanded identities when
turned into tables. Setup consolidation, rather than throwing away adversarial cases,
is the defensible saving supported by the static read.

## 3b. Stand-in and fixture consolidation

The capability union and safety rules are in `docs/testing.md` §4. Migration destinations:

| Current source or inline setup | Shared destination | Required capability / what must stay real |
| --- | --- | --- |
| `tests/fakes/herdr.mjs` | same file, role profile | tab/label/list/wait/type/rename/close, exact argv and receipt loss |
| `tests/fakes/panel-herdr.mjs` | herdr panel profile | pane split/env, readiness, token registration, transient/unknown evidence, generation/reuse and late replies |
| `tests/fakes/pi-owned-herdr.mjs` | herdr owned profile | worker run/editor/Enter, real synthetic process ownership, helper split/cleanup, failure counts |
| Inline `PanelHerdr`/herdr ports in panel-control, role-facade and owned fixtures | in-memory adapter of that same state model | per-call barriers/deadline/failure scripts; one subprocess smoke still covers protocol serialization |
| `tests/fakes/pi-role.mjs` | `tests/fakes/pi.mjs` launcher profile | role/model/effort/args-json and exact session-header/ack effects |
| `tests/fakes/pi-dispatch.mjs` | pi dispatch profile | STATUS, QA/artifacts, same-key lost dispatch, continuation and bounded reaper |
| `tests/fakes/pi-owned-worker.mjs` | pi worker profile | managed helper contracts, private session and semantic STATUS writes |
| Inline API/context stand-ins in `pi-package.test.mjs` and `fixtures/pi-package-host.mjs` | pi package SDK-host profile | event wiring, UI sentinels, six tools, no provider, reload/tree/fork/shutdown; preserve the real emitted entry/loader invocation |
| `tests/fakes/pi-package.mjs` | retained real installed-package/loader discovery, not a fake protocol | keep actual package resolution and loader-presence checks; never replace with fake availability |
| `pi-owned-loader-worker.mjs`, `fixtures/pi-package-host.mjs` | retained real-loader/host adapter using shared scenarios | never replace the real loader/SDK step being qualified with fake acknowledgement |
| `pi-owned-release.mjs`, `pi-package-release.mjs` | shared immutable release seed, copied privately per corrupting case | prepare already-built bytes once; retain hash/relocation and real executable adapter proof |
| Every `inline_home=true` inventory row | `tests/fixtures/hud-home.ts` | private isolated env and cleanup; per-row homes remain distinct, no mutable singleton |
| P2/Workboard/ledger/run/CDP fixture constructors | helpers built on hud-home, keeping their domain semantics | real filesystem, SQLite, atomic inode/source pins and actual extracted DOM stay under test |

Migrate a fixture only with its consuming slice, not a giant cross-area rewrite. Keep thin
legacy adapters until all callers migrate; one state-machine implementation is the goal,
not one enormous permissive fake. Avoid supporting arbitrary shell evaluation. Unknown
commands/identities fail closed. No fake is allowed to invent real provider qualification.

Beyond C1–C10, 184 of the 192 temporary-root files are outside the selected cluster files
(the exact overlap is checked in `estimates.json`). Allow 4–10 removed setup lines each,
minus an approximately 180-line builder: **556–1,660 net lines** as a planning range.
This is a formula, not a promise to refactor all 184 in one slice; frozen consumers are
excluded from the actual authorized estimate below. Do not count deletion of out-of-scope
fake/fixture file lines as savings in the 138,126-line inventory denominator.

## 3c. Opt-in perf suite

Propose `test:perf` -> `npm run build && npm run build:test && npm run build:hud-mcp &&
node tests/run-perf.mjs`. The later dispatcher must use an explicit manifest of cases or
physically relocated nonfrozen perf files, serial execution, named host/Node/revision,
three repeated runs and declared sample/warmup/percentile settings. It must not include
native providers, real herdr or a shared browser by default. The runner and package script
are **not created at this stage**. `npm test` and merge commands must not call it.

Rows below are the proposed migration set. Whole-file rows move all listed cases; mixed
files extract only the specified case. Keep the five small correctness replacements
(two cold-write semantics, two R5 bound/history semantics, one WAL checkpoint contract).
Performance asserts keep their present thresholds; do not replace the failed P2 threshold
with a wider default bound. Existing WP0 perf files and scripts remain frozen overlaps;
list/run them only under their existing opt-in rules, not by moving or editing them.

| File:case line — exact source title | Reason | Historical cases / summed seconds |
| --- | --- | --- |
| `tests/unit/b10b-perf.test.ts:151` — 200-node compact rows at 56 columns, every row built from nothing: p99 <= 10 ms | projection/rows/alert performance and conflict-heavy scale | 1 / 8.250 |
| `tests/unit/b10b-perf.test.ts:175` — 200-node projection: cold build and a changed tick (one node differs) | projection/rows/alert performance and conflict-heavy scale | 1 / 2.705 |
| `tests/unit/b10b-perf.test.ts:194` — the no-change tick: same tree, the second moves on; p99 <= 2 ms | projection/rows/alert performance and conflict-heavy scale | 1 / 0.774 |
| `tests/unit/b10b-perf.test.ts:217` — the statusline from a warm projection, and the alerts alone | projection/rows/alert performance and conflict-heavy scale | 1 / 1.404 |
| `tests/unit/b10b-perf.test.ts:233` — the conflict-heavy boundary: 150 nodes and 400 conflicting children stay inside the 200-node budget | projection/rows/alert performance and conflict-heavy scale | 1 / 7.990 |
| `tests/unit/b10b-s2-perf.test.ts:192` — the no-change tick: the same view model, the second moves on; compact and rich p99 <= 2 ms | row painter latency; compact/rich no-change and changed ticks | 1 / 2.519 |
| `tests/unit/b10b-s2-perf.test.ts:211` — compact, 200 nodes at 56 columns, every row + frame-diff: a production-shaped changed tick, p99 <= 10 ms | row painter latency; compact/rich no-change and changed ticks | 1 / 47.836 |
| `tests/unit/b10b-s2-perf.test.ts:251` — rich, 200 nodes as cards at 56 columns (500-card cache, accordion to 60 rows), a production-shaped changed tick: p99 <= 15 ms | row painter latency; compact/rich no-change and changed ticks | 1 / 47.072 |
| `tests/unit/b10b-s3-perf.test.ts:175` — the no-change tick: same view model, a key press, the second moves on; compact and rich p99 <= 2 ms | selection+rows latency and printed cold/miss experiments | 1 / 6.392 |
| `tests/unit/b10b-s3-perf.test.ts:198` — compact, 200 nodes at 56 columns: reconcile + key press + every row + frame-diff, a changed tick, p99 <= 10 ms | selection+rows latency and printed cold/miss experiments | 1 / 29.243 |
| `tests/unit/b10b-s3-perf.test.ts:209` — rich, 200 nodes as cards at 56 columns: reconcile + key press + every row + frame-diff, a changed tick, p99 <= 15 ms | selection+rows latency and printed cold/miss experiments | 1 / 36.233 |
| `tests/unit/b10b-s3-perf.test.ts:220` — printed: the selection resolved from a miss (a hidden node every tick), and the cold tick | selection+rows latency and printed cold/miss experiments | 1 / 23.608 |
| `tests/unit/ledger-perf.test.ts:37` — ledger benchmark: 1000 small writes and read-only snapshots with 10000 runs | 1000-write / 10000-run benchmark | 1 / 0.001 |
| `tests/unit/b6-performance.test.ts:5` — B6 non-wait status/cancel p95 <50ms with four real SQLite writer processes | already opt-in historical process performance carrier | 1 / 0.001 |
| `tests/unit/pi-owned-orchestration.test.ts:792` — cost: cold fake launch n=20; launcher STATUS writes=0, unchanged journal reads=0 writes | cold fake/real-loader n=20 distributions; leave two one-sample semantic write checks | 1 / 44.575 |
| `tests/unit/pi-owned-orchestration.test.ts:1178` — cost: cold real pi loader worker start n=20 and semantic STATUS write count | cold fake/real-loader n=20 distributions; leave two one-sample semantic write checks | 1 / 54.468 |
| `tests/unit/work-card-p2.test.ts:960` — P2 measured quiet/change/large-history/scroll/resize rendering, three runs on named host | quiet/change/history/scroll/resize host timing; functional cache/viewport case remains | 1 / 1.403 |
| `tests/unit/r5-job-bounds.test.ts:20` — R5 5000 associations: per-refresh caps, bounded projection, fair cursor continuation, no durable deletion | 5000 associations and large closed history; leave small real cap/fairness/pruning correctness | 1 / 22.990 |
| `tests/unit/r5-job-bounds.test.ts:81` — R5 closed display history prunes to 50 / 30 days, preserving all disk records | 5000 associations and large closed history; leave small real cap/fairness/pruning correctness | 1 / 19.115 |
| `tests/unit/b12d-wal.test.ts:224` — B12D automatic checkpoint bounds declared short-reader load, long snapshot pins WAL, release permits reclamation | long-reader/checkpoint workload; leave small real automatic-checkpoint correctness | 1 / 18.315 |
| `tests/hud-mcp/handshake-benchmark.test.ts:28` — B45 synthetic whoami/report success refusal busy distributions with real SQLite writer contention | MCP handshake latency distribution | 0 / unmeasured |

### Every historical >5 s case: migration is by purpose, not elapsed time alone

| Historical case | Seconds | Disposition |
| --- | --- | --- |
| `tests/unit/pi-owned-orchestration.test.ts` — cost: cold real pi loader worker start n=20 and semantic STATUS write count | 54.468 | move perf; small correctness residue as above |
| `tests/unit/b10b-s2-perf.test.ts` — compact, 200 nodes at 56 columns, every row + frame-diff: a production-shaped changed tick, p99 <= 10 ms | 47.836 | move perf; small correctness residue as above |
| `tests/unit/b10b-s2-perf.test.ts` — rich, 200 nodes as cards at 56 columns (500-card cache, accordion to 60 rows), a production-shaped changed tick: p99 <= 15 ms | 47.072 | move perf; small correctness residue as above |
| `tests/unit/pi-owned-orchestration.test.ts` — cost: cold fake launch n=20; launcher STATUS writes=0, unchanged journal reads=0 writes | 44.575 | move perf; small correctness residue as above |
| `tests/unit/b10b-s3-perf.test.ts` — rich, 200 nodes as cards at 56 columns: reconcile + key press + every row + frame-diff, a changed tick, p99 <= 15 ms | 36.233 | move perf; small correctness residue as above |
| `tests/unit/b19-lifetime.test.ts` — B19 real hud-mcp timer: EOF/reparented parent with inherited pipe exits and subreaper reaps it | 30.306 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/b10b-s3-perf.test.ts` — compact, 200 nodes at 56 columns: reconcile + key press + every row + frame-diff, a changed tick, p99 <= 10 ms | 29.243 | move perf; small correctness residue as above |
| `tests/unit/b10b-s3-perf.test.ts` — printed: the selection resolved from a miss (a hidden node every tick), and the cold tick | 23.608 | move perf; small correctness residue as above |
| `tests/unit/r5-job-bounds.test.ts` — R5 5000 associations: per-refresh caps, bounded projection, fair cursor continuation, no durable deletion | 22.990 | move perf; small correctness residue as above |
| `tests/unit/r5-job-bounds.test.ts` — R5 closed display history prunes to 50 / 30 days, preserving all disk records | 19.115 | move perf; small correctness residue as above |
| `tests/unit/pi-owned-orchestration.test.ts` — ownership: stale SESSION ignored; reused tab/label, foreign pane/session and unknown inventory refuse mutation | 19.056 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/r5-fixture-clock.test.ts` — R5 panel evidence and restored summaries ignore wall time at fixture +400 days | 18.856 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/b12d-wal.test.ts` — B12D automatic checkpoint bounds declared short-reader load, long snapshot pins WAL, release permits reclamation | 18.315 | move perf; small correctness residue as above |
| `tests/unit/r5-fixture-clock.test.ts` — R5 panel evidence and restored summaries ignore wall time at fixture +2 days | 15.527 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/role-wait.test.ts` — HUD watchdog timeout is TIMEOUT, not a real wait failure | 15.062 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/statusline-native-details.test.ts` — both product bins reject invalid grammar before input and retain help/settings routing | 13.724 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — borrowed sonic child is cleaned before crash reviewer release | 13.651 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/statusline-native-details.test.ts` — both product bins preserve compact golden bytes and consume explicit details in either order | 11.634 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/jev-runtime.test.ts` — readJob waits longer than the default call deadline | 11.205 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/run-light-leader.test.ts` — fixture cleanup owns a group even when production startup rejects before returning it | 10.034 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/r5-job-observation.test.ts` — R5 reviewed Jev expiry demotes all pending rows while a multi-slice scheduler catches up | 9.768 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — helpers: invalid settlement and verdict fail; concurrent call is busy; abort cleans exact helper | 8.721 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/one-to-one-worker.test.ts` — real hud panel owns its publisher and releases its lease on exit | 8.691 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/panel-control.test.ts` — panel lifetime ends on main exit, replaced generation, terminal HUP/loss, lost identity and manual close | 8.686 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — stall: only specific error eligible; persisted message does nothing; complete editor sends exactly one Enter | 8.417 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — helpers: numbered reservations, fixed limits, one at a time, wrappers, exact closed STATUS/verdict | 8.404 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/b10b-perf.test.ts` — 200-node compact rows at 56 columns, every row built from nothing: p99 <= 10 ms | 8.250 | move perf; small correctness residue as above |
| `tests/unit/b10b-perf.test.ts` — the conflict-heavy boundary: 150 nodes and 400 conflicting children stay inside the 200-node budget | 7.990 | move perf; small correctness residue as above |
| `tests/unit/jev-aistudio.test.ts` — T18: pending saved target ownership survives idle shutdown | 7.794 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — helper own idle occupant may retire, but unchanged artifact and orphan reservation cannot succeed | 7.493 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/jev-aistudio.test.ts` — T20: pending saved target ownership survives hung_close shutdown | 7.289 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/panel-control.test.ts` — panel lifetime has one single-flight cadence, at most one herdr sample per 3s, deadline, and no restart | 6.700 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/statusline-native-details.test.ts` — actual product input bounds, UTF-8, JSON shape and stalled producer semantics remain unchanged | 6.531 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/b10b-s3-perf.test.ts` — the no-change tick: same view model, a key press, the second moves on; compact and rich p99 <= 2 ms | 6.392 | move perf; small correctness residue as above |
| `tests/unit/pi-owned-orchestration.test.ts` — real pi loader loader-failure fails before prompt | 6.376 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — unknown borrowed child cleanup retains outer reservation; both helper kinds refuse until explicit reap | 6.358 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — real pi loader real-model-mismatch fails before prompt | 6.316 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — real pi loader real-effort-mismatch fails before prompt | 6.310 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — owned crash matrix: lost enter reply after; same-key retry has zero duplicates | 6.224 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — borrowed sonic child is cleaned before failed reviewer release | 5.937 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/b18-budgets.test.ts` — B18 10001-run scope refuses without partial stdout; explicit smaller scope succeeds | 5.900 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — borrowed sonic child is cleaned before closed reviewer release | 5.882 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/jev-aistudio.test.ts` — T19: pending saved target ownership survives signal shutdown | 5.868 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/jev-oracle-boundary.test.ts` — T7/T8: runtime survives its client process-group exit, retains work and recovers an orphan only after lease takeover | 5.785 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/run-light-leader.test.ts` — physical parent MCP death with continue policy preserves the same lightweight run through final reconciliation | 5.666 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — nested sonic: helper reviewer borrows child reservation without job mutex or right-pane claim | 5.655 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/control-bar.test.ts` — every look fits the bar to the column, at every width, in both languages and with every icon set | 5.583 | keep frozen WP0 overlap |
| `tests/unit/run-control.test.ts` — real supervisor SIGKILL at cancel_before_ack_commit never resubmits or replays signals | 5.555 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — stall unknown session/editor/working evidence never sends Enter | 5.545 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — ownership: changed process start/boot/PID-domain never authorizes signal or close | 5.543 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/run-control.test.ts` — heartbeat wall/monotonic disagreement records one anomaly and stays uncertain | 5.111 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |
| `tests/unit/pi-owned-orchestration.test.ts` — nested sonic: primary reviewer splits down, read-only grant, shared numbering, closed pane | 5.025 | keep functional safety/lifecycle; cheapen setup/deadline driver, not the invariant |

`b19-lifetime`'s 30 s parent timer, real signal/reaper tests, Jev client-loss recovery and
hung-pipe deadlines are functional correctness, not cost experiments. Keep a real
production-cadence lifecycle proof; contract matrices may use injected clock/ports only
where they are not asserting physical signal/descriptor behaviour. `b18-budgets`' 10,001
export cutoff is also a fixed contract boundary: batch the synthetic SQLite seed, but do
not move its sole exact-boundary correctness assertion to optional perf. R5 fixture-clock
and Jev-expiry cases should use deterministic module fixtures without repeated CLI
launches. The ownership/claim refusal matrices are not disposable benchmark samples.

`tests/performance/{adaptive-scan,collect,correctness,runtime-probe}.mjs` and `terminal.py`
are WP0 overlaps and unchanged. The terminal driver and `hook-bench-real.mjs` remain
local/explicit profiles, never auto-run by the new default dispatcher. The six existing
hud-mcp mjs benchmark/trace tools are not default tests; `trace-stdio` is diagnostic support,
not another assertion suite. Preserve their opt-in semantics and environment isolation.

## 3d. Processes outside process/signal/lifecycle ownership

The static census below lists every file with process-call syntax, except process-owning
files and opt-in mutant/perf drivers. It is deliberately a **migration audit**, not an
assertion that each spawn is waste: generated-script strings and probe guards may also
match. Named nonprocess cases use the real handler/module and scripted port, not a fake
return standing in for parsing or authorization. Retain the one packaged-entry smoke and
any true descriptor/exec/lifecycle case in each mixed file. Do not stub real permission,
symlink, SQLite concurrency or DOM extraction boundaries. Frozen rows are overlap-only.

| File | Owning behaviour(s) | Cheaper layer / retained exception |
| --- | --- | --- |
| `tests/unit/b10a-data.test.ts` | C05, C26 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/b10b-s3-input-keys.test.ts` | P17, P18 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/b11-cli.test.ts` | H13, H14, H15, H16, H17, H18, H19, P30, P31, P34 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/b12-store.test.ts` | C10, C16 | contract for parser/cursor matrices; retain physical writer/WAL/concurrency/crash proofs |
| `tests/unit/b12d-wal.test.ts` | C10, C16 | contract for parser/cursor matrices; retain physical writer/WAL/concurrency/crash proofs |
| `tests/unit/b12r-store.test.ts` | C10, C16 | contract for parser/cursor matrices; retain physical writer/WAL/concurrency/crash proofs |
| `tests/unit/b16-writer.test.ts` | C06, C16 | contract for parser/cursor matrices; retain physical writer/WAL/concurrency/crash proofs |
| `tests/unit/b18-budgets.test.ts` | L03, L07 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/b18-export.test.ts` | L03, L07 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/b19-drainer.test.ts` | C05, C16 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/b19-merge.test.ts` | C05, C16 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/b20-cache-config.test.ts` | H07, C11 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/b3h-production.test.ts` | X09, L04 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/b6-server.test.ts` | L04, H06 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/b6-wait-status.test.ts` | L04, H06 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/b7-locator.test.ts` | X11 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/c45-jev-durable.test.ts` | J01, C25 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/claude-configuration.test.ts` | C20 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/claude-managed-launch.test.ts` | H12, H10 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/claude-plugin.test.mjs` | R06, R11 | contract real emitted extension with shared host API; retain one relocated package loader/activation smoke and true bridge transport lifecycle |
| `tests/unit/cloud-preview-build-order.test.mjs` | R02, R07 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/daemon-binding.test.ts` | C20, C21, C22 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/delegation-summary.test.ts` | C13 | contract real collection/projection with fixture clocks and fake transport; retain one E02 collected-and-painted scenario |
| `tests/unit/demo-r5-jobs.test.mjs` | C25, P01 | contract real collection/projection with fixture clocks and fake transport; retain one E02 collected-and-painted scenario |
| `tests/unit/digest-cli.test.ts` | C13 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/git-changes.test.ts` | C24, P14 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/git-status.test.ts` | C24, P14 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/hud-credentials.test.ts` | C09, C18 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/hud-env.test.ts` | R08 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/hud-launch-env.test.mjs` | R08 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/hud-link-export.test.ts` | L03, L07 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/hud-pi-integration.test.ts` | C22, H08 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/int-ledger-run.test.ts` | L01, L04, H05 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/jev-agent.test.ts` | J05 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/unit/jev-aistudio.test.ts` | J04, J13, J11 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/unit/jev-ask-config.test.ts` | J11, C09 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/unit/jev-ask-lease.test.ts` | J08, J17 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/unit/jev-decisions.test.ts` | J07, J15, J16 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/unit/jev-oracle-boundary.test.ts` | J02, J09 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/unit/jev-runtime.test.ts` | J01, J09, J18 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/unit/jev-setup.test.ts` | J11, C09 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/unit/job-materials.test.ts` | M01, M02, M03, M04, M05, M06 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/m2-claude-contract-simulation.test.ts` | H10, H12 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/managed-capability.test.ts` | H12 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/managed-core.test.ts` | H09, H10, H11 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/managed-runtime.test.ts` | H09, H10, H11 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/migration.test.ts` | R15 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/model-runtime.test.ts` | C14, C15, C29 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/one-to-one-worker.test.ts` | B04, X08 | contract shared herdr/pi ports for refusal and ordering matrices; retain owned-worker/reaper, publisher and X08 lifetime processes |
| `tests/unit/panel-control.test.ts` | X07, X08 | contract shared herdr/pi ports for refusal and ordering matrices; retain owned-worker/reaper, publisher and X08 lifetime processes |
| `tests/unit/panel-entry.test.ts` | X07, X08 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/pi-delegation-bridge.test.mjs` | H02, H03, H08 | contract real emitted extension with shared host API; retain one relocated package loader/activation smoke and true bridge transport lifecycle |
| `tests/unit/pi-delegation-channel.test.mjs` | H02, H03, H08 | contract real emitted extension with shared host API; retain one relocated package loader/activation smoke and true bridge transport lifecycle |
| `tests/unit/pi-delegation-context.test.mjs` | H02, H03, H08 | contract real emitted extension with shared host API; retain one relocated package loader/activation smoke and true bridge transport lifecycle |
| `tests/unit/pi-dispatch-conformance.test.ts` | F05, F06, F08, F09, F10 | contract real facade/CLI handler + scripted herdr/Jev boundary for schema/state/error matrix; retain one bin routing smoke and transport cancellation process |
| `tests/unit/pi-dispatch-facade.test.ts` | F05, F06, F08, F09, F10, F07 | contract real facade/CLI handler + scripted herdr/Jev boundary for schema/state/error matrix; retain one bin routing smoke and transport cancellation process |
| `tests/unit/pi-launch.test.ts` | C22, H08 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/pi-owned-orchestration.test.ts` | X01, X02, X03, X04, X05, X06, Q03 | contract shared herdr/pi ports for refusal and ordering matrices; retain owned-worker/reaper, publisher and X08 lifetime processes |
| `tests/unit/pi-owned.test.ts` | X01, X02, X03, X04, X05, X06 | contract shared herdr/pi ports for refusal and ordering matrices; retain owned-worker/reaper, publisher and X08 lifetime processes |
| `tests/unit/pi-package-role.test.mjs` | F02, R04 | contract real emitted extension with shared host API; retain one relocated package loader/activation smoke and true bridge transport lifecycle |
| `tests/unit/pi-role-bridge.test.mjs` | H08, X01 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/plugin-independence.test.mjs` | R04, R06 | contract real emitted extension with shared host API; retain one relocated package loader/activation smoke and true bridge transport lifecycle |
| `tests/unit/prefix-keys.test.ts` | P13, P18 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/product-cli-routing.test.ts` | R17, R16, R08, B02 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/r5-external-association.test.ts` | C25 | contract real collection/projection with fixture clocks and fake transport; retain one E02 collected-and-painted scenario |
| `tests/unit/r5-job-observation.test.ts` | C25 | contract real collection/projection with fixture clocks and fake transport; retain one E02 collected-and-painted scenario |
| `tests/unit/r5-panel.test.ts` | P01, P07, P08 | contract real collection/projection with fixture clocks and fake transport; retain one E02 collected-and-painted scenario |
| `tests/unit/role-entry.test.mjs` | F02 | contract real facade/CLI handler + scripted herdr/Jev boundary for schema/state/error matrix; retain one bin routing smoke and transport cancellation process |
| `tests/unit/role-facade.test.ts` | F01, F02, F03, F04, F05, F07, F12, F13, E01 | contract real facade/CLI handler + scripted herdr/Jev boundary for schema/state/error matrix; retain one bin routing smoke and transport cancellation process |
| `tests/unit/role-summary.test.ts` | B03, B04, E02 | contract real facade/CLI handler + scripted herdr/Jev boundary for schema/state/error matrix; retain one bin routing smoke and transport cancellation process |
| `tests/unit/role-wait.test.ts` | F11 | contract real facade/CLI handler + scripted herdr/Jev boundary for schema/state/error matrix; retain one bin routing smoke and transport cancellation process |
| `tests/unit/roster.test.ts` | F02 | contract real facade/CLI handler + scripted herdr/Jev boundary for schema/state/error matrix; retain one bin routing smoke and transport cancellation process |
| `tests/unit/run-artifacts.test.ts` | L08 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/run-visible-policy.test.ts` | H12 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/unit/runtime-activation-recovery.test.mjs` | R01, R09 | contract real private closure/manifest/activation APIs for validation/corruption; retain R03 shim exec/PID/signal/builder-child proofs |
| `tests/unit/runtime-activation.test.mjs` | R01, R09 | contract real private closure/manifest/activation APIs for validation/corruption; retain R03 shim exec/PID/signal/builder-child proofs |
| `tests/unit/runtime-compose.test.mjs` | R02, R10 | contract real private closure/manifest/activation APIs for validation/corruption; retain R03 shim exec/PID/signal/builder-child proofs |
| `tests/unit/runtime-install.test.mjs` | R01, R09, R03, R13, R14 | contract real private closure/manifest/activation APIs for validation/corruption; retain R03 shim exec/PID/signal/builder-child proofs |
| `tests/unit/runtime-package.test.mjs` | R02, R10 | contract real private closure/manifest/activation APIs for validation/corruption; retain R03 shim exec/PID/signal/builder-child proofs |
| `tests/unit/runtime-release.test.mjs` | R02, R10 | contract real private closure/manifest/activation APIs for validation/corruption; retain R03 shim exec/PID/signal/builder-child proofs |
| `tests/unit/statusline-native-details.test.ts` | B02, B06 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/statusline-observer.test.mjs` | B02, B06 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/statusline-preview.test.ts` | B02, B06 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/statusline-settings.test.ts` | R16 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/statusline-summary.test.ts` | B03, C16 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/unit/test-wsl-codex-origin.mjs` | C21, R08 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/workbench-live.test.ts` | P27 | keep WP0/visual frozen; no authorized conversion |
| `tests/unit/workboard.test.ts` | P09, P10, C05 | contract real collection/projection with fixture clocks and fake transport; retain one E02 collected-and-painted scenario |
| `tests/hud-mcp/b20-advice.test.ts` | H07, C11 | contract real command/reader + captured streams/env for grammar/JSON/config/preflight; retain executable dispatch/stdio failure and exact argv smoke |
| `tests/hud-mcp/hook-source.test.ts` | H03 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/hud-mcp/host-entry.test.ts` | H09, H10, H11, H12 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/hud-mcp/int-ledger-registry.test.ts` | H05, L09 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/hud-mcp/jev-tools.test.ts` | H04 | contract fake CDP/record/clock ports for prepare/reply/deadline matrices; retain lease contention, CDP socket truncation and runtime/client-loss process proofs |
| `tests/hud-mcp/managed-runtime.test.ts` | H09, H10, H11, H12 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/hud-mcp/native-source-without-ledger.test.ts` | H03, H08 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/hud-mcp/pi-source-root.test.ts` | H03 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |
| `tests/hud-mcp/skeleton.test.ts` | H01, H06, H07 | contract real imported boundary for validation/projection/refusal; inspect and retain only exec/transport/lifecycle integration rows |

Priority named examples: roster help/invalid HOME (401/424) -> actual CLI handler;
hud-link-export grammar/refusal/byte producer checks -> real exporter/handler, retaining
one actual launcher read-only smoke and EPIPE; statusline grammar/golden population
matrices -> actual input parser/renderer, retaining bounded stdin/EPIPE/timeout processes;
job-materials' subprocess helper/probe setup -> shared fixture, never bypass material
authorization; pi-owned ownership/mismatch/refusal rows -> scripted herdr port, retaining
the real loader-startup row and stamped SIGTERM/reaper cases. No time is credited to
these conversions until their real replacement path and unique coverage are established.

## 3e. Mutation drivers

| Driver | Current variants | Proposed disposition |
| --- | --- | --- |
| `claude-plugin-mutants.mjs` | prefix-wildcard, parent-env-leak, hook-json-eligibility, old-end-new-generation, manifest-statusline, missing-provider-control-proof | keep all 6 as opt-in negative controls: exact grammar, child-only env, authority, generation and unsupported manifest/provider paths are key guards. They reuse the real plugin suite; do not add separate unit copies. |
| `panel-control-mutants.mjs` | create-before-intent, blind-recreate, old-generation-end, inherited-pane-eligibility, unvalidated-session, positive-get-as-absence, skip-token-registration | keep all 7. These demonstrate that weakened ordering/authority/unknown-state guards are actually detected. |
| `pi-package-mutants.mjs` | stale-result-adoption, tree-without-live-proof, tree-ignores-auto-off, footer-ownership, all-status-cleanup, wrong-root-cache, non-tui-timer, unfenced-panel-close, model-routed-command | keep all 9; package lifecycle and other-extension UI ownership are real integration boundaries. |
| `role-summary-mutants.mjs` | expired-is-current, unavailable-is-zero, publish-in-paint, broad-cli-before-dispatch, lifetime-kills-pane, old-generation-close | keep first 5; delete only exact duplicate old-generation-close variant (C12), owned by panel-control's old-generation-end. |

A mutation killed by a unit test is intentionally coupled negative-control evidence, not
an independent duplicate assertion case. Keep these opt-in, run after affected slices,
and require the unmutated targeted test to pass first. A timeout/import/fixture failure
is inconclusive, never KILLED. Current drivers mostly check assertion failures, but the
later shared runner must additionally prove selected-test execution/no all-skipped run.
Never mutate working source/dist or hard-linked dependencies; use private emitted copies.

## 3f. Estimated result (not an achieved benchmark)

| Quantity | Before | Proposed estimate and basis |
| --- | --- | --- |
| Scoped test lines | 138,126 | **135,417–136,993**; C1–C10 + 126 nonfrozen/nonoverlapping home consumers, perf measurement helper net 160, duplicate mutation 9, and 140–220 replacement lines. Moving perf does not itself reduce total lines. |
| Default-suite lines | 136,315 | **132,508–134,084**; same setup folds plus 1,267 relocated perf lines; includes current MCP and mjs. |
| Compiled unit cases | 4,493 historical expanded | **4,478** if named rows preserve original identity: remove 20 perf cases, add 5 small correctness replacements. Table folds remove no logical cases. Future added subtest names may increase reporter count without increasing behaviour. |
| Direct mjs / MCP cases | **980 measured: 761 mjs + 219 MCP** | **979** after moving one MCP handshake benchmark; all other logical cases retained. Combined default forecast is **5,457 = 4,478 + 979**, before any extra named table subdivisions. |
| Opt-in mutations | 28 variants | **27**, exact duplicate guard variant only. No mutation runtime estimate. |
| Unit summed test time | 1,332.547 s | **957.655 s + small correctness replacements**, by historical perf subtraction only. This is not a wall-time prediction. |
| Default compiled-unit wall | 350.680 s historical | **230–320 s planning range**, not measured or an acceptance target. Old pi-owned file alone retains about 219.4 s of summed work after its two cost cases leave; this limits credible speedup until port/setup migration is measured. Re-measure quiet-host three-run range after each slice. |

The static evidence supports a modest line reduction, not an invented 30–50% cut. A larger
cut requires proving more cases equivalent (including unique branch evidence) or changing
supported compatibility scope, which this stage does not authorize. Counts are signals,
not limits. No claimed saving assumes deleting unique permission, lifecycle or consent
regressions, muting assertions, changing thresholds, or editing WP0/visual-frozen files.

## 3g. Execution slices, ownership and order

Every later slice starts from the accepted map, refreshes inventory hashes after in-flight
merges and owns a disjoint file set below. A file's functional and perf edits occur in the
**same slice**, not simultaneous functional and perf branches. Shared-library consumers
can migrate only after the shared foundation merges. The testing map/script registry has
one final integration writer, never per-slice competing edits.

| Order / slice | Exclusive writes | Notes / in-flight conflicts |
| --- | --- | --- |
| 0 — approval/evidence | external coverage artifacts, approved `docs/testing.md` | orchestrator chooses folds and compatibility scope; baseline only in quiet window. No product-code/contract changes. |
| 1 — shared foundation | new hud-home fixture, shared herdr/pi scenario modules and thin existing fake adapters | no consuming test edits yet; fixture protocol compatibility only. Conflicts PIROLE-PR4 fake herdr/pi-owned fixtures: wait and rebase by orchestrator. Do not edit frozen imported fixture bytes to evade WP0. |
| 2 — materials | `job-materials.test.ts` and its nonfrozen domain fixture only | C4 and M01–M06; leave shared model/WP0 tests unchanged. No known direct P3B/PR4 overlap; refresh merge diff first. |
| 3 — roles/roster | `role-facade.test.ts`, `roster.test.ts`, `role-wait.test.ts`, `pi-dispatch-{facade,status,conformance,wake}.test.ts` | C5/C6; migrate port adapters. PIROLE-PR4 may touch dispatch/helper contracts; serialize if actual diff intersects. No source semantics change. |
| 4 — owned execution | `pi-owned*.test.ts`, `run-light-leader.test.ts`, nonfrozen run-process/control/resource files and owned/run fixtures; extracts their own perf cases | C7/C9 and cost split. **Direct PIROLE-PR4 conflict:** wait for its final landed files; do not work from stale helper/owned session assumptions. No real provider calls. |
| 5 — panel/Work | `work-card-p2*.test.ts` except frozen frames, `workboard*.test.ts` except frozen frames, `panel-control.test.ts`, nonfrozen R5 job/clock fixtures/tests and role-summary; its mutant drivers | C1–C3/C8 and Q01/Q02, own panel/role-summary mutations. **Direct R5UX-P3B conflict** in work-card/workboard/role-summary display/cost paths; defer until merged. A5 is already in base, not an in-flight blocker. |
| 6 — release/package | `runtime-*.test.mjs`, `pi-package*.test.mjs`, `claude-plugin.test.mjs`, package/Claude mutant drivers and their release fixtures | C10; preserve real loader and R03 exec/lifetime proofs. No known direct in-flight conflict; shared pi fixture must already be stable. |
| 7 — Jev and legacy compatibility | nonfrozen `jev-*.test.ts/mjs`, nonfrozen `b12d-wal`, `ledger-perf`, `b6-performance`, `tests/hud-mcp/handshake-benchmark.test.ts` and other nonfrozen ledger/MCP tests | keep real lease/socket/client-loss owners. Extract only approved Q05 workloads, keep compatibility and boundaries default. No blanket retirement-policy deletion. |
| 8 — remaining nonfrozen consumers | exact inventory nonfrozen paths not assigned 2–7 | home/port migration only; no edits to frozen monitor/settings/visual/WP0 tests. Enumerate the final file list before dispatch; do not treat this as an open-ended refactor. |
| 9 — perf registry and map integration | `package.json`, new `tests/run-perf.mjs`, perf-only paths emitted by their owning slices, documentation | single writer assembles manifest, excludes perf from default glob/gate and integrates map/inventory updates. Coordinate any pending P3B/PR4 package.json changes. |

The duplicate mutation variant belongs only to slice5; panel-control's retained variant
and role-summary driver move together. Each domain slice migrates only its own fixtures;
if a fixture is shared with another slice, foundation owns it or that fixture is explicitly
assigned to one predecessor, never both. Scope/frozen changes go back to the orchestrator,
not into a stealth extra slice.

## 3h. Coverage safety net and its cost

**Current baseline status: completed once under QA q4's quiet window.**
**1 known timing failure; isolated rerun waived by the orchestrator (QA q5).**
The window is now closed; no further build/test/measurement is authorized.
The marker-guarded prepared script used only Node's built-in
`--experimental-test-coverage` with spec + **lcov** reporters; no dependency installation.
It built once, then sequentially instrumented compiled unit, direct mjs and hud-mcp.
`HOME`, `HUD_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` are fresh private directories;
all `HERDR_*`, Node injection flags and listed live-provider opt-ins are unset. It does
not run real herdr/tmux probes, shared browser/provider tests or mutation drivers.

The sole baseline driver was launched in the background with this command while the marker existed (do not rerun):

```sh
mkdir -p <repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/checks
nohup sh -c 'python3 <repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/coverage-baseline.py; r=$?; echo exit=$r' \
  > <repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/checks/coverage-driver.log 2>&1 &
```

Its `coverage-baseline/metadata.json` records exact argv, revision/Node, isolation root,
per-command wall/exit, aggregate wall and peak child RSS KiB (`RUSAGE_CHILDREN`, Linux
high-water resident memory of a waited child, **not summed simultaneous tree RSS**).
`complete.json` is completion evidence, not success: any nonzero test exit invalidates a
clean baseline. A build failure aborts; test failures are retained and all three suite
results recorded. Do not overwrite/rerun a failed baseline without fresh authorization.
If baseline remains pending at static completion, report that and ask the orchestrator
again, rather than silently waiting or claiming coverage success.

### Recorded baseline results (not a clean passing gate)

| Step | Wall seconds | Actual result |
| --- | --- | --- |
| `npm run build` | 8.818 | exit0 |
| `npm run build:test` | 15.744 | exit0 |
| `npm run build:hud-mcp` | 5.699 | exit0 |
| instrumented compiled unit | 398.466 | 4,493 tests: 4,466 pass / **1 fail** / 26 skip; exit1 |
| instrumented direct mjs | 368.099 | 761 tests: 759 pass / 0 fail / 2 skip; exit0 |
| instrumented hud-mcp | 4.287 | 219 tests: 218 pass / 0 fail / 1 skip; exit0 |
| Whole baseline | **801.123 s (13m21s)** | driver exit1, all three lcov outputs retained |

Peak waited-child resident memory: **1,212,828 KiB = 1,184.4 MiB (~1.16 GiB)**,
Linux RUSAGE_CHILDREN high-water, not simultaneous process-tree total. The P2 failure
is `P2 measured quiet/change/large-history/scroll/resize rendering, three runs on named host`,
`dist-test/tests/unit/work-card-p2.test.js:822`: **quiet p95 4.329968 ms > 2 ms**.
The attempted isolated-rerun driver refused before launching a test because the marker
had already been renamed `quiet-window.closed-0547.md`. QA q5 intentionally closed it
for P3B's next benchmark and waived the rerun. Do not claim that test passed or rerun it.
This is coverage evidence with an explicit timing-only exception decision outstanding
for use as a clean future no-loss reference, not a green performance/merge baseline.

Per-file coverage: `coverage-summary.json` and readable `coverage-summary.md` contain
**1,831 raw SF records across the three suites, grouped under 493 product source owners**.
Every inventory record has `coverage_baseline`: suite result, wall/RSS, test-file emitted
coverage where reported, direct product-import suite-union summaries and the full artifact
reference. `baseline-cases.json` reconciles **all 5,473 results** to their 385 default files,
with zero unmatched cases; original historical timings remain separate.

The summary retains emitted paths, hashes, DA/BRDA/function hit/found counts and source-map
ownership. It does **not** mislabel generated line counts as TypeScript source coverage,
merge incompatible output trees, or pretend suite-union coverage belongs uniquely to one
test. Actual entries such as `bin/hud` demonstrate some child coverage; deleted private
emitted copies and missing child-only paths still require explicit attribution. Raw lcov
and the per-file coordinate basis are the authority. No aggregate percentage is a deletion
license. The later no-loss diff must close these mapping/child gaps for its own candidates.

For a later slice:

1. Save the accepted full baseline, all raw lcov, source-map/emitted-byte hashes, Node and
   source revision, counts/pass/skip and child exit evidence. Record unavailable optional
   loader/platform branches; an all-skipped row cannot substitute for a passing proof.
2. Before editing, run **only the candidate removed/folded cases plus their owner/retained
   integration tests** with identical built-in reporters into `slice-before.lcov`; keep
   per-test lcov when determining which case uniquely owns coverage. After editing run
   replacement named rows/retained tests into `slice-after.lcov`. Example compiled path:
   `node --experimental-test-coverage --test-reporter=spec --test-reporter=lcov
   --test-reporter-destination=before.log --test-reporter-destination=before.lcov --test
   --test-name-pattern='<escaped exact candidate/owner names>' dist-test/tests/unit/<file>.test.js`.
   Use the original source mjs or MCP emitted paths for those suites. Verify selected case
   counts, and shell-quote patterns; accidental skipped selections fail the check.
3. Restrict the no-loss comparison to product `src/**`, `packages/hud-mcp/src/**`, runtime
   scripts/entrypoints, not tests/fixtures/dependencies. **Do not merge raw emitted line
   numbers by stripping prefixes.** Current builds emit source maps. Canonicalize SF and
   DA/BRDA through each `.js.map` to its source path/location; preserve raw emitted
   identities too. Across `dist`, `dist-test` and MCP `dist`, matching source path/content
   hashes permit union. For unchanged emitted bytes compare exact branch identities
   `(canonical source, raw generated block/branch, source location)`. Missing mapping or
   changed generated branch numbering requires manual mapping/review, never auto-pass.
4. Compute covered-source-line set `DA count>0` and covered-branch set `BRDA taken>0`.
   `lost_lines = before - after`, `lost_branches = before - after` must both be empty.
   To attribute unique coverage, compare candidate per-test sets against retained-test
   union. Print each lost source location, candidate, owner and raw emitted identity.
   Then compare the refreshed **full suite union** against the accepted full baseline;
   do not allow another test's incidental setup to conceal a missing observable assertion.
5. For each loss: extend the owning test through the real path and rerun, or obtain a
   specific orchestrator-approved dead/display-only exception naming source/range,
   reason, assertions and evidence. No percentage-only acceptance. Coverage is necessary,
   not sufficient: reviewer also checks assertion strength, refusal/effect invariants,
   named table rows, mutation kills and frozen WP0/visual byte equality.
6. Per-test real subprocess product execution may not be included in a parent's lcov.
   Inventory child coverage separately using a private per-run `NODE_V8_COVERAGE` raw
   directory when authorized, or instrument that child entry with built-in coverage and
   lcov. Missing child data is a **coverage gap**, not evidence a process case is redundant.
   Do not inherit this into installed/user processes or silently call the baseline complete
   for unobserved child-only source. The initial prepared parent-suite baseline is the
   starting point; slices needing child-only proof must close that explicit gap.

Cost: one full build+instrumented union baseline; historical uninstrumented compiled unit
alone was 350.680 s, excluding mjs/MCP/build. The initial **10–25 min / 1–4 GiB**
planning allowance is now superseded for this host/run by **13m21s / ~1.16 GiB** above; stop and obtain a new window if the
host/window cannot support it. Instrumentation, per-test isolation and real children may
cost more. A domain slice pays two focused before/after instrumented runs plus its final
full comparison; per-test isolation adds the sum of selected-case startup/setup costs,
so cache immutable build bytes, never cache mutable authority state. Repeat full baselines
only at agreed serial integration points; the orchestrator controls the window and gate.

## Decision requested

Approve the map and conservative fold/setup/perf slices, or identify additional cases
whose unique assertions may be dropped. Explicitly retain the frozen-file boundary and
compatibility behaviour. No proposed deletion is justified solely by size, duration,
common title words, or unchanged aggregate coverage percentage.
