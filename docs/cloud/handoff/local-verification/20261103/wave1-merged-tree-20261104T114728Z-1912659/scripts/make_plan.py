import json, sys, os
V = "<VERIFY_ROOT>"
RUNID = open(V + "/wave1-merged-tree-LATEST.txt").read().strip()
RUN = f"{V}/{RUNID}"
N22 = V + "/runtimes/node-v22.23.4/bin"
N24 = "<NVM>/versions/node/v24.22.1/bin"
rows = [
 ("01-build", ["npm","run","build"], 600),
 ("02-build-test", ["npm","run","build:test"], 600),
 ("03-build-hud-mcp", ["npm","run","build:hud-mcp"], 600),
 ("04-npm-test", ["npm","test"], 1800),
 ("05-test-core", ["npm","run","test:core"], 900),
 ("06-test-visual", ["npm","run","test:visual"], 600),
 ("07-test-hud-mcp", ["npm","run","test:hud-mcp"], 900),
 ("08-format-check", ["npm","run","format:check"], 300),
 ("09-check-fixtures", ["npm","run","check:fixtures"], 300),
 ("10-git-diff-check", ["git","diff","--check"], 60),
]
plan = {
 "round": RUNID,
 "authored_before_any_profile_command": True,
 "identity": {"T":"9dd4d06d2ee5ebb022719d11b74d6de0276172a4","H":"09d9c3d95fe42932ecaf35dd46806a8747681aa7",
              "R":"48f59142862f643a98286e3d196d23ff13059a23","M":"9112e87b1af9c321ca87facdfc56994cf493438f",
              "C3":"36d3fd584bd403ed7ada95d1d863a8f63e96588b","U":"f248f320d42528fd1eb97db9f1cd2ba97e6d3c86"},
 "profiles_order": ["node22-envproxy","node22-noenvproxy-control","node24-envproxy"],
 "profiles": {
  "node22-envproxy": {"short":"a","worktree":f"{RUN}/wt/node22-envproxy","node_bin_dir":N22,"node_use_env_proxy":True,
      "runtime_identity":{"node":"v22.23.4","npm":"10.9.9","node_sha256":"94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90","tarball_sha256_verified_against_SHASUMS256":"1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce","path_selection":"PATH=<node-bin>:/usr/bin:/bin; node and npm resolve under <node-bin>"}},
  "node22-noenvproxy-control": {"short":"b","worktree":f"{RUN}/wt/node22-noenvproxy-control","node_bin_dir":N22,"node_use_env_proxy":False,
      "runtime_identity":{"node":"v22.23.4","npm":"10.9.9","node_sha256":"94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90","same_binary_as":"node22-envproxy","path_selection":"identical to node22-envproxy; NODE_USE_ENV_PROXY not present in the environment (unset, not 0)"}},
  "node24-envproxy": {"short":"c","worktree":f"{RUN}/wt/node24-envproxy","node_bin_dir":N24,"node_use_env_proxy":True,
      "runtime_identity":{"node":"v24.22.1","npm":"11.19.1","node_sha256":"e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb","path_selection":"PATH=<node-bin>:/usr/bin:/bin"}},
 },
 "pre_step_per_profile": {"id":"00-npm-ci","argv":["npm","ci","--ignore-scripts"],"timeout_s":900,
     "why":"node_modules in the tree is a partial tracked subset (no prettier); README allows one lockfile install when tsc/prettier is missing. Own worktree only; dependency state is never staged.",
     "npm_cache":"shared read/write cache dir outside every worktree (<VERIFY_ROOT>/npm-cache), only for this step"},
 "rows": [{"id":i,"argv":a,"timeout_s":t} for i,a,t in rows],
 "supplemental": {"04b-test-mjs": {"argv":["npm","run","test:mjs"],"timeout_s":600,"only_if":"npm test failed in the unit stage and the test:mjs stage header never appears in its stdout; never used to turn the aggregate green; not run if mjs completed"}},
 "environment": {
   "construction":"empty environment (env -i style) + exactly: PATH, HOME, HUD_HOME, TMPDIR (fresh empty dirs per command), LANG=C.UTF-8, TERM=xterm-256color, npm_config_update_notifier/fund/audit=false, the owner's proxy variables copied unchanged (values never recorded), NODE_USE_ENV_PROXY=1 only for envproxy profiles, NODE_PROXY_EVIDENCE_DIR and RUNZ1_KILL_EVIDENCE_DIR (fresh per command)",
   "proxy_names_passed_unchanged": ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"],
   "absent_by_construction":["NO_COLOR","FORCE_COLOR","NODE_OPTIONS","NODE_NO_WARNINGS","NODE_REDIRECT_WARNINGS","CI","CLAUDE*","HERDR*","CODEX*","anything else inherited"],
   "node22_profiles_differ_only_in":"NODE_USE_ENV_PROXY presence and the per-command fresh dirs"},
 "supervisor": {"kind":"python runner (scripts/w1m.py), command is its direct child, own session, separate stdout/stderr pipes","term_to_kill_grace_s":10,
     "timeout_action":"SIGTERM to the command's own process group (leader pid + start ticks recorded), then SIGKILL after 10 s if still alive; only the group this runner created; no pkill/killall/name or pattern kill; never the runner's ancestors",
     "no_other_kills":"survivors after a normal exit are reported, not killed"},
 "known_flake_whitelist": ["model-jobs.test.js timing","b6-wait-status idle wait zero writes","b3h-heartbeat-busy fence loss","run-light-leader portable waiter topology / bash --posix (143 !== 3)","ledger_busy family (delegation.ts:417 30 ms wall-clock) as listed in README"],
 "flake_rule":"only a failure that matches README's existing condition may have that suite rerun once alone; both runs kept; original aggregate never rewritten; a rerun pass is handed to the Oracle, not self-promoted",
 "stop_conditions":["any non-whitelisted failure","permission denial","timeout","pipe not closed / owned process left / D state / zombie","source, M, R or dependency identity drift","unclear lifecycle","missing assertion/stage"],
 "after_stop":"keep scene, no further workload, publish what exists; remaining rows recorded NOT RUN / BLOCKED",
 "not_done_by_design":["real harness, Herdr, tmux, Jev, live statusline, B13_REAL, B45 real closure, B14","focused matrix, ancestor probe, benchmark, mutation archive, KILL burst","delegation to Codex","pushes to main/universal-hud","deleting/cleaning anything"],
 "publication":{"branch":"local-verification/20261103","path":f"docs/cloud/handoff/local-verification/20261103/{RUNID}/","append_only":True,"force":False},
}
json.dump(plan, open(RUN + "/profile-plan.json", "w"), indent=1)
print("plan written")
