# C3 actual merged-tree verification: `wave1-merged-tree-20261104T114728Z-1912659`
Local-verification evidence, append-only. Test identity and evidence-commit identity are different things: the evidence commit that carries this file is not the tested tree.
## Result
**Not an unqualified three-profile green.** 29 of the 30 required rows passed with exit 0 and clean closeout. One required row failed: `node24-envproxy` `04 npm test` exited 1 in the unit stage (`B6 idle wait has zero writes…`, `4 !== 3`), a failure that matches the README's existing known-flake entry `b6-wait-status` "idle wait zero writes". Per the rule, that suite was rerun once alone and passed (15/15), and `npm run test:mjs` was run as a labelled supplemental (47/47). **The original aggregate stays red (exit 1) and is not rewritten.** Whether this is accepted is for the next Oracle; this run does not self-promote it.
- `node22-envproxy`: 10/10 rows PASS.
- `node22-noenvproxy-control`: 10/10 rows PASS.
- `node24-envproxy`: 9/10 rows PASS; row 04 FAIL (whitelisted flake class, isolated rerun green, mjs supplemental green).
Nothing was pushed to `main` or `universal-hud`; M exists only locally. No capability, deployment or status change.
## Identity
| | |
|---|---|
| T (target input) | `9dd4d06d2ee5ebb022719d11b74d6de0276172a4` |
| H (source input) | `09d9c3d95fe42932ecaf35dd46806a8747681aa7` |
| U (common base, unique `merge-base --all`) | `f248f320d42528fd1eb97db9f1cd2ba97e6d3c86` |
| R (expected = actual tree) | `48f59142862f643a98286e3d196d23ff13059a23` |
| M (local test merge commit) | `9112e87b1af9c321ca87facdfc56994cf493438f` |
| M parents (ordered) | `9dd4d06d2ee5ebb022719d11b74d6de0276172a4 09d9c3d95fe42932ecaf35dd46806a8747681aa7` |
| C3 (accepted source candidate) | `36d3fd584bd403ed7ada95d1d863a8f63e96588b` (ancestor of H; tree `0c8c67ede1f13122987802d9a0346cd6e6ecf73b`) |

`git write-tree` before commit = R; `M^{tree}` = R; M's parents are exactly `[T,H]` in that order; commit hooks: none present. The same M is checked out in three separate detached worktrees (one per profile); every command's before/after record shows HEAD=M, tree=R, parents `[T,H]` and one identical tracked-source digest (`1d31999efe228e84e74c4cdd64c4d99dbf738a98632f2206b030c6c5edb1bc39`, excluding `node_modules`).
### Tree verification (`manifest/tree-verification.json`, `scripts/verify_tree.py`)
- `git merge-base --all T H` = `f248f320d42528fd1eb97db9f1cd2ba97e6d3c86` (unique, equals U); C3 is an ancestor of H: True.
- Leaf entries (mode, type, object SHA): U 1327, T 1339, H 1377, C3 1370, R 1389.
- Connector-addendum three-way rule over U/T/H: conflicts 0; file/directory prefix collisions 0; predicted inventory == actual R inventory for all 1389 entries: True; tree SHA recomputed from the prediction with `git mktree` == R: True.
- T→R: 65 changed paths (50 added, 15 modified, 0 deleted, 0 mode/type changes): 26 source/test/source-doc paths + 39 documentation paths; changed paths outside `docs/` other than the 26: 0. Modes in R: 100644, 100755; no symlink/gitlink entries.
- 26 source paths: every one equals its owner source commit's blob/mode/type (True); every other non-`docs/` path equals U (True).
- H vs C3: 7 paths, all added under `docs/cloud/handoff/wave1-compat-integration/`, no code/test/config/dependency change. T vs previously reviewed `4d0b7f14…`: 1 path added (`docs/cloud/rulings/leg1-owner-direction-20261104.md`). U→T: 16 paths, 0 outside `docs/`.
- Refs: at start `origin/universal-hud` = T and `origin/dots/wave1-compat-integration` = H exactly; at end of run `git ls-remote` shows the same values (`manifest/remote-refs-end-of-run.txt`). `local-verification/20261103` head observed at start and end: `d769dc8b5b1faf87e1c30f356ae0223795f202c6`.
- Package identity in M: `package.json` `53182aff…`, `package-lock.json` `87327f35…`, `node_modules` tree `77829c47…` (all equal to the expected values).

