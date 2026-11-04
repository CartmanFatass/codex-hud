import json, os
V = "<VERIFY_ROOT>"
RUN = f"{V}/{open(V + '/wave1-merged-tree-LATEST.txt').read().strip()}"
RUNID = os.path.basename(RUN)
S = json.load(open(RUN + "/SUMMARY.json"))
TV = json.load(open(RUN + "/manifest/tree-verification.json"))
ROWS = [r["id"] for r in json.load(open(RUN + "/profile-plan.json"))["rows"]]
P = S["profiles"]
names = {"01-build":"npm run build","02-build-test":"npm run build:test","03-build-hud-mcp":"npm run build:hud-mcp","04-npm-test":"npm test",
         "05-test-core":"npm run test:core","06-test-visual":"npm run test:visual","07-test-hud-mcp":"npm run test:hud-mcp",
         "08-format-check":"npm run format:check","09-check-fixtures":"npm run check:fixtures","10-git-diff-check":"git diff --check"}
def cell(prof, rid):
    e = P[prof]["rows"].get(rid)
    if not e: return "NOT RUN"
    c = e.get("counts_stage_own") or {}
    t = f"exit {e['raw_exit']}"
    if c.get("tests"): t += f"; {c['tests']} tests / {c['pass']} pass / {c['fail']} fail / {c['cancelled']} cancelled / {c['skipped']} skipped"
    t += f"; {e['duration_s']} s"
    return ("**FAIL** " if e["gate"] != "PASS" else "PASS ") + t
lines = []
a = lines.append
a(f"# C3 actual merged-tree verification: `{RUNID}`\n")
a("Local-verification evidence, append-only. Test identity and evidence-commit identity are different things: the evidence commit that carries this file is not the tested tree.\n")
a("## Result\n")
a("**Not an unqualified three-profile green.** 29 of the 30 required rows passed with exit 0 and clean closeout. One required row failed: `node24-envproxy` `04 npm test` exited 1 in the unit stage (`B6 idle wait has zero writes…`, `4 !== 3`), a failure that matches the README's existing known-flake entry `b6-wait-status` \"idle wait zero writes\". Per the rule, that suite was rerun once alone and passed (15/15), and `npm run test:mjs` was run as a labelled supplemental (47/47). **The original aggregate stays red (exit 1) and is not rewritten.** Whether this is accepted is for the next Oracle; this run does not self-promote it.\n")
a("- `node22-envproxy`: 10/10 rows PASS.\n- `node22-noenvproxy-control`: 10/10 rows PASS.\n- `node24-envproxy`: 9/10 rows PASS; row 04 FAIL (whitelisted flake class, isolated rerun green, mjs supplemental green).\n")
a("Nothing was pushed to `main` or `universal-hud`; M exists only locally. No capability, deployment or status change.\n")
a("## Identity\n")
a("| | |\n|---|---|\n")
for k, v in [("T (target input)", S["identity"]["T"]), ("H (source input)", S["identity"]["H"]), ("U (common base, unique `merge-base --all`)", S["identity"]["U"]),
             ("R (expected = actual tree)", S["identity"]["R"]), ("M (local test merge commit)", S["identity"]["M"]), ("M parents (ordered)", "`" + S["identity"]["T"] + " " + S["identity"]["H"] + "`"),
             ("C3 (accepted source candidate)", "`" + S["identity"]["C3"] + "` (ancestor of H; tree `0c8c67ede1f13122987802d9a0346cd6e6ecf73b`)")]:
    a(f"| {k} | `{v}` |\n" if not v.startswith("`") else f"| {k} | {v} |\n")
