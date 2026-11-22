# C3 actual merged-tree verification: fresh Oracle ruling

Date: 2026-11-04 UTC  
Evidence commit: `5037c7979d3075c23e965910d973addac8483d67`  
Run: `wave1-merged-tree-20261104T114728Z-1912659`

## Verdict

**ACCEPT the prescribed actual merged-tree README gate for the exact tree and parents below, applying the repository’s existing once-alone known-flake rule.**

This is **not** an unqualified three-profile first-pass green:

- 29 of 30 required commands exited 0.
- Node 24 `npm test` genuinely exited 1.
- Its sole failure matches the README-listed `b6-wait-status` “idle wait zero writes” condition.
- One isolated rerun of that unchanged suite exited 0, with 15/15 passing.
- The mjs stage omitted by the failed aggregate was separately executed and passed 47/47.
- The original aggregate remains **FAIL / exit 1**. Neither supplementary command changes that historical result.

This fresh ruling supplies the failure disposition required by the [joint C3 ACCEPT](https://github.com/CartmanFatass/codex-hud/blob/09d9c3d95fe42932ecaf35dd46806a8747681aa7/docs/cloud/handoff/wave1-compat-integration/oracle-c3-owner-exception-joint-acceptance-20261104.md). The sole merger may continue the existing guarded integration workflow, subject to the exact-identity and publication constraints below. This review performed no integration, ref update, repository modification or test execution.

## 1. Exact tested identity and independent composition audit

| Role | Identity |
|---|---|
| Common base U | `f248f320d42528fd1eb97db9f1cd2ba97e6d3c86` |
| Target T | `9dd4d06d2ee5ebb022719d11b74d6de0276172a4` |
| Source documentary head H | `09d9c3d95fe42932ecaf35dd46806a8747681aa7` |
| Accepted source candidate C3 | `36d3fd584bd403ed7ada95d1d863a8f63e96588b` |
| Actual merge-result tree R | `48f59142862f643a98286e3d196d23ff13059a23` |
| Local test merge commit M | `9112e87b1af9c321ca87facdfc56994cf493438f` |
| Ordered M parents | `[T, H]` |

I freshly retrieved complete, non-truncated remote inventories for U, T, H, C3, the previously reviewed target and all three owner source commits. Independently applying the connector addendum’s conservative three-way rule established:

- U/T/H have 1,327 / 1,339 / 1,377 leaf entries.
- The predicted result has 1,389 entries and zero conflicting paths.
- Its complete inventory equals the published R inventory.
- Independently hashing the Git tree representation yields exactly R.
- All 26 authorized implementation/test/source-document entries equal their pinned owner blobs, modes and types.
- Every other non-`docs/` entry equals U.
- T→R has 65 changed paths: 26 authorized source entries and 39 documentary entries, with no deletion or mode/type change.
- C3→H consists of seven added integration records only.
- The previously reviewed target→T adds only `leg1-owner-direction-20261104.md`.
- Fresh compare metadata confirms U as the T/H merge base and C3 as an ancestor of H.

All 36 command records retain M, R, ordered parents `[T,H]`, and the same before/after tracked-source digest:

`1d31999efe228e84e74c4cdd64c4d99dbf738a98632f2206b030c6c5edb1bc39`

At approximately **12:10 UTC**, the remote target and source refs still equaled T and H.

The local M identity is supported by the published commit/identity and per-command records. M was not remotely published. Its commit-object copy has redacted author fields, so it cannot independently reproduce M’s original commit hash; that limitation does not affect the independently recomputed R tree hash.

Sources: [tree verification](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/manifest/tree-verification.json), [complete R inventory](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/manifest/R-inventory.tsv), [connector addendum](https://github.com/CartmanFatass/codex-hud/blob/09d9c3d95fe42932ecaf35dd46806a8747681aa7/docs/cloud/rulings/wave1-compat-integration-connector-addendum-20261104.md).

## 2. Complete publication integrity audit

I retrieved and independently rehashed **all 1,406 published files**, representing **733 unique Git blobs and 7,527,999 bytes**.

Results:

- Every computed Git blob SHA and byte length matches the immutable remote inventory.
- All **1,405** `PUBLISHED-SHA256SUMS` entries match.
- No duplicate, missing or extra manifest entry exists. The manifest correctly excludes itself.
- All 36 individual result records reconcile with SUMMARY, including commands, times, limits, exits, signals, anomalies and lifecycle fields.
- Independently parsed raw stage summaries match SUMMARY’s stage-own counts, including its exclusion of the nested Node 24 child-summary block.
- All **72 stdout/stderr streams** were examined for integrity.

Verified SHA-256 identities:

| File | SHA-256 |
|---|---|
| PUBLISHED-SHA256SUMS | `cbf9f3c0f9be29abcf70bd6cd2218d3fe9960e0f788640fbd37118405a8d54f5` |
| REPORT.md | `a997c0a9841fc17daa6df71155cd16aaf90f6993187c985bc341443b15388cdf` |
| SUMMARY.json | `20ae6fb8ba12f9d437aafae0422a72a39772cec414ce71f6e1035a45c82db8e7` |

The command records retain **original local stream hashes**, while the publication manifest hashes sanitized copies. Exactly four published streams differ from their recorded original hash/length: the three `test:core` stdout files and Node 24 `npm test` stdout. All four are explicitly listed as redacted. The other 68 match their original recorded hashes and lengths. There is **no unexplained stream checksum discrepancy**.

This verifies complete published-byte integrity, not the private originals or the private transformation mapping.

Sources: [manifest](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/PUBLISHED-SHA256SUMS), [redaction record](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/redaction-manifest.json).

## 3. Profiles, dependencies and generated output

The command metadata records:

| Profile | Runtime | npm | Proxy activation |
|---|---|---|---|
| node22-envproxy | Node 22.23.4 | 10.9.9 | `NODE_USE_ENV_PROXY=1` |
| node22-noenvproxy-control | Same Node 22.23.4 binary | 10.9.9 | Variable absent, not `0` |
| node24-envproxy | Node 24.22.1 | 11.19.1 | `NODE_USE_ENV_PROXY=1` |

Node binary hashes:

- Node 22: `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`
- Node 24: `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`

The runner constructs a restricted environment. The same proxy policy is retained; values are not published. Warning-suppression variables, `NODE_OPTIONS`, `NO_COLOR` and `FORCE_COLOR` are absent. The expected Node 22 enabled-profile startup warnings remain in separate stderr.

There are **108 distinct recorded fresh HOME/HUD_HOME/TMPDIR paths** across 36 commands. All three worktrees record absent generated directories before their first build.

The six dependency manifests are identical, each covering 334 files:

`861f57957168c696805b093a6a944c14cb90e65541a1c5d3ef6d9d53d6de5518`

The six generated-output manifests are identical, each covering 2,327 files:

`4e076ab5038c93ce7a95d9fc319ad382a40ca056527c2c47d085c76ce34294f8`

These are verified manifest bytes and consistent recorded checkpoints, not an independent execution or direct inspection of the owner’s binaries and generated directories.

## 4. Every command exit

Required rows, reporting **actual exits**, not adjusted results:

| Command | Node 22 enabled | Node 22 control | Node 24 enabled |
|---|---:|---:|---:|
| `npm run build` | 0 | 0 | 0 |
| `npm run build:test` | 0 | 0 | 0 |
| `npm run build:hud-mcp` | 0 | 0 | 0 |
| `npm test` | 0 | 0 | **1** |
| `npm run test:core` | 0 | 0 | 0 |
| `npm run test:visual` | 0 | 0 | 0 |
| `npm run test:hud-mcp` | 0 | 0 | 0 |
| `npm run format:check` | 0 | 0 | 0 |
| `npm run check:fixtures` | 0 | 0 | 0 |
| `git diff --check` | 0 | 0 | 0 |

Additional recorded commands:

- `npm ci --ignore-scripts`: exit 0 on all three profiles.
- Node 22 enabled runner self-check: exit 0.
- Node 24 supplemental `npm run test:mjs`: exit 0.
- Node 24 isolated `node --test dist-test/tests/unit/b6-wait-status.test.js`: exit 0.

Thus **35 of 36 recorded commands exited 0**. The runner labels are 34 PASS, one FAIL and one UNKNOWN. UNKNOWN is the disclosed initial Node 22 dependency-preparation bookkeeping anomaly, discussed below.

Raw test totals:

- Both Node 22 `npm test` runs: 2,457 tests, 2,441 pass, zero fail, 16 skipped. Unit: 2,394 pass plus 16 skips; mjs: 47 pass.
- Node 24 original aggregate: 2,410 unit tests, 2,393 pass, one fail, 16 skips. Its mjs stage did not execute.
- Core, every profile: 210 tests, 209 pass, one skip.
- Visual, every profile: 319/319 pass.
- HUD-MCP, every profile: 108 tests, 107 pass, one skip.
- Node 24 mjs supplemental: 47/47 pass.
- Node 24 isolated B6 suite: 15/15 pass.
- No cancellations were reported. Existing skips remain skips.

All commands stayed within their declared limits. The required limits match the prescribed matrix: builds 600 seconds each; aggregate 1,800; core and HUD-MCP 900; visual 600; format/fixtures 300; diff 60. Supplemental mjs used 600 and the isolated rerun declared 300 seconds.

Source: [complete SUMMARY](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/SUMMARY.json).

## 5. Node 24 failure disposition

The original aggregate’s only failing test is:

`B6 idle wait has zero writes, no polling, and timeout leaves empty cursor/state unchanged`

The assertion is `4 !== 3`. In the unchanged source, this is the **readSnapshot call-count assertion**, not proof that four writes occurred. Subsequent assertions in that failing test cannot be credited as reached.

The basis for the known-flake disposition is specific:

1. The binding [README, lines 82–93](https://github.com/CartmanFatass/codex-hud/blob/09d9c3d95fe42932ecaf35dd46806a8747681aa7/docs/cloud/README.md#L82-L93) already names this exact B6 idle-wait condition and permits one suite rerun alone.
2. The B6 test blob is unchanged from U through the merged source. Its assertion was not weakened.
3. The aggregate finished normally with exit 1, not timeout, signal, missing output or uncertain closeout.
4. The complete 15-test B6 file was rerun once, without a name filter or changed expectations, on the same M/R and Node 24 enabled profile.
5. That rerun passed all 15 tests, with clean closeout.
6. Both runs remain recorded.
7. The omitted mjs stage was separately completed under the integration ruling’s existing supplemental-stage provision.

Therefore the existing policy permits **acceptance with a recorded known-flake rerun**. This does not establish the precise scheduling cause of the first failure or warrant deleting it. No second B6 rerun or duplicate aggregate is required merely to replace the red historical row.

Sources: [original failure](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/logs/node24-envproxy/04-npm-test/stdout.raw#L2529-L2557), [isolated rerun](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/logs/node24-envproxy/04r1-b6-wait-status-alone/stdout.raw), [supplemental mjs](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/logs/node24-envproxy/04b-test-mjs-supplemental/stdout.raw), [unchanged assertion](https://github.com/CartmanFatass/codex-hud/blob/09d9c3d95fe42932ecaf35dd46806a8747681aa7/tests/unit/b6-wait-status.test.ts#L172-L207).

## 6. Lifecycle and runner qualifications

Every command record shows:

- Direct-child native wait result, with no shell/timeout wrapper between the runner and tested command.
- No native termination signal.
- No timeout and no supervisor signal sent.
- Separate stdout/stderr reaching EOF.
- Successful logging with no recorded stream error.
- No surviving recorded identity, residual zombie or D-state entry at closeout.

All **964 recorded process-identity entries** are marked gone at final census. Grandchild native wait statuses were not observed and are not inferred from census disappearance.

### Non-blocking reporting correction

`REPORT.md:68` describes the census too broadly as 1 Hz and its escape limitation too narrowly as “within under a second.”

The [runner](https://github.com/CartmanFatass/codex-hud/blob/5037c7979d3075c23e965910d973addac8483d67/docs/cloud/handoff/local-verification/20261103/wave1-merged-tree-20261104T114728Z-1912659/scripts/w1m.py#L171-L180) checks ancestry/session/process-group approximately once per second, but HOME-token discovery occurs **every fifth scan**, plus explicit scans. A process that detaches before discovery and clears its identifying environment between token scans can also escape observation.

**P3, reporting scope:** retain “all recorded identities gone”; do not elevate it to exhaustive descendant detection or native wait/reap proof. This additive ruling supplies the correction without rewriting the immutable report. No observed leftover or lifecycle failure is identified, and this qualification does not block the bounded gate.

### Initial preparation anomaly

The first Node 22 `npm ci` result remains UNKNOWN, with `source_unchanged=false`. Its recorded failure was the porcelain leading-space parsing bug: ` M node_modules/.package-lock.json` was misclassified after stripping.

The unchanged source digest, exact M/R/parents, dependency-only path, subsequent clean checkpoints and identical dependency manifests substantiate a bookkeeping false positive rather than source drift. The preparation exited 0 and closed cleanly. The subsequent source-check implementation preserves porcelain spacing.

The earlier runner version is not separately preserved; this is a disclosed provenance limitation. Do not relabel the original UNKNOWN record PASS. It does not invalidate the separately recorded required rows.

## 7. Focused coverage and historical limits

This round did **not** repeat the separate scheduling-specific focused matrix, benchmark series, ancestor exercise or historical mutation archive.

That is not a new omission from this actual merged-tree README gate: the prior joint ACCEPT already credits the completed C3 focused coverage and bounded benchmark evidence, and its required integration sequence calls for the complete three-profile README matrix on the actual merge-result tree. The verified merge adds no implementation, assertion, dependency or configuration drift.

The 391 proxy-evidence files and four KILL-evidence files per profile were published and checksum-verified. Their presence inside aggregate tests does **not** mean the separate focused scheduling commands were rerun.

These earlier limitations remain unchanged:

- I1: natural PID>1 optional-ancestor denial remains **owner-deferred and unverified**.
- I2: four historical archives remain an **owner-accepted custody gap**, not recovered.
- Historical benchmark comparison remains **11/12**, with C3 6/6 and U 5/6. The Node 24 U cold-p95 failure remains real.
- No MCP-only causal improvement, equivalence or formal WSL qualification is established.
- No held executor is admitted by this result.
- No capability, deployment, real-harness, live-statusline or later-wave release follows.

## 8. Integration constraints

1. Preserve the failed aggregate, once-alone rerun, supplemental mjs, preparation UNKNOWN, prior failures and historical exceptions unchanged.
2. Record this ruling additively through the serialized documentation writer.
3. Before publication, re-read target/source refs and verify the intended merge’s complete tree and ordered parents.
4. Publish only the existing history-preserving, non-force integration of the accepted dependent set. The qualified result is **R with parents `[T,H]`**.
5. If a connector-created integration commit differs from local M only in commit metadata, report its actual SHA and verify its tree/parents. Do not claim local M itself was published.
6. Do not silently insert source, test, dependency or configuration changes, resolve conflicts, or reuse this acceptance for materially changed merge inputs. Relevant drift or a new failure returns to a fresh Oracle.
7. Perform the required remote-ref read-back before reporting integration complete, then make the authorized factual STATE/plan updates.
8. Do not touch `main`, force-push, rewrite history, stage dependency/generated state, deploy, or lift unrelated holds.

**Final disposition: exact actual merged-tree README gate ACCEPTED with the existing documented known-flake treatment. Original Node 24 `npm test`: FAIL / exit 1, retained. Integration/push remains a separate guarded action, not an outcome of this review.**
