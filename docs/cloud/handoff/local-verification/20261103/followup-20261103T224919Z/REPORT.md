# Local follow-up verification: MCP-ANCESTOR, NODE22-PROXY, RUNZ1-KILL (run 20261103T224919Z)

Owner-requested local verification on the owner's WSL machine, run by a local Claude Code session after the NEXT run
(`../NEXT/`) finished. No overlap with NEXT. Verification only: no source, test, assertion, baseline, script,
dependency, lockfile, runtime, threshold or security setting was changed. No merge, cherry-pick, integration candidate
or branch change; the only Git write is this evidence directory. Nothing here is acceptance: Oracle acceptance and the
merged-tree gates remain open for all three packages.

Paths are relative to this directory. `<VERIFY_ROOT>`, `<REPO>`, `<HOME>`, `<SROOT>`, `<host>` and `identity-R<n>`
replace private values (§8, `redaction-manifest.txt`).

## 1. Short result

| Package | Candidate / tree | Full README set | Package-specific |
|---|---|---|---|
| MCP-ANCESTOR | `b2897a4f` / `0d195bd4` ✔ | Node 24 envproxy: **all green** (npm test reached mjs: unit 2329 pass/0 fail/16 skip, mjs 47/47). Node 22 envproxy: **npm test exit 1**, 12 unit failures (the envproxy output-capture class; this branch does not contain NODE22-PROXY), mjs not reached, separate test:mjs 47/47; everything else green. | Three-file gate 43/43 on both runtimes; package prettier check exit 0 on both. **Real root-owned ancestor: natural topology not reproduced; the real-ancestor gate is still unproven (自然拓扑未复现，真实祖先门禁仍待证)** (§3.2). Benchmark 12/12 exit 0, gates met in every run (§3.3). |
| NODE22-PROXY | `b4047320` / `d9be29f2` ✔ | node22-envproxy: **all green**. node24-envproxy: **all green**. node22-noenvproxy-control: **npm test exit 1**, 2 `ledger_busy` failures in README-listed flake suites (b11-cli, b21-capacity); each isolated rerun passed (20/20, 5/5); separate test:mjs 47/47; everything else green. | All four focused commands pass in all three profiles: node-proxy-profile 5/5, three-file serial 76/76, three-file normal 76/76, HYG2 six-suite 76/76 (§4). |
| RUNZ1-KILL | `7ba567ee` / `ad4c5968` ✔ | Node 24 envproxy: **npm test exit 1**, 1 `ledger_busy` failure (b21-capacity, README-listed; isolated rerun 5/5), mjs not reached, separate test:mjs 47/47; everything else green. | Kill-evidence serial 44/44 on Node 22 and 24. RUNZ1 three-file: Node 24 54/54; **Node 22 envproxy 53/54**: `one-shot group launch preserves argv and stdin EOF…` fails with `Unexpected token '(', "(node:8298"... is not valid JSON` (envproxy warning in the captured stream; not a listed flake, not rerun) (§5). |

No command timed out or was killed by a signal. Every command ran once. The only reruns are the four README-permitted
known-flake suite reruns listed above, and both logs are kept for each.

## 2. Identities, environment, isolation

**Targets** (`manifest/identity.txt`, `manifest/refs-and-docs.txt`). origin = `CartmanFatass/codex-hud`. Each target
has a new detached worktree at the exact candidate commit, and its tree matches the pinned tree.

| Key | Branch (head at fetch) | Candidate | Tree | candidate..head |
|---|---|---|---|---|
| mcp | dots/mcp-ancestor `dc4b96b8` (= verified doc head) | `b2897a4f9769bca6305ff0e3ae3dc694a9320ffe` | `0d195bd47ff2b29581e1c394c2973d9479f8d928` | adds only 3 docs/cloud/handoff files |
| mcpbase | (benchmark baseline) | `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22` (ancestor of mcp) | `03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9` | n/a |
| n22 | dots/node22-proxy `65b26a91` (= verified doc head) | `b4047320262f72f401a513db07236ff1473db933` (parent `ce5e6961` ✔) | `d9be29f28da496a880802c267a08e8bb4fcbee74` | adds only 4 docs/cloud/handoff/node22-proxy files |
| rk | dots/runz1-kill `fa024ffa` (= verified doc head) | `7ba567ee0c3cd12933d79a5029162d32770ee245` | `ad4c596860b264d76d4060be90d70337046b92c5` | adds only 2 docs/cloud/handoff/runz1-kill files |