a("\n`git write-tree` before commit = R; `M^{tree}` = R; M's parents are exactly `[T,H]` in that order; commit hooks: none present. The same M is checked out in three separate detached worktrees (one per profile); every command's before/after record shows HEAD=M, tree=R, parents `[T,H]` and one identical tracked-source digest (`" + S["cross_profile_facts"]["source_digest_before_after_every_command"][0] + "`, excluding `node_modules`).\n")
a("### Tree verification (`manifest/tree-verification.json`, `scripts/verify_tree.py`)\n")
a(f"- `git merge-base --all T H` = `{TV['merge_base_all'][0]}` (unique, equals U); C3 is an ancestor of H: {TV['c3_is_ancestor_of_H']}.\n")
a(f"- Leaf entries (mode, type, object SHA): U {TV['leaf_counts']['U']}, T {TV['leaf_counts']['T']}, H {TV['leaf_counts']['H']}, C3 {TV['leaf_counts']['C3']}, R {TV['leaf_counts']['R_actual']}.\n")
a(f"- Connector-addendum three-way rule over U/T/H: conflicts {len(TV['three_way_conflicts'])}; file/directory prefix collisions {len(TV['file_dir_prefix_collisions'])}; predicted inventory == actual R inventory for all {TV['predicted_leaf_count']} entries: {TV['pred_equals_actual_R_complete_entries']}; tree SHA recomputed from the prediction with `git mktree` == R: {TV['recomputed_equals_R']}.\n")
a(f"- T→R: {TV['T_to_R']['changed_count']} changed paths ({TV['T_to_R']['kinds']['added']} added, {TV['T_to_R']['kinds']['modified']} modified, {TV['T_to_R']['kinds']['deleted']} deleted, {TV['T_to_R']['kinds']['mode_or_type_change']} mode/type changes): {len(TV['T_to_R']['source_paths_changed'])} source/test/source-doc paths + {TV['T_to_R']['non_source_changed_count']} documentation paths; changed paths outside `docs/` other than the 26: {len(TV['T_to_R']['non_source_non_docs_paths'])}. Modes in R: {', '.join(TV['modes_in_R'])}; no symlink/gitlink entries.\n")
a(f"- 26 source paths: every one equals its owner source commit's blob/mode/type ({TV['source_ownership_all_match']}); every other non-`docs/` path equals U ({TV['non_source_non_docs_equal_U']}).\n")
a(f"- H vs C3: {TV['C3_to_H']['changed_count']} paths, all added under `docs/cloud/handoff/wave1-compat-integration/`, no code/test/config/dependency change. T vs previously reviewed `4d0b7f14…`: {TV['Tprev_to_T']['changed_count']} path added (`{TV['Tprev_to_T']['paths'][0]}`). U→T: {TV['U_to_T']['changed_count']} paths, {len(TV['U_to_T']['non_docs_paths'])} outside `docs/`.\n")
a("- Refs: at start `origin/universal-hud` = T and `origin/dots/wave1-compat-integration` = H exactly; at end of run `git ls-remote` shows the same values (`manifest/remote-refs-end-of-run.txt`). `local-verification/20261103` head observed at start and end: `d769dc8b5b1faf87e1c30f356ae0223795f202c6`.\n")
a("- Package identity in M: `package.json` `53182aff…`, `package-lock.json` `87327f35…`, `node_modules` tree `77829c47…` (all equal to the expected values).\n")
a("\n## Runtime profiles\n")
a("| profile | node | npm | node sha256 | NODE_USE_ENV_PROXY |\n|---|---|---|---|---|\n")
for prof in P:
    r = P[prof]["runtime"]
    a(f"| {prof} | {r['node']} | {r['npm']} | `{r['node_sha256']}` | {'1' if prof != 'node22-noenvproxy-control' else 'not present in the environment (unset, not 0)'} |\n")
a("\nThe two Node 22 profiles use the same binary (`same_node22_binary_sha256_both_node22_profiles` = " + str(S["cross_profile_facts"]["same_node22_binary_sha256_both_node22_profiles"]) + "), the same PATH shape, the same proxy variables and differ only in the activation switch and per-command fresh directories. Node 22.23.4 tarball sha256 verified against its `SHASUMS256`. Each command ran with an empty constructed environment plus: PATH, HOME, HUD_HOME, TMPDIR (fresh, empty, per command), LANG, TERM, three npm UI switches, the owner's proxy variables copied unchanged (presence only recorded; upper/lower case relations in each `meta.json`), the activation switch where applicable, and fresh `NODE_PROXY_EVIDENCE_DIR`/`RUNZ1_KILL_EVIDENCE_DIR`. `NODE_OPTIONS`, `NODE_NO_WARNINGS`, `NODE_REDIRECT_WARNINGS`, `NO_COLOR`, `FORCE_COLOR` were absent in every command. The `UNDICI-EHPA` experimental-warning on stderr is the expected startup warning of the activation switch; it was neither suppressed nor redirected.\n")
a("\n## Required rows\n")
a("| # | command | node22-envproxy | node22-noenvproxy-control | node24-envproxy |\n|---|---|---|---|---|\n")
for rid in ROWS:
    a(f"| {rid[:2]} | `{names[rid]}` | " + " | ".join(cell(p, rid) for p in P) + " |\n")