## Runtime profiles
| profile | node | npm | node sha256 | NODE_USE_ENV_PROXY |
|---|---|---|---|---|
| node22-envproxy | v22.23.4 | 10.9.9 | `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90` | 1 |
| node22-noenvproxy-control | v22.23.4 | 10.9.9 | `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90` | not present in the environment (unset, not 0) |
| node24-envproxy | v24.22.1 | 11.19.1 | `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb` | 1 |

The two Node 22 profiles use the same binary (`same_node22_binary_sha256_both_node22_profiles` = True), the same PATH shape, the same proxy variables and differ only in the activation switch and per-command fresh directories. Node 22.23.4 tarball sha256 verified against its `SHASUMS256`. Each command ran with an empty constructed environment plus: PATH, HOME, HUD_HOME, TMPDIR (fresh, empty, per command), LANG, TERM, three npm UI switches, the owner's proxy variables copied unchanged (presence only recorded; upper/lower case relations in each `meta.json`), the activation switch where applicable, and fresh `NODE_PROXY_EVIDENCE_DIR`/`RUNZ1_KILL_EVIDENCE_DIR`. `NODE_OPTIONS`, `NODE_NO_WARNINGS`, `NODE_REDIRECT_WARNINGS`, `NO_COLOR`, `FORCE_COLOR` were absent in every command. The `UNDICI-EHPA` experimental-warning on stderr is the expected startup warning of the activation switch; it was neither suppressed nor redirected.

## Required rows
| # | command | node22-envproxy | node22-noenvproxy-control | node24-envproxy |
|---|---|---|---|---|
| 01 | `npm run build` | PASS exit 0; 7.124 s | PASS exit 0; 5.874 s | PASS exit 0; 6.122 s |
| 02 | `npm run build:test` | PASS exit 0; 11.475 s | PASS exit 0; 10.009 s | PASS exit 0; 9.526 s |
| 03 | `npm run build:hud-mcp` | PASS exit 0; 3.522 s | PASS exit 0; 3.072 s | PASS exit 0; 2.873 s |
| 04 | `npm test` | PASS exit 0; 2457 tests / 2441 pass / 0 fail / 0 cancelled / 16 skipped; 86.893 s | PASS exit 0; 2457 tests / 2441 pass / 0 fail / 0 cancelled / 16 skipped; 83.055 s | **FAIL** exit 1; 2410 tests / 2393 pass / 1 fail / 0 cancelled / 16 skipped; 75.2 s |
| 05 | `npm run test:core` | PASS exit 0; 210 tests / 209 pass / 0 fail / 0 cancelled / 1 skipped; 16.777 s | PASS exit 0; 210 tests / 209 pass / 0 fail / 0 cancelled / 1 skipped; 15.033 s | PASS exit 0; 210 tests / 209 pass / 0 fail / 0 cancelled / 1 skipped; 12.674 s |
| 06 | `npm run test:visual` | PASS exit 0; 319 tests / 319 pass / 0 fail / 0 cancelled / 0 skipped; 13.324 s | PASS exit 0; 319 tests / 319 pass / 0 fail / 0 cancelled / 0 skipped; 14.376 s | PASS exit 0; 319 tests / 319 pass / 0 fail / 0 cancelled / 0 skipped; 10.424 s |
| 07 | `npm run test:hud-mcp` | PASS exit 0; 108 tests / 107 pass / 0 fail / 0 cancelled / 1 skipped; 4.672 s | PASS exit 0; 108 tests / 107 pass / 0 fail / 0 cancelled / 1 skipped; 5.272 s | PASS exit 0; 108 tests / 107 pass / 0 fail / 0 cancelled / 1 skipped; 3.925 s |
| 08 | `npm run format:check` | PASS exit 0; 11.322 s | PASS exit 0; 11.526 s | PASS exit 0; 9.926 s |
| 09 | `npm run check:fixtures` | PASS exit 0; 0.221 s | PASS exit 0; 0.171 s | PASS exit 0; 0.17 s |
| 10 | `git diff --check` | PASS exit 0; 0.008 s | PASS exit 0; 0.009 s | PASS exit 0; 0.008 s |