No new implementation commit was found on any branch. Binding documents were read from `origin/universal-hud`
`48abc4fc`; their blob SHAs and the four review blobs are in `manifest/refs-and-docs.txt`. All four trees have
package-lock blob `87327f35…` and benchmark blob `c36817dee4cf70c27a39a86b3965f4eb6701ceb0`. Per-file source SHA-256
manifests are in `manifest/source-sha256-<key>.txt`.

**Source/test bytes before and after** (`manifest/source-check-*.txt`). HEAD is unchanged throughout. The tracked-bytes
digest changes once, at `npm ci`, because `npm ci` rewrites the tracked `node_modules/.package-lock.json`. It then stays
identical through every test and benchmark (after-install = after-checks = after-bench = final). `git status` after
install shows only ` M node_modules/.package-lock.json`, which was never staged.

**Host** (`manifest/environment.txt`): WSL2 kernel 6.18.33.2-microsoft-standard-WSL2 x86_64, Ubuntu 24.04.4 LTS, AMD
Ryzen 7 8745H ×16, 15.6 GB RAM, ext4 root (`/dev/sdd`). Worktrees and all temporary dirs are on that root (short temp
root `<SROOT>` = `<SROOT>` on the same ext4 `/dev/sdd` root, which `stat -f` reports with the ext2/ext3
magic; not `/mnt/c`, not tmpfs).
`kernel.yama.ptrace_scope=1`.

**Capabilities, measured now** (`logs/mcp/node{22,24}-envproxy/00-capability-probe.*`): under the same wrapper on Node
22.23.4 and 24.22.1, AF_UNIX listen+connect OK, `ptrace(TRACEME)` 0 and `PTRACE_ATTACH` own child 0, and
`/proc/<pid>/task/<pid>/children` lists the child. Nothing was bypassed.

**Runtimes**: `<VERIFY_ROOT>/runtimes/node-v22.23.4/bin/node` v22.23.4 / npm 10.9.9 (SHA-256 `94efd062…9a90`);
`<HOME>/.nvm/versions/node/v24.22.1/bin/node` v24.22.1 / npm 11.19.1 (`e32e2d16…afb`).

**Dependencies**: `npm ci --ignore-scripts --prefer-offline` once per worktree (Node 24, declared proxy policy, 900 s;
`logs/<key>/node24-envproxy/00-npm-ci.*`). All four `node_modules` manifests are identical: 332 files, digest
`843e84e7…42f3` (`manifest/dependency-*.txt`). This is the same installation identity as NEXT.

**Generated output**: before each profile's builds, `dist/`, `dist-test/` and `packages/hud-mcp/dist/` were deleted
(`manifest/clean-*.txt`) and rebuilt. Per-build file manifests and aggregates are in `manifest/generated-<key>-<profile>.txt`
and `*.summary.txt`.