a("\nCounts are each npm stage's own final summary (`npm test` = unit + mjs). Unit stage: 2410 tests / 16 skipped in all three profiles (Node 22 both profiles: 2394 pass, 0 fail; Node 24: 2393 pass, 1 fail). mjs stage: 47/47 where it ran. `test:core` 210 tests / 1 skipped, `test:hud-mcp` 108 tests / 1 skipped, `test:visual` 319 tests in all profiles. Skips are reported as observed; this run changed no test source, filter or skip. Node 24's spec reporter additionally prints a nested 3-test child summary inside the unit stage; it is listed under `stage_counts` in `SUMMARY.json` and excluded from the headline numbers.\n")
a("\n### Failure and follow-ups (all kept)\n")
e = P["node24-envproxy"]["rows"]["04-npm-test"]
a(f"- `node24-envproxy` `04-npm-test`: raw exit {e['raw_exit']}, native signal {e['native_signal']}, no timeout, stdout/stderr closed, owned state `{e['owned_state']}`. Failing test: {e.get('failing_tests')}; `AssertionError: 4 !== 3` at `b6-wait-status.test.js:151`. stderr empty. The `test:mjs` stage header never appears in this aggregate (unit failed first), so the mjs stage did not run inside it.\n")
x = P["node24-envproxy"]["extra"]
a(f"- Supplemental `04b-test-mjs-supplemental` (`npm run test:mjs`, 600 s): exit {x['04b-test-mjs-supplemental']['raw_exit']}, 47/47. It does not turn the aggregate green.\n")
a(f"- Isolated rerun `04r1-b6-wait-status-alone` (`node --test dist-test/tests/unit/b6-wait-status.test.js`, 300 s declared at run time): exit {x['04r1-b6-wait-status-alone']['raw_exit']}, 15/15. This is the single permitted rerun; no other suite was rerun and no second rerun was made. The green rerun does not erase the original failure.\n")
a("\n## Builds, dependencies, generated output\n")
a("- Each profile has its own new worktree at M with no `dist/`, `dist-test/`, `packages/hud-mcp/dist/` before its first build (`generated_present_before` in every `meta.json`). Nothing was copied from older trees and nothing was deleted.\n")
a("- `node_modules` in the tree is a partial tracked subset without prettier, so the README's allowed single lockfile install was run once per worktree: `npm ci --ignore-scripts` (900 s), raw logs under `logs/<profile>/00-npm-ci/`. The lockfile did not change; the only porcelain line is ` M node_modules/.package-lock.json` (dependency state, never staged).\n")
a("- Dependency manifests (334 files) are byte-identical across the three profiles: `" + S["cross_profile_facts"]["dependency_manifest_sha256_per_profile"]["node22-envproxy"][0] + "`. Generated-output manifests (2327 files; dist 1077, dist-test 1013, hud-mcp/dist 237) are byte-identical across the three profiles: `" + S["cross_profile_facts"]["generated_manifest_sha256_per_profile"]["node22-envproxy"][0] + "`. Per-file listings are in `manifest/`. Checkpoints before/after dependencies and builds and at the end of each profile show no drift.\n")
a("\n## Lifecycle and closeout\n")
a("- Runner: `scripts/w1m.py` (written for this round, not derived from the old `matrix.sh`/`lib.sh`). The tested command is the runner's direct child in its own session, with separate stdout and stderr pipes into separate raw files (no `2>&1`, no filtering). The command's own exit comes from `waitpid` (negative = native signal; none observed). There is no shell/`timeout` wrapper, so no wrapper-exit ambiguity; no timeout fired and no signal was sent by the supervisor in any command. Planned supervisor action (not used): SIGTERM to the command's own process group, SIGKILL after 10 s.\n")
a("- For every command: both pipes reached EOF, raw logs were written completely (fsync, size equals counted bytes), and a 1 Hz `/proc` census (descendants, own session/process group, and a per-command unique HOME token in `/proc/*/environ`, identity = pid + start ticks) shows every recorded identity gone after exit; no zombies, no D state, no leftovers; all `owned_state` values read `none-left`. Limit: a process that left the tree, changed session and cleared its environment within under a second would not be seen; nothing is claimed for it. Native wait fields of grandchildren are `unobserved`.\n")
a("- `owned-processes.json` per command lists the identities. Fresh `HOME`/`HUD_HOME`/`TMPDIR` per command remain on disk under the short temp root; nothing was cleaned.\n")
a("- Proxy and KILL captures produced natively by `npm test` (391 proxy-evidence files and 4 KILL-evidence files per profile) are under `captures/<profile>/04-npm-test/`.\n")
a("\n## Runner notes and exceptions\n")
a("- `00-runner-selfcheck` (node22-envproxy) is a harmless `node -e` self-check of the runner, kept for transparency; it is not one of the required rows.\n")
a("- `scripts/w1m.py` was edited twice: once before any command (a lock in the census) and once after `node22-envproxy` `00-npm-ci`, because `git status --porcelain` output had its leading space stripped by a `.strip()` and the dependency line ` M node_modules/.package-lock.json` was therefore misread as a non-dependency source change. That row's `result.json` shows `gate=UNKNOWN`, `src_ok=false` and the anomaly \"source/identity drift after command\"; its exit was 0 and the tracked-source digest before and after is identical. The published `w1m.py` is the final version. No other row was affected.\n")
a("- This round ran exactly the ten fixed commands per profile plus the labelled supplemental/rerun above. The earlier focused matrix, ancestor probe, benchmark, mutation archive and KILL burst were not repeated; no real harness, Herdr, tmux, Jev, B13_REAL, B45 real closure or B14 was started; nothing was installed or deployed; nothing was delegated.\n")
a("- The 2026-11-03 integration ruling also describes a NODE22-PROXY matrix (e.g. `node-proxy-profile.test.js`, extra enabled-profile checks) as an independent step. This round executed only the prompt's ten-row set; those proxy and KILL tests run inside `npm test` (their native captures are published), but the separate focused commands were not run.\n")
a("\n## Historical limits that stay\n")
a("- C3 has the owner-exception joint ACCEPT. I1 (natural PID>1 optional-ancestor EACCES/EPERM) is owner-deferred, non-blocking, **still unverified**. I2 (four historical full raw archives) is an owner-accepted custody gap, non-blocking, **still not recovered or fully read back**. Neither was tested here.\n")
a("- No ancestor-denial topology was constructed. Earlier MCP benchmark: C3 6/6 exit 0, U 5/6, together 11/12; Node 24 U cold p95 208.678213 ms, exit 1; not rerun, not 12/12, no MCP-only performance, equivalence or formal WSL qualification claim.\n")
a("- The older 706-file NODE22 courier is not a complete archive and this run does not restore it; old failures, negative controls, the missing 15:57 snapshot, null native wait fields and privacy-backup limits stand. Other executor holds are not lifted by this local run.\n")
a("- Results apply only to the fixed T/H and the actual M/R. If the target moves substantively, this pass cannot be reused for the new tree. The sole merger must still perform the controlled integration and remote verification; `universal-hud` was not touched.\n")
a("\n## Published vs original\n")
a("Published files are redacted copies (see `redaction-manifest.json`): real user name, home and worktree paths, host name, e-mail and git author identity are replaced by stable codes with equal values mapping to equal codes. Exit codes, signals, UTC times, test names, failure text, counts, PIDs and lifecycle relations are unchanged. Published files are therefore not byte-identical to the local originals, which stay local and unmodified; the private raw-to-published map is not published.\n")
open(RUN + "/REPORT.md", "w").write("".join(lines))
print("ok", len("".join(lines)))