Counts are each npm stage's own final summary (`npm test` = unit + mjs). Unit stage: 2410 tests / 16 skipped in all three profiles (Node 22 both profiles: 2394 pass, 0 fail; Node 24: 2393 pass, 1 fail). mjs stage: 47/47 where it ran. `test:core` 210 tests / 1 skipped, `test:hud-mcp` 108 tests / 1 skipped, `test:visual` 319 tests in all profiles. Skips are reported as observed; this run changed no test source, filter or skip. Node 24's spec reporter additionally prints a nested 3-test child summary inside the unit stage; it is listed under `stage_counts` in `SUMMARY.json` and excluded from the headline numbers.

### Failure and follow-ups (all kept)
- `node24-envproxy` `04-npm-test`: raw exit 1, native signal None, no timeout, stdout/stderr closed, owned state `none-left (all recorded identities gone)`. Failing test: ['B6 idle wait has zero writes, no polling, and timeout leaves empty cursor/state unchanged']; `AssertionError: 4 !== 3` at `b6-wait-status.test.js:151`. stderr empty. The `test:mjs` stage header never appears in this aggregate (unit failed first), so the mjs stage did not run inside it.
- Supplemental `04b-test-mjs-supplemental` (`npm run test:mjs`, 600 s): exit 0, 47/47. It does not turn the aggregate green.
- Isolated rerun `04r1-b6-wait-status-alone` (`node --test dist-test/tests/unit/b6-wait-status.test.js`, 300 s declared at run time): exit 0, 15/15. This is the single permitted rerun; no other suite was rerun and no second rerun was made. The green rerun does not erase the original failure.

## Builds, dependencies, generated output
- Each profile has its own new worktree at M with no `dist/`, `dist-test/`, `packages/hud-mcp/dist/` before its first build (`generated_present_before` in every `meta.json`). Nothing was copied from older trees and nothing was deleted.
- `node_modules` in the tree is a partial tracked subset without prettier, so the README's allowed single lockfile install was run once per worktree: `npm ci --ignore-scripts` (900 s), raw logs under `logs/<profile>/00-npm-ci/`. The lockfile did not change; the only porcelain line is ` M node_modules/.package-lock.json` (dependency state, never staged).
- Dependency manifests (334 files) are byte-identical across the three profiles: `861f57957168c696805b093a6a944c14cb90e65541a1c5d3ef6d9d53d6de5518`. Generated-output manifests (2327 files; dist 1077, dist-test 1013, hud-mcp/dist 237) are byte-identical across the three profiles: `4e076ab5038c93ce7a95d9fc319ad382a40ca056527c2c47d085c76ce34294f8`. Per-file listings are in `manifest/`. Checkpoints before/after dependencies and builds and at the end of each profile show no drift.