**Wrapper** (`scripts/lib.sh` `run()`; each command's expanded wrapper is in its `.meta.txt`):

```
cd <wt>; env -i PATH=<selected node bin>:/usr/bin:/bin HOME=<new> HUD_HOME=<new> TMPDIR=<new> LANG=C.UTF-8 TERM=xterm-256color
  npm_config_cache=<VERIFY_ROOT>/npm-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy   (values unchanged from the owner's shell)
  [NODE_USE_ENV_PROXY=1 in *-envproxy profiles] [NODE_PROXY_EVIDENCE_DIR | RUNZ1_KILL_EVIDENCE_DIR = new empty captures dir]
  timeout -k 10 <brief limit>s bash scripts/anc-exec.sh <ancestry file> <command>
```

- A new HOME, HUD_HOME and TMPDIR per command. The absolute Node/npm paths are chosen before HOME is replaced, and the
  selected Node directory is first on PATH.
- Proxy variables are passed unchanged; only their presence (`=<set>`) is logged, never their values. This follows the
  owner policy in `profile-plan.json`, which supersedes the NEXT run's clearing of NODE_USE_ENV_PROXY.
- The invoking shell had **no NODE_OPTIONS, NODE_NO_WARNINGS or NODE_REDIRECT_WARNINGS** (no conflict to record). No
  `--no-warnings`, `--disable-warning`, redirect, preload or trace flags were used.
- `env -i` removes NO_COLOR, FORCE_COLOR, CI and all `CLAUDE*`/`HERDR*`/`CODEX*` selectors.
- stdout and stderr are written raw to separate files (`.stdout`, `.stderr`), with no filtering, trimming or merging.
- Real `~/.hud`, `~/.claude`, `~/.codex*`, `~/.pi` were not used.
- No Codex delegation and no real harness, Herdr, tmux, B13_REAL, B45 real closure, B14, install or live statusline
  tests.

**Process ancestry** for every command (`*.ancestry.txt`, PID/comm/UID only): `bash(anc-exec) ← timeout ← bash driver ←
zsh ← claude ← zsh ← herdr ← systemd(PID 1, uid 0)`. All processes except PID 1 have UID 1000.

**Load** (`*.monitor.txt`: 1 s samples of loadavg and the top-6 processes by name and %CPU). The machine was not
isolated. The owner's other sessions were active, e.g. `codex`, a long-running `python3`, `ast-grep` (about 55 %)
throughout the benchmark window, and short `runc`/`git`/`opengrep` bursts. The highest 1-minute load over all commands
was 14.93, during full-suite runs. `ps` %CPU is a lifetime average, and 1 s snapshots are not isolation proof. No
unrelated process was touched.

Order: setup → MCP (22:50–22:55Z) → MCP benchmark window (22:55–22:57Z) → NODE22-PROXY (22:57–23:08Z, plus flake
reruns) → RUNZ1-KILL (23:08–23:13Z, plus flake rerun). Each package ran serially, with no overlap.

## 3. MCP-ANCESTOR

### 3.1 Checks (`logs/mcp/<profile>/`, limits from the MCP brief)

| Step | node22-envproxy | node24-envproxy |
|---|---|---|
| build / build:test / build:hud-mcp (600 s each) | exit 0 / 0 / 0 | exit 0 / 0 / 0 |
| npm test (1800 s) | **exit 1**: unit 2317/2345 pass, **12 fail**, 16 skip; mjs not reached | exit 0: unit 2329/2345, 0 fail, 16 skip; mjs 47/47 |
| test:mjs separately (600 s) | exit 0, 47/47 | not needed (`04b-…not-run.txt`) |
| test:core (900 s) | exit 0, 209 + 1 skip | exit 0, 209 + 1 skip |
| test:visual (600 s) | exit 0, 319/319 | exit 0, 319/319 |
| test:hud-mcp (900 s) | exit 0, 107 + 1 skip | exit 0, 107 + 1 skip |
| format:check / check:fixtures (300 s) / git diff --check (60 s) | 0 / 0 / 0 | 0 / 0 / 0 |
| three-file gate `ancestor-discovery`, `skeleton`, `int-ledger-registry` (300 s) | exit 0, 43/43 | exit 0, 43/43 |
| package prettier check (300 s) | exit 0 | exit 0 |

The 12 Node 22 envproxy unit failures: the 10 `hud …` export/help/refusal tests in hud-link-export and the two process
fixtures `light leader preserves exact brief bytes and EOF on workload fd0` and `one-shot group launch preserves argv
and stdin EOF, waits for helper exit` (names in `SUMMARY.json`). This is the same class as the old owner run's envproxy
matrix. MCP-ANCESTOR is based on `26f6fba` and does not contain the NODE22-PROXY/HYG2 changes. They are not listed
flakes, so they were not rerun and stay failures.

The gate's synthetic cases passed on both runtimes, including:
- `simulated EACCES/EPERM optional ancestor: physical registration survives, no farther harness or authority` (profile
  false/true),
- `int simulated optional ancestor EACCES/EPERM writes only physical caller; source-less tool cannot authorize`,
- `changed physical stamps, inconsistent namespace, unavailable domain and cwd retain zero-write guards`,
- `int hud-mcp physical caller registration persists real procStart/cwd without logical authority`, and the
  JSON-RPC/tail-output tests in skeleton.

These are the synthetic and real-process tests as written. They are not the real root-owned-ancestor evidence.

### 3.2 Real ancestor evidence: natural topology not reproduced

`scripts/ancprobe.py` ran under the same wrapper right before and right after the three-file gate on each runtime
(`logs/mcp/<profile>/11a-…`, `11b-…`). For each ancestor it records pid, ppid, `/proc/<pid>/stat` starttime ticks, UID
(real/eff/saved/fs), and the errno of an open-then-close (never read) of `/proc/<pid>/environ`. It also records the
current uid/euid (1000/1000). The result was the same before and after, on both runtimes:

| Ancestor | UID | environ open |
|---|---|---|
| python3 (probe) → timeout → bash → zsh → claude → zsh → herdr | 1000 | ok (closed unread) |
| systemd, PID 1 | 0 | **EACCES** |

The only root-owned, unreadable process is PID 1, where ancestor traversal ends by design (PID > 1 termination). In the
earlier owner run, the driver was detached with `nohup`, which put a root-owned WSL `Relay` process in the chain. That
topology does not occur naturally in this session. It was not forced (no reparenting, no chosen parent), and the gate
test's real-process case passed only because every examined ancestor was readable. **The real-ancestor gate remains
unproven.** The synthetic EACCES/EPERM passes are not real-host evidence.

### 3.3 Benchmark (`node tests/hud-mcp/benchmark.mjs`, 600 s each)

The order was declared in `manifest/mcp-benchmark-order.txt` before any run: baseline and candidate alternate,
Node 22 first, profile envproxy. Both trees were freshly built (`bench-build*`) and use the same dependencies. Driver
blob `c36817de…` was checked in both worktrees (`manifest/mcp-benchmark-identity.txt`) and not modified. The driver
prints the aggregates below and throws if cold p95 ≥ 200 or either method p95 ≥ 50, so exit 0 means the gate was met.

| Run | Tree | Exit | cold p95 ms | cold max ms | tools/list p95 | whoami refusal p95 | load1 |
|---|---|---|---|---|---|---|---|
| node22 run1 | base | 0 | 149.0 | 251.9 | 0.418 | 0.396 | 3.03–3.20 |
| node22 run1 | cand | 0 | 167.2 | 277.2 | 0.397 | 0.417 | 2.94–3.03 |
| node22 run2 | base | 0 | 102.2 | 121.2 | 0.430 | 0.398 | 2.79–2.94 |
| node22 run2 | cand | 0 | 106.0 | 126.9 | 0.414 | 0.391 | 2.79 |
| node22 run3 | base | 0 | 104.2 | 120.8 | 0.410 | 0.394 | 2.65–2.79 |
| node22 run3 | cand | 0 | 132.7 | 184.4 | 0.455 | 0.487 | 2.59–2.65 |
| node24 run1 | base | 0 | 138.3 | 153.8 | 0.433 | 0.419 | 2.55–2.59 |
| node24 run1 | cand | 0 | 121.4 | 145.2 | 0.448 | 0.422 | 2.50–2.55 |
| node24 run2 | base | 0 | 119.3 | 144.4 | 0.430 | 0.385 | 2.46–2.50 |
| node24 run2 | cand | 0 | 133.2 | 141.4 | 0.397 | 0.367 | 2.46 |
| node24 run3 | base | 0 | 122.8 | 141.0 | 0.466 | 0.422 | 2.34–2.46 |
| node24 run3 | cand | 0 | 128.4 | 140.8 | 0.404 | 0.423 | 2.34–2.40 |

Each run reports 30 cold samples and 200 calls per method. Limits of this data:
- The driver does not print individual cold samples or p99, so none are reported or invented. Retaining the 30 raw
  samples would require changing the driver, which was not done.
- Node 22 stderr (179 B) is the benchmark process's own UNDICI-EHPA warning (kept raw).
- Not merged, trimmed or selected.
- The 12 historical cloud runs whose cold p95 all failed remain valid history. This different host does not overturn
  them.
- `ast-grep` and `python3` from other sessions were active during the window.

## 4. NODE22-PROXY (`logs/n22/<profile>/`, captures `captures/n22/<profile>/<command>/`)

Each command got a new, empty `NODE_PROXY_EVIDENCE_DIR`.

| Step (limit) | node22-envproxy | node22-noenvproxy-control | node24-envproxy |
|---|---|---|---|
| builds ×3 (600) | 0/0/0 | 0/0/0 | 0/0/0 |
| npm test (1800) | **exit 0**: 2346/2362, 0 fail, 16 skip; mjs 47/47 | **exit 1**: 2344/2362, **2 fail**, 16 skip; mjs not reached | **exit 0**: 2346/2362, 0 fail, 16 skip; mjs 47/47 |
| test:mjs separately (600) | not needed | exit 0, 47/47 | not needed |
| known-flake reruns (900) | — | `b11-cli.test.js` 20/20; `b21-capacity.test.js` 5/5 | — |
| core (900) / visual (600) / hud-mcp (900) | 209+1 skip / 319 / 83+1 skip | same | same |
| format / fixtures (300) / diff (60) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| node-proxy-profile, concurrency 1 (300) | 5/5 | 5/5 | 5/5 |
| hud-link-export + run-process + run-light-leader, concurrency 1 (600) | 76/76 | 76/76 | 76/76 |
| same three files, normal runner (600) | 76/76 | 76/76 | 76/76 |
| HYG2 six-suite (900) | 76/76 | 76/76 | 76/76 |

The three-file and six-suite counts are both 76 by coincidence. The test-name sets differ: the six-suite has 54 names
the three-file set does not. No `--test-name-pattern` was used anywhere.

Control-profile failures: `B11 local resume preserves all parameters, rejects stale/active, replays once through B4`
(b11-cli.test.js:322) and `B21 real-SQLite MCP refusal is stable and never dispatches a launch` (b21-capacity.test.js:59).
Both are `Ledger busy … write-lock budget` / `code: 'ledger_busy'` and both are named in the README's ledger_busy
family. Each suite got one isolated rerun in the same profile and passed. The original npm test result stays exit 1.

Raw captures retained per command: the minimal no-HUD `startup-*` stdout, stderr and json; `export-*` captures (66 per
command that runs hud-link-export); and the synthetic routing cases `routing-{direct,launchGroup}-{upper,lower}-{proxy,
bypass,disabled}`, `…-lost-environment-control`, `routing-group-before-cleanup/final`. Routing uses only test-owned
loopback proxies and targets on ephemeral 127.0.0.1 ports, plus `synthetic.invalid`. Those synthetic values and the
captured bytes are published unchanged (§8). No real proxy, external endpoint or HTTPS/TLS behaviour was exercised.

This local evidence is new exact-candidate evidence. It does not stand in for the old cloud Node 22 hud-mcp ledger_busy
closeout, whose count is not reset. Envproxy, EACCES, routing and separation failures were not treated as flakes.
NODE22-PROXY does not contain MCP-ANCESTOR, and its `test:hud-mcp` passed here (83 + 1 skip) under the readable
ancestry in §2. That is not evidence about the root-owned-ancestor case.

## 5. RUNZ1-KILL (`logs/rk/<profile>/`, captures `captures/rk/<profile>/<command>/`)

Each command got a new, empty `RUNZ1_KILL_EVIDENCE_DIR`, which holds the JSON captures `kill-ladder-<pid>.json` and
`controlled-{live,Q,final}-<pid>.json`.

| Step (limit) | node22-envproxy | node24-envproxy |
|---|---|---|
| builds ×3 (180) | 0/0/0 | 0/0/0 |
| npm test (1200) | not run (Node 24 full suite required) | **exit 1**: 2376/2393, **1 fail**, 16 skip; mjs not reached |
| test:mjs separately (300) | — | exit 0, 47/47 |
| known-flake rerun `b21-capacity.test.js` (600) | — | exit 0, 5/5 |
| core / visual / hud-mcp (600) | — | 209+1 skip / 319 / 83+1 skip |
| format / fixtures (180) / diff (60) | — | 0 / 0 / 0 |
| `run-control-kill-evidence` + `run-control`, concurrency 1 (600) | **exit 0, 44/44** | **exit 0, 44/44** |
| `runz1-process` + `run-control` + `run-process`, normal (600) | **exit 1, 53/54** | exit 0, 54/54 |

- Node 24 npm test failure: `B21 real-SQLite MCP refusal …`, `code: 'ledger_busy'` (README-listed). Its isolated
  rerun passed.
- Node 22 failure: `one-shot group launch preserves argv and stdin EOF, waits for helper exit`
  (run-process.test.js:81), `Unexpected token '(', "(node:8298"... is not valid JSON`. The enabled-proxy Node 22
  startup warning reaches the stream the test parses as JSON. This candidate does not contain the NODE22-PROXY fixture
  change. It is not a listed flake, so it was not rerun. It was not replaced with a no-envproxy run.
- The kill tests that passed include the INT→TERM→KILL ladder, unknown native result, receiptful/receiptless-Q/held
  paths, proof binding and timing, slot/claim/fencing and idempotency. Their JSON captures are retained.
- The three-run instrumentation-only burst and scan-cost measurement were not run (out of scope).
- These passes do not explain the historical 15:57 failure and do not relabel it a flake. The consumed cloud
  resume-expected-run rerun was not repeated.

## 6. Not run / out of scope

- RUNZ1-KILL full README set on Node 22: not required; the prompt asks for the Node 24 full suite plus the two focused
  commands on both runtimes.
- MCP/NODE22 negative-control mutations and baseline-failing controls: implementer evidence, not run here (no source
  mutation).
- NEXT, old PERF and P065 (including its interrupted WIP and cloud process state): not touched. A local pass says
  nothing about whether cloud processes ended.
- Formal supported-WSL P-06-7/B14 qualification: not claimed.

## 7. Still red, unknown, or open

- **Red on the exact candidates:** MCP-ANCESTOR npm test on Node 22 envproxy (12 failures); RUNZ1-KILL Node 22 envproxy
  run-process case; the npm test exit 1 results with listed-flake failures (NODE22 control, RUNZ1-KILL Node 24). README
  allows those flake reruns, but the original runs are not green.
- **Unknown:** real root-owned/unreadable-ancestor behaviour (§3.2); the cause of the historical RUNZ1 15:57 failure;
  whether the ledger_busy contention reflects host load.
- **Open for all three:** Oracle acceptance; merged-tree gates. Combining these candidates was not attempted.

## 8. Redaction, hashes, files

Raw originals are kept locally. The published copy:
- replaces local paths, the short temp root, host/user name and email;
- replaces each distinct `identity-sha256-<64 hex>` value (the tests' own one-way scope/boot/PID-domain identities in
  the RUNZ1-KILL captures and logs) with a consistent `identity-R<n>` token, so every equality relation is kept;
- leaves numbers, timings, exit codes, test names, failure text, PIDs, synthetic loopback ports and all NODE22-PROXY
  capture bytes unchanged. Where a capture had no private value, it is byte-identical to the original; see
  `redaction-manifest.txt` for which files changed.

The real proxy address and NO_PROXY list never appear in any log, capture or manifest. Process arguments were never
recorded. `RAW-SHA256SUMS` hashes the unredacted originals and `SHA256SUMS` the published files. The two are not
claimed to be byte-identical. The RUNZ1-KILL captures' internal `originalRecordsSha256` refers to the test's own
pre-publication records and is unchanged.

Files: `SUMMARY.json` (every command: exit, signal/timeout, UTC, limit, counts, failing tests; benchmark outputs);
`profile-plan.json` (declared before execution); `commands.sh` (exact scripts); `manifest/` (results.tsv, identities,
environment, source/dependency/generated manifests, clean records, source checks, benchmark order);
`logs/<package>/<profile>/<id>.{stdout,stderr,meta.txt,ancestry.txt,monitor.txt}`; `captures/<package>/<profile>/<command>/`.