## Lifecycle and closeout
- Runner: `scripts/w1m.py` (written for this round, not derived from the old `matrix.sh`/`lib.sh`). The tested command is the runner's direct child in its own session, with separate stdout and stderr pipes into separate raw files (no `2>&1`, no filtering). The command's own exit comes from `waitpid` (negative = native signal; none observed). There is no shell/`timeout` wrapper, so no wrapper-exit ambiguity; no timeout fired and no signal was sent by the supervisor in any command. Planned supervisor action (not used): SIGTERM to the command's own process group, SIGKILL after 10 s.
- For every command: both pipes reached EOF, raw logs were written completely (fsync, size equals counted bytes), and a 1 Hz `/proc` census (descendants, own session/process group, and a per-command unique HOME token in `/proc/*/environ`, identity = pid + start ticks) shows every recorded identity gone after exit; no zombies, no D state, no leftovers; all `owned_state` values read `none-left`. Limit: a process that left the tree, changed session and cleared its environment within under a second would not be seen; nothing is claimed for it. Native wait fields of grandchildren are `unobserved`.
- `owned-processes.json` per command lists the identities. Fresh `HOME`/`HUD_HOME`/`TMPDIR` per command remain on disk under the short temp root; nothing was cleaned.
- Proxy and KILL captures produced natively by `npm test` (391 proxy-evidence files and 4 KILL-evidence files per profile) are under `captures/<profile>/04-npm-test/`.

## Runner notes and exceptions
- `00-runner-selfcheck` (node22-envproxy) is a harmless `node -e` self-check of the runner, kept for transparency; it is not one of the required rows.
- `scripts/w1m.py` was edited twice: once before any command (a lock in the census) and once after `node22-envproxy` `00-npm-ci`, because `git status --porcelain` output had its leading space stripped by a `.strip()` and the dependency line ` M node_modules/.package-lock.json` was therefore misread as a non-dependency source change. That row's `result.json` shows `gate=UNKNOWN`, `src_ok=false` and the anomaly "source/identity drift after command"; its exit was 0 and the tracked-source digest before and after is identical. The published `w1m.py` is the final version. No other row was affected.
- This round ran exactly the ten fixed commands per profile plus the labelled supplemental/rerun above. The earlier focused matrix, ancestor probe, benchmark, mutation archive and KILL burst were not repeated; no real harness, Herdr, tmux, Jev, B13_REAL, B45 real closure or B14 was started; nothing was installed or deployed; nothing was delegated.
- The 2026-11-03 integration ruling also describes a NODE22-PROXY matrix (e.g. `node-proxy-profile.test.js`, extra enabled-profile checks) as an independent step. This round executed only the prompt's ten-row set; those proxy and KILL tests run inside `npm test` (their native captures are published), but the separate focused commands were not run.

## Historical limits that stay
- C3 has the owner-exception joint ACCEPT. I1 (natural PID>1 optional-ancestor EACCES/EPERM) is owner-deferred, non-blocking, **still unverified**. I2 (four historical full raw archives) is an owner-accepted custody gap, non-blocking, **still not recovered or fully read back**. Neither was tested here.
- No ancestor-denial topology was constructed. Earlier MCP benchmark: C3 6/6 exit 0, U 5/6, together 11/12; Node 24 U cold p95 208.678213 ms, exit 1; not rerun, not 12/12, no MCP-only performance, equivalence or formal WSL qualification claim.
- The older 706-file NODE22 courier is not a complete archive and this run does not restore it; old failures, negative controls, the missing 15:57 snapshot, null native wait fields and privacy-backup limits stand. Other executor holds are not lifted by this local run.
- Results apply only to the fixed T/H and the actual M/R. If the target moves substantively, this pass cannot be reused for the new tree. The sole merger must still perform the controlled integration and remote verification; `universal-hud` was not touched.

## Published vs original
Published files are redacted copies (see `redaction-manifest.json`): real user name, home and worktree paths, host name, e-mail and git author identity are replaced by stable codes with equal values mapping to equal codes. Exit codes, signals, UTC times, test names, failure text, counts, PIDs and lifecycle relations are unchanged. Published files are therefore not byte-identical to the local originals, which stay local and unmodified; the private raw-to-published map is not published.
