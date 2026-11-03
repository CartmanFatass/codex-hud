# Local verification of dots/hyg2, dots/runz1 and dots/b10b-s3f-perf (run .)

Owner-requested independent local verification, 2026-11-03, run by a local Claude Code session on the owner's WSL machine.
Goal: verify and record. Nothing was fixed, merged or accepted; no source, test, threshold, permission or system setting
was changed. This report states results only; acceptance stays with the Oracle per `AGENTS.md`.

All paths below are relative to this directory unless stated. `<VERIFY_ROOT>`, `<HOME>`, `<REPO>` and `<host>` replace
private local paths and names (see §9).

## 1. Short result

| Target | Pinned commit | README check set | Brief-specific extra tests |
|---|---|---|---|
| HYG2 `dots/hyg2` | `2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31` | **Not green.** Every step passes on Node 24 and on Node 22 without `NODE_USE_ENV_PROXY`, except `test:hud-mcp`: 1 failure (`int hud-mcp physical caller registration…`, `EACCES` on `/proc/<pid>/environ` of a root-owned ancestor; §5.1). On Node 22 with `NODE_USE_ENV_PROXY=1` also 13 unit failures (§5.2). | Focused HYG2 command: PASS 76/76 on Node 24 and on Node 22 without `NODE_USE_ENV_PROXY`; FAIL 65/76 on Node 22 with `NODE_USE_ENV_PROXY=1` (§5.2). |
| RUNZ1 `dots/runz1` | `86ca8887fcfb331750ec6dc5518d69134cb795e4` | **Not green.** Same single `test:hud-mcp` failure in all three environments; on Node 22 with `NODE_USE_ENV_PROXY=1` also 12 unit failures (§5.2) and 2 `ledger_busy` known flakes that passed when rerun alone (§5.3). | Focused RUNZ1 command: PASS 54/54 on Node 22 without `NODE_USE_ENV_PROXY`; **FAIL 53/54 on Node 24** (`cancel escalates INT then TERM then KILL…`, not a listed known flake, not rerun; §5.4); FAIL 53/54 on Node 22 with `NODE_USE_ENV_PROXY=1` (§5.2). Real-process scenarios required by the brief passed in every run (§3.2). Scan-cost measured 3× per runtime (§6). |
| B10B-S3F-PERF `dots/b10b-s3f-perf` | `94969100ec85a41f93eb2a0d677aefc886290691` | **Not green.** Same single `test:hud-mcp` failure in all three environments; on Node 22 with `NODE_USE_ENV_PROXY=1` also 12 unit failures (§5.2). | Focused B10B command: PASS 381/381 in all three environments. Strict benchmark: series A 12/12 candidate+baseline runs, series B 12/12 (§7). |

The previously reported dots-executor blockers (AF_UNIX `listen EPERM`, `ptrace(TRACEME)` EPERM, missing
`/proc/<pid>/task/<tid>/children`) did **not** occur here: all three capabilities work on this host (§2.3), and the unit
stage plus `test:mjs` pass on all three branches on Node 24 and on Node 22 without `NODE_USE_ENV_PROXY`.

## 2. Environment and identities

### 2.1 Host

See `manifest/environment.txt` (raw). Summary: WSL 2.7.11.0, kernel 6.18.33.2-microsoft-standard-WSL2 x86_64, Ubuntu
24.04.4 LTS, Windows 10.0.26300, AMD Ryzen 7 8745H (16 logical CPUs), 14.5 GiB RAM. Worktrees, temp HOMEs and `/tmp`
are on the WSL native ext4 root (`/dev/sdd`), not `/mnt/c` and not tmpfs.

Runtimes:
- Node **v24.22.1** / npm 11.19.1 (nvm-installed binary).
- Node **v22.23.4** / npm 10.9.9: official `node-v22.23.4-linux-x64.tar.xz` downloaded for this run into
  `<VERIFY_ROOT>/runtimes/`, SHA-256 `1805bcd3…e9ce` checked against nodejs.org `SHASUMS256.txt` (OK). No system install.

Dependencies: `npm ci` once per worktree with Node 24/npm 11.19.1; identical `package-lock.json` (SHA-256 `98a7e2d3…3294`)
and identical installed package manifests in all four worktrees. Pure-JS dependencies only (typescript, prettier,
chokidar, @iarna/toml, @types/node), so the same install serves both runtimes. The first `npm ci` attempt failed with a
network error because the clean environment dropped the proxy variables; it is kept in `logs/setup/*attempt1-noproxy.log`.

### 2.2 Targets (pinned at first fetch, 2026-11-03T15:41Z)

| Name | Branch | Commit | Tree | Relation to `universal-hud` |
|---|---|---|---|---|
| hyg2 | `dots/hyg2` | `2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31` | `50438e87a1915d5e739a4a4d926cc9b1e7e85724` | merge-base `f1e2a84`; branch-only 18 commits |
| runz1 | `dots/runz1` | `86ca8887fcfb331750ec6dc5518d69134cb795e4` | `da3e386e3512736f3078d0fd9c7b85a868f83f6d` | merge-base `f1e2a84`; branch-only 11 commits |
| perf | `dots/b10b-s3f-perf` | `94969100ec85a41f93eb2a0d677aefc886290691` | `c91d20549ccc1df9fe0d8860478f76c892d17db2` | merge-base `f1e2a84`; branch-only 35 commits |
| base | `dots/b10b-s3f` | `bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60` | `f9bcdc5c069156d655ca7d3cd7a08590e74b8eec` | baseline required by the PERF brief (matches the brief's SHA) |

None of the branches contains `universal-hud` commits after `f1e2a84`; `universal-hud` was `2249ab5` when the binding
documents were read and had moved to `f261242`/`42aadb8` (documentation only) by the end. Raw: `manifest/refs.txt`.

After pinning, `dots/b10b-s3f-perf` advanced to `e5ccee3`, which only adds `docs/cloud/handoff/b10b-s3f-perf-review-1.md`.
Tests stayed on the pinned `9496910`; source, tests and benchmark are identical between the two.

**Candidate source identity (PERF brief, step 3 of the request).** `5f2134d` is not present locally or on any remote
ref, so it could not be inspected directly. `d9225d2` (the published code commit) has tree
`f3fff50d66c62effd9a169e8ccca73c6e21833cb`, exactly the tree recorded for `5f2134d` in
`b10b-s3f-perf-implementation.md` and the dispatcher log; the `projection.ts` and regression-test SHA-256 values in that
report also match `d9225d2`. The ten commits `d9225d2..9496910` change only `docs/cloud/handoff/`. The benchmark blob is
`371b8f784229636f66e88434c422484dd85251eb` on both baseline and candidate, as the brief requires. The tested tree is the
actual pinned head; the equivalence is recorded, not relied on.

### 2.3 Capabilities (raw: `manifest/capability-probe-node22.json`, `…-node24.json`)

Probe `scripts/capprobe.mjs` under the same isolated wrapper, both runtimes: AF_UNIX listen+connect OK; `ptrace(PTRACE_TRACEME)`
returns 0 and `PTRACE_ATTACH` on an own child returns 0 (`kernel.yama.ptrace_scope=1`); `/proc/<pid>/task/<pid>/children`
lists the spawned child. Nothing was bypassed or reconfigured.

### 2.4 Isolation and wrapper

Every build, test and benchmark ran through `scripts/lib.sh` `iso()`:
`env -i PATH=<node bin>:/usr/bin:/bin HOME=$(mktemp -d /tmp/hudv-home.XXXXXX) TMPDIR=/tmp LANG=C.UTF-8 TERM=xterm-256color npm_config_cache=<VERIFY_ROOT>/npm-cache …`

- `HUD_HOME` unset (README: `env -u HUD_HOME`), so the effective `HUD_HOME` is `<fresh temp HOME>/.hud` for every process.
  The later route ruling (`universal-hud` `42aadb8`, line 69) asks for fresh temporary HOME and HUD_HOME; this is how the
  README form satisfies it. `NODE_OPTIONS` unset in the invoking shell and inside the wrapper.
- No `HERDR_*`, `CLAUDE_*`, `NO_COLOR` or `FORCE_COLOR`; `~/.local/bin` (real harness CLIs) not on `PATH`. Real `~/.hud`,
  `~/.claude`, `~/.codex*`, `~/.pi` were not read or written by this verification.
- **Proxy policy changed during the run** (`manifest/proxy-policy-change.txt`): before 2026-11-03T16:00:00Z no proxy variable
  was passed; from then on, at the owner's request, `HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY` (both cases) and
  `NODE_USE_ENV_PROXY` were passed. The owner then chose an additional Node 22 rerun without `NODE_USE_ENV_PROXY` (other
  proxy variables kept). Each step's start time in `manifest/results.tsv` shows which policy applied.
- The drivers ran detached (`nohup`); their parent became the root-owned WSL `Relay` process. No Claude Code, Herdr or
  harness process was in the tests' ancestry. This matters for §5.1.
- Worktrees: four detached `git worktree`s under `<VERIFY_ROOT>/wt/`. `git status --porcelain` before and after every
  check sequence shows only ` M node_modules/.package-lock.json` (written by `npm ci`); HEADs unchanged
  (`logs/*/*/git-status-*.txt`). The owner's own working tree was not used for tests.

## 3. README check set and focused commands

Each command ran separately with its own log `logs/<target>/<env>/<step>.log` (header: target, runtime, commit, command,
start; footer: end, exit). Every outcome is in `manifest/results.tsv` and `SUMMARY.json`. `npm test` runs build,
build:test, test:unit and test:mjs; its two summary blocks are unit then mjs.

Environments: **node24**: v24.22.1 (steps before 16:00Z without proxy variables, later steps with them);
**node22**: v22.23.4 with all proxy variables incl. `NODE_USE_ENV_PROXY=1`; **node22-noenvproxy**: v22.23.4 without
`NODE_USE_ENV_PROXY`.

`04b-test-mjs-separate`: on node22, `npm test` stopped at the unit stage, so `test:mjs` was run separately afterwards (a
detection bug in the driver skipped it in the first pass; it was run as a supplementary step at 16:37Z with the same env policy as that pass, i.e. `NODE_USE_ENV_PROXY=1`).

### 3.1 HYG2

| Step | Command | Node v24.22.1 | Node v22.23.4 (envproxy) | Node v22.23.4 (no envproxy) |
|---|---|---|---|---|
| 01-build | `npm run build` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 02-build-test | `npm run build:test` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 03-build-hud-mcp | `npm run build:hud-mcp` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 04-npm-test | `npm test` | **PASS** (exit 0): 2341/2357 pass, 0 fail, 16 skip; 47/47 pass, 0 fail, 0 skip | **FAIL** (exit 1): 2328/2357 pass, 13 fail, 16 skip | **PASS** (exit 0): 2341/2357 pass, 0 fail, 16 skip; 47/47 pass, 0 fail, 0 skip |
| 04b-test-mjs-separate | `npm run test:mjs (separately)` | not run (npm test reached test:mjs) | **PASS** (exit 0): 47/47 pass, 0 fail, 0 skip | not run (npm test reached test:mjs) |
| 05-test-core | `npm run test:core` | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip |
| 06-test-visual | `npm run test:visual` | **PASS** (exit 0): 319/319 pass, 0 fail, 0 skip | **PASS** (exit 0): 319/319 pass, 0 fail, 0 skip | **PASS** (exit 0): 319/319 pass, 0 fail, 0 skip |
| 07-test-hud-mcp | `npm run test:hud-mcp` | **FAIL** (exit 1): 82/84 pass, 1 fail, 1 skip | **FAIL** (exit 1): 82/84 pass, 1 fail, 1 skip | **FAIL** (exit 1): 82/84 pass, 1 fail, 1 skip |
| 08-format-check | `npm run format:check` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 09-check-fixtures | `npm run check:fixtures` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 10-git-diff-check | `git diff --check` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |

Focused (`node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/process-client.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js`):

| Runtime | Result | Counts | Failing tests | Log |
|---|---|---|---|---|
| Node v24.22.1 | **PASS** (exit 0) | 76/76 pass, 0 fail | — | `logs/hyg2/node24/11-focused-hyg2.log` |
| Node v22.23.4, NODE_USE_ENV_PROXY=1 passed | **FAIL** (exit 1) | 65/76 pass, 11 fail | hud help and strict argument refusals never access or create a ledger<br>hud rejects missing, relative, public, symlink, file and foreign-owned HUD_HOME without writes<br>hud missing and unreadable ledgers fail with no stdout or initialization<br>hud rejects symlink HUD_HOME with trailing slashes and dot components in real processes<br>hud unsearchable HUD_HOME returns home exit 3 while an unreadable ledger returns exit 4<br>hud reports asynchronous stdout failures for export and help without Node stack traces<br>hud real launcher matches the query JSON and leaves database/WAL bytes and mtime unchanged<br>hud refuses unknown ledger versions without migrating or emitting JSON<br>hud producer validation refusal writes no partial JSON<br>hud defaults to ~/.hud only inside an isolated synthetic HOME<br>hud export leaves fresh-process raw stderr free of SQLite initialization warnings | `logs/hyg2/node22/11-focused-hyg2.log` |
| Node v22.23.4, NODE_USE_ENV_PROXY not passed (owner-chosen rerun) | **PASS** (exit 0) | 76/76 pass, 0 fail | — | `logs/hyg2/node22-noenvproxy/11-focused-hyg2.log` |

HYG2 item 1's new test `hud export leaves fresh-process raw stderr free of SQLite initialization warnings` passes on
Node 24 and Node 22 without `NODE_USE_ENV_PROXY`. Its Node 22 failure with `NODE_USE_ENV_PROXY=1` shows the undici EHPA
proxy warning on stderr, not a SQLite warning.

### 3.2 RUNZ1

| Step | Command | Node v24.22.1 | Node v22.23.4 (envproxy) | Node v22.23.4 (no envproxy) |
|---|---|---|---|---|
| 01-build | `npm run build` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 02-build-test | `npm run build:test` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 03-build-hud-mcp | `npm run build:hud-mcp` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 04-npm-test | `npm test` | **PASS** (exit 0): 2353/2369 pass, 0 fail, 16 skip; 47/47 pass, 0 fail, 0 skip | **FAIL** (exit 1): 2341/2369 pass, 12 fail, 16 skip | **PASS** (exit 0): 2353/2369 pass, 0 fail, 16 skip; 47/47 pass, 0 fail, 0 skip |
| 04b-test-mjs-separate | `npm run test:mjs (separately)` | not run (npm test reached test:mjs) | **PASS** (exit 0): 47/47 pass, 0 fail, 0 skip | not run (npm test reached test:mjs) |
| 05-test-core | `npm run test:core` | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip |
| 06-test-visual | `npm run test:visual` | **PASS** (exit 0): 319/319 pass, 0 fail, 0 skip | **PASS** (exit 0): 319/319 pass, 0 fail, 0 skip | **PASS** (exit 0): 319/319 pass, 0 fail, 0 skip |
| 07-test-hud-mcp | `npm run test:hud-mcp` | **FAIL** (exit 1): 82/84 pass, 1 fail, 1 skip | **FAIL** (exit 1): 80/84 pass, 3 fail, 1 skip | **FAIL** (exit 1): 82/84 pass, 1 fail, 1 skip |
| 08-format-check | `npm run format:check` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 09-check-fixtures | `npm run check:fixtures` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 10-git-diff-check | `git diff --check` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |

Focused (`node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js`):

| Runtime | Result | Counts | Failing tests | Log |
|---|---|---|---|---|
| Node v24.22.1 | **FAIL** (exit 1) | 53/54 pass, 1 fail | cancel escalates INT then TERM then KILL; lost KILL wait remains unknown without complete scope proof (2155.755083ms) | `logs/runz1/node24/11-focused-runz1.log` |
| Node v22.23.4, NODE_USE_ENV_PROXY=1 passed | **FAIL** (exit 1) | 53/54 pass, 1 fail | one-shot group launch preserves argv and stdin EOF, waits for helper exit | `logs/runz1/node22/11-focused-runz1.log` |
| Node v22.23.4, NODE_USE_ENV_PROXY not passed (owner-chosen rerun) | **PASS** (exit 0) | 54/54 pass, 0 fail | — | `logs/runz1/node22-noenvproxy/11-focused-runz1.log` |

Brief acceptance scenarios, per test name, in all six runs that contain them (`npm test` and focused × node24, node22,
node22-noenvproxy): `RUNZ1 true zombie-only own session ends while the kernel still holds its PGID`, `RUNZ1 fork after
the first census snapshot cannot end a live group` (race 1), `RUNZ1 same-session outsider can join a zombie-held PGID
and never produces gone` (race 2), `RUNZ1 visible shared-session zombie stays unknown until ESRCH despite a living
session outsider` and `run-control` `supervisor death receiptless Q uses registered stamp…`: **pass in all six**.
`cancel escalates INT then TERM then KILL…` passed in five of the six and failed once (§5.4).

### 3.3 B10B-S3F-PERF candidate

| Step | Command | Node v24.22.1 | Node v22.23.4 (envproxy) | Node v22.23.4 (no envproxy) |
|---|---|---|---|---|
| 01-build | `npm run build` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 02-build-test | `npm run build:test` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 03-build-hud-mcp | `npm run build:hud-mcp` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 04-npm-test | `npm test` | **PASS** (exit 0): 2448/2464 pass, 0 fail, 16 skip; 47/47 pass, 0 fail, 0 skip | **FAIL** (exit 1): 2436/2464 pass, 12 fail, 16 skip | **PASS** (exit 0): 2448/2464 pass, 0 fail, 16 skip; 47/47 pass, 0 fail, 0 skip |
| 04b-test-mjs-separate | `npm run test:mjs (separately)` | not run (npm test reached test:mjs) | **PASS** (exit 0): 47/47 pass, 0 fail, 0 skip | not run (npm test reached test:mjs) |
| 05-test-core | `npm run test:core` | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip | **PASS** (exit 0): 209/210 pass, 0 fail, 1 skip |
| 06-test-visual | `npm run test:visual` | **PASS** (exit 0): 331/331 pass, 0 fail, 0 skip | **PASS** (exit 0): 331/331 pass, 0 fail, 0 skip | **PASS** (exit 0): 331/331 pass, 0 fail, 0 skip |
| 07-test-hud-mcp | `npm run test:hud-mcp` | **FAIL** (exit 1): 82/84 pass, 1 fail, 1 skip | **FAIL** (exit 1): 82/84 pass, 1 fail, 1 skip | **FAIL** (exit 1): 82/84 pass, 1 fail, 1 skip |
| 08-format-check | `npm run format:check` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 09-check-fixtures | `npm run check:fixtures` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |
| 10-git-diff-check | `git diff --check` | **PASS** (exit 0) | **PASS** (exit 0) | **PASS** (exit 0) |

Focused (`node --test --test-concurrency=1 dist-test/tests/unit/b10b*.test.js`, includes R1's direct-child and the
fifth-sub-row tests and the new `b10b-s3-perf-regression` suite; the strict benchmark file runs in its non-strict mode here):

| Runtime | Result | Counts | Failing tests | Log |
|---|---|---|---|---|
| Node v24.22.1 | **PASS** (exit 0) | 381/381 pass, 0 fail | — | `logs/perf/node24/11-focused-b10b.log` |
| Node v22.23.4, NODE_USE_ENV_PROXY=1 passed | **PASS** (exit 0) | 381/381 pass, 0 fail | — | `logs/perf/node22/11-focused-b10b.log` |
| Node v22.23.4, NODE_USE_ENV_PROXY not passed (owner-chosen rerun) | **PASS** (exit 0) | 381/381 pass, 0 fail | — | `logs/perf/node22-noenvproxy/11-focused-b10b.log` |

## 4. Skipped and not-run items

- **Skipped by the suites themselves** (opt-in env gates, not part of the README check set; not run): 16 unit tests in
  every `npm test` (B6 real hud-run matrix `B6_PROCESS=1` ×10, `B6_PERF=1`, `B12_BENCHMARK=1`, `HUD_EXPORT_BENCHMARK=1` ×2,
  `B22_PROCESS=1`, `HUD_LEDGER_BENCHMARK=1`), 1 in `test:core` (`HUD_LEDGER_BENCHMARK=1`) and 1 in `test:hud-mcp`
  (`HUD_B45_BENCH=1`). Raw: `# SKIP` lines in the logs. (A `# ok 3 - B21 … # SKIP Run B21_PERF=1` line inside the unit
  log is a nested child-runner comment, not one of the 16.)
- **Local-only, deliberately not run**: `npm run test:herdr`, `tests/integration/*real-tmux.sh`, `tests/probes/*.sh`,
  `B13_REAL=1`, real-harness (logged-in CLI) tests, `install.sh`/`uninstall.sh`, Hermes. Excluded by the request.
- **Not claimed**: this is not the formal P-06-7 qualification; numbers are labelled with this host.
- **Not rerun**: the RUNZ1 Node 24 focused failure (§5.4) — not a listed known flake.

## 5. Failures

### 5.1 `test:hud-mcp`: `int hud-mcp physical caller registration persists real procStart/cwd without logical authority`

All three branches, all three environments (9/9 runs). Raw error:
`EACCES: permission denied, open '/proc/29952/environ'` at `LinuxProcessReader.get` ← `findHarness` ← `registerCaller`
(`packages/hud-mcp/src/process.ts`). `findHarness` walks up to eight ancestors of the test process looking for a
harness. PID 29952 is the WSL `Relay(…)` process, owned by **root**; the drivers were reparented to it (§2.4). Ancestor
chain at the time: test → node --test → npm → env → bash wrappers → driver → `Relay` (root) → `SessionLeader` (root) →
`init`. The test result therefore depends on which processes are above the test; it was not altered, rerun under a
different parent or worked around. Whether this is a product defect (EACCES on an unrelated ancestor aborts
registration) or a test-topology assumption is for the Oracle. This test is not in the README known-flake list.

### 5.2 Node 22 with `NODE_USE_ENV_PROXY=1`

With `NODE_USE_ENV_PROXY=1`, Node 22.23.4 writes
`(node:<pid>) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.` to the stderr
of every Node process (Node 24.22.1 does not). Tests that assert empty stderr, exact bytes or parse JSON from child
output fail: 10 `hud link export` tests (+1 HYG2-only test on hyg2), `run-light-leader` `light leader preserves exact brief
bytes and EOF on workload fd0` (bytes start with `(node:`), `run-process` `one-shot group launch preserves argv and stdin
EOF…` (`Unexpected token '(', "(node:…" is not valid JSON`). Exact lists per run: `SUMMARY.json` → `failing_tests`.
The same steps pass on the owner-chosen rerun without that variable (node22-noenvproxy). The failing runs are kept.

### 5.3 Known flakes (README rule: rerun once alone, keep both)

`runz1` node22 `test:hud-mcp` also failed `delegate_status and delegate_spawn carry the §5.2 advice…` (`b20-advice`) and
`B45 accepted spawn is atomic…` (`delegation`), both `ledger_busy` (README known-flake family). Reruns alone:
`node --test packages/hud-mcp/dist/tests/hud-mcp/b20-advice.test.js` → exit 0; `… delegation.test.js` → exit 0
(`logs/runz1/node22/07r1-*.log`, `07r2-*.log`). The original `test:hud-mcp` run stays FAIL (it also contains §5.1).

### 5.4 RUNZ1 focused on Node 24: `cancel escalates INT then TERM then KILL; lost KILL wait remains unknown without complete scope proof`

`AssertionError: false !== true` at `dist-test/tests/unit/run-control.test.js:360:20`, duration 2155 ms
(`logs/runz1/node24/11-focused-runz1.log`, 15:57Z, before the proxy change). The same test passed in runz1 node24
`npm test`, and in node22 / node22-noenvproxy `npm test` and focused runs. It is not on the README known-flake list, so it
was not rerun; both the failure and the passes are recorded. Root cause not investigated (verification only).

## 6. RUNZ1 scan cost (`node tests/int/runz1-perf.mjs`, three fresh processes per runtime)

Run after `npm run build`, n = 1000 per population after 100 warm-ups, nearest rank, wall clock (script's own method).
Runs at 16:20–16:24Z (Node 22 then Node 24) with all proxy variables passed. Logs: `logs/perf-series/runz1-perf-*.log` (host name in the JSON is
redacted). Milliseconds:

| Run | Exit | Population | n | p50 | p95 | p99 | max | refusals |
|---|---|---|---|---|---|---|---|---|
| node22-run1 | 0 | full_proof | 1000 | 13.873 | 17.374 | 20.509 | 34.560 | 22 |
| node22-run1 | 0 | additional_complete_scan | 1000 | 3.438 | 4.277 | 5.221 | 9.819 | 5 |
| node22-run1 | 0 | existing_inspection | 1000 | 3.513 | 4.618 | 5.644 | 7.515 | 0 |
| node22-run1 | 0 | churn_full_proof | 1000 | 11.147 | 14.154 | 15.604 | 28.016 | 966 |
| node22-run1 | 0 | esrch_full_proof | 1000 | 3.567 | 4.489 | 5.600 | 11.477 | 0 |
| node22-run2 | 0 | full_proof | 1000 | 11.848 | 14.654 | 16.681 | 31.750 | 28 |
| node22-run2 | 0 | additional_complete_scan | 1000 | 1.922 | 2.449 | 3.348 | 4.455 | 3 |
| node22-run2 | 0 | existing_inspection | 1000 | 1.922 | 2.380 | 3.283 | 5.859 | 0 |
| node22-run2 | 0 | churn_full_proof | 1000 | 6.511 | 8.115 | 9.359 | 11.321 | 890 |
| node22-run2 | 0 | esrch_full_proof | 1000 | 2.185 | 2.773 | 3.754 | 4.414 | 0 |
| node22-run3 | 0 | full_proof | 1000 | 7.033 | 9.522 | 11.196 | 13.107 | 17 |
| node22-run3 | 0 | additional_complete_scan | 1000 | 2.483 | 3.664 | 4.296 | 5.552 | 6 |
| node22-run3 | 0 | existing_inspection | 1000 | 2.124 | 2.935 | 3.394 | 4.028 | 0 |
| node22-run3 | 0 | churn_full_proof | 1000 | 7.053 | 10.129 | 11.272 | 12.287 | 878 |
| node22-run3 | 0 | esrch_full_proof | 1000 | 2.595 | 3.880 | 4.584 | 5.053 | 0 |
| node24-run1 | 0 | full_proof | 1000 | 8.300 | 10.217 | 11.797 | 13.725 | 19 |
| node24-run1 | 0 | additional_complete_scan | 1000 | 2.140 | 2.917 | 3.279 | 3.932 | 5 |
| node24-run1 | 0 | existing_inspection | 1000 | 2.286 | 3.175 | 3.819 | 4.632 | 0 |
| node24-run1 | 0 | churn_full_proof | 1000 | 9.117 | 14.038 | 15.458 | 17.390 | 920 |
| node24-run1 | 0 | esrch_full_proof | 1000 | 4.058 | 5.754 | 7.317 | 13.937 | 1 |
| node24-run2 | 0 | full_proof | 1000 | 14.274 | 17.322 | 19.853 | 23.462 | 25 |
| node24-run2 | 0 | additional_complete_scan | 1000 | 3.921 | 5.789 | 7.191 | 9.888 | 7 |
| node24-run2 | 0 | existing_inspection | 1000 | 3.937 | 5.460 | 7.639 | 29.158 | 0 |
| node24-run2 | 0 | churn_full_proof | 1000 | 11.797 | 15.830 | 19.804 | 38.312 | 974 |
| node24-run2 | 0 | esrch_full_proof | 1000 | 4.200 | 6.182 | 7.942 | 12.080 | 0 |
| node24-run3 | 0 | full_proof | 1000 | 14.217 | 17.005 | 19.743 | 62.957 | 32 |
| node24-run3 | 0 | additional_complete_scan | 1000 | 3.916 | 5.711 | 7.222 | 10.480 | 3 |
| node24-run3 | 0 | existing_inspection | 1000 | 4.095 | 6.078 | 8.208 | 15.143 | 0 |
| node24-run3 | 0 | churn_full_proof | 1000 | 11.408 | 15.798 | 18.542 | 26.729 | 969 |
| node24-run3 | 0 | esrch_full_proof | 1000 | 4.122 | 6.006 | 8.128 | 18.070 | 0 |

`refusals` counts conservative proof refusals inside the timing population (the script's definition). Host load was
not controlled (see §8).

## 7. B10B strict performance (`B10B_PERF=1 node --test dist-test/tests/unit/b10b-s3-perf.test.js`)

Baseline `dots/b10b-s3f@bd7e77a0`, candidate `dots/b10b-s3f-perf@9496910` (source = `d9225d2`), same host, same
dependency install, unmodified benchmark (blob `371b8f78…`), fresh `npm run build && npm run build:test` of both
immediately before series A; `dist` provenance (SHA-256 of generated files) in `manifest/dist-provenance-*.txt` —
identical before series A and series B, and the candidate's `projection.js` differs from the baseline's. Run order
declared before execution (`manifest/b10b-perf-order.txt`, `…-seriesB.txt`): per runtime, run 1..3, baseline then
candidate. Each run is a fresh process with a fresh temp HOME. Both series ran with all proxy variables passed
(incl. `NODE_USE_ENV_PROXY=1`, so Node 22 printed the EHPA warning; it is outside the measured code).

Gates (unchanged): compact and rich no-change p99 ≤ 2 ms; compact changed p99 ≤ 10 ms; rich changed p99 ≤ 15 ms.
All populations (incl. the not-asserted diagnostics) with p50/p95/p99/max/n per run: `SUMMARY.json` → `b10b_perf`.

### 7.1 Series A (16:24–16:36Z), before/after `ps` snapshots only

| # | Run | Side | Exit | compact no-change p99 (≤2) | rich no-change p99 (≤2) | compact changed p99 (≤10) | rich changed p99 (≤15) | Load (1 min) |
|---|---|---|---|---|---|---|---|---|
| 1 | node22-run1-base | baseline | 0 | 0.732 | 0.658 | 5.119 | 4.634 | before 11.56 / after 5.79 |
| 2 | node22-run1-cand | candidate | 0 | 0.684 | 0.647 | 3.813 | 4.508 | before 5.79 / after 7.29 |
| 3 | node22-run2-base | baseline | 1 | 1.351 | 0.858 | 14.319 **OVER** | 13.320 | before 7.29 / after 11.68 |
| 4 | node22-run2-cand | candidate | 0 | 0.766 | 0.790 | 4.641 | 13.610 | before 11.68 / after 9.38 |
| 5 | node22-run3-base | baseline | 0 | 0.714 | 0.676 | 4.573 | 4.611 | before 9.38 / after 4.90 |
| 6 | node22-run3-cand | candidate | 0 | 0.734 | 0.657 | 4.213 | 7.085 | before 4.90 / after 3.73 |
| 7 | node24-run1-base | baseline | 0 | 0.528 | 0.271 | 8.695 | 8.878 | before 3.73 / after 2.64 |
| 8 | node24-run1-cand | candidate | 0 | 0.548 | 0.303 | 6.770 | 8.628 | before 2.64 / after 2.07 |
| 9 | node24-run2-base | baseline | 0 | 0.449 | 0.224 | 7.735 | 8.476 | before 2.07 / after 2.17 |
| 10 | node24-run2-cand | candidate | 0 | 0.546 | 0.699 | 7.013 | 8.447 | before 2.17 / after 2.69 |
| 11 | node24-run3-base | baseline | 0 | 0.645 | 0.227 | 8.079 | 9.217 | before 2.69 / after 1.89 |
| 12 | node24-run3-cand | candidate | 0 | 0.548 | 0.239 | 7.328 | 9.168 | before 1.89 / after 1.81 |

Ranges, series A (ms):

| Runtime | Side | Population | p50 range | p95 range | p99 range | max range | Runs within gate |
|---|---|---|---|---|---|---|---|
| node22 | baseline | compact no-change | 0.084–0.162 | 0.165–0.318 | 0.714–1.351 | 0.972–4.532 | 3/3 |
| node22 | baseline | rich no-change | 0.084–0.168 | 0.159–0.288 | 0.658–0.858 | 0.961–1.165 | 3/3 |
| node22 | baseline | compact changed | 1.298–2.351 | 3.731–9.437 | 4.573–14.319 | 5.922–17.051 | 2/3 |
| node22 | baseline | rich changed | 1.354–2.494 | 3.970–10.051 | 4.611–13.320 | 5.632–20.696 | 3/3 |
| node22 | candidate | compact no-change | 0.080–0.094 | 0.184–0.209 | 0.684–0.766 | 1.136–1.613 | 3/3 |
| node22 | candidate | rich no-change | 0.082–0.102 | 0.161–0.239 | 0.647–0.790 | 1.021–1.063 | 3/3 |
| node22 | candidate | compact changed | 1.236–1.529 | 3.177–3.753 | 3.813–4.641 | 6.024–6.194 | 3/3 |
| node22 | candidate | rich changed | 1.356–2.782 | 3.963–9.629 | 4.508–13.610 | 5.716–20.083 | 3/3 |
| node24 | baseline | compact no-change | 0.070–0.077 | 0.149–0.163 | 0.449–0.645 | 0.907–1.207 | 3/3 |
| node24 | baseline | rich no-change | 0.076–0.079 | 0.133–0.144 | 0.224–0.271 | 0.883–0.968 | 3/3 |
| node24 | baseline | compact changed | 1.033–1.202 | 1.824–2.074 | 7.735–8.695 | 10.276–11.924 | 3/3 |
| node24 | baseline | rich changed | 1.179–1.480 | 2.002–2.876 | 8.476–9.217 | 10.782–19.658 | 3/3 |
| node24 | candidate | compact no-change | 0.074–0.081 | 0.164–0.184 | 0.546–0.548 | 0.934–2.205 | 3/3 |
| node24 | candidate | rich no-change | 0.077–0.082 | 0.142–0.151 | 0.239–0.699 | 0.950–5.505 | 3/3 |
| node24 | candidate | compact changed | 1.046–1.190 | 1.645–2.118 | 6.770–7.328 | 8.124–12.519 | 3/3 |
| node24 | candidate | rich changed | 1.148–1.363 | 1.816–2.385 | 8.447–9.168 | 9.983–10.424 | 3/3 |

Interference in series A (not started by this verification): the snapshots show `chrome-headless` at ~1100 % CPU at the
end of node22 run1-cand, `npm exec vite build` plus `python3`/`MainThread` processes at ~260 % CPU and 1-min load up to
11.7 around node22 run2 (baseline and candidate), and a `python3` at ~95 % at the start of node24 run1-base. Node22
run2-base is the only failing run (compact changed p99 14.319 ms > 10 ms; its compact-changed p50 2.351 ms is ~1.6–1.8× the other node22 baseline runs). Series
A is kept unchanged.

### 7.2 Series B (16:49–17:01Z), replacement series with a continuous 1 s sampler

Declared after series A showed interference and before execution, same order and env policy
(`manifest/b10b-perf-order-seriesB.txt.note`). Sampler output per run: `logs/perf-series-B/*.monitor.txt`.

| # | Run | Side | Exit | compact no-change p99 (≤2) | rich no-change p99 (≤2) | compact changed p99 (≤10) | rich changed p99 (≤15) | Load (1 min) |
|---|---|---|---|---|---|---|---|---|
| 1 | B-node22-run1-base | baseline | 0 | 0.802 | 0.795 | 6.083 | 6.018 | 1.92–3.00 (63 samples) |
| 2 | B-node22-run1-cand | candidate | 0 | 0.728 | 0.874 | 5.731 | 6.340 | 2.93–3.44 (63 samples) |
| 3 | B-node22-run2-base | baseline | 0 | 0.781 | 0.735 | 6.261 | 6.358 | 3.40–4.65 (61 samples) |
| 4 | B-node22-run2-cand | candidate | 0 | 0.753 | 0.723 | 5.826 | 6.224 | 3.32–5.07 (61 samples) |
| 5 | B-node22-run3-base | baseline | 0 | 0.641 | 0.671 | 6.440 | 6.061 | 2.10–3.32 (59 samples) |
| 6 | B-node22-run3-cand | candidate | 0 | 0.779 | 0.629 | 4.275 | 6.266 | 1.67–2.10 (57 samples) |
| 7 | B-node24-run1-base | baseline | 0 | 0.724 | 0.368 | 8.359 | 8.632 | 1.49–1.73 (53 samples) |
| 8 | B-node24-run1-cand | candidate | 0 | 0.671 | 0.273 | 6.762 | 8.838 | 1.59–2.28 (52 samples) |
| 9 | B-node24-run2-base | baseline | 0 | 0.712 | 0.371 | 8.488 | 8.739 | 1.48–1.91 (53 samples) |
| 10 | B-node24-run2-cand | candidate | 0 | 0.617 | 0.515 | 7.882 | 9.446 | 1.51–1.86 (53 samples) |
| 11 | B-node24-run3-base | baseline | 0 | 0.597 | 0.436 | 7.895 | 9.171 | 1.40–1.58 (53 samples) |
| 12 | B-node24-run3-cand | candidate | 0 | 0.545 | 0.367 | 7.586 | 8.725 | 1.45–1.91 (52 samples) |

Ranges, series B (ms):

| Runtime | Side | Population | p50 range | p95 range | p99 range | max range | Runs within gate |
|---|---|---|---|---|---|---|---|
| node22 | baseline | compact no-change | 0.087–0.095 | 0.235–0.253 | 0.641–0.802 | 1.459–1.694 | 3/3 |
| node22 | baseline | rich no-change | 0.089–0.103 | 0.188–0.229 | 0.671–0.795 | 0.996–1.374 | 3/3 |
| node22 | baseline | compact changed | 1.298–1.654 | 4.191–4.828 | 6.083–6.440 | 7.715–12.455 | 3/3 |
| node22 | baseline | rich changed | 1.514–1.657 | 4.393–5.189 | 6.018–6.358 | 7.033–8.256 | 3/3 |
| node22 | candidate | compact no-change | 0.081–0.089 | 0.177–0.244 | 0.728–0.779 | 1.141–2.098 | 3/3 |
| node22 | candidate | rich no-change | 0.093–0.105 | 0.182–0.223 | 0.629–0.874 | 1.189–1.539 | 3/3 |
| node22 | candidate | compact changed | 1.210–1.627 | 3.250–4.419 | 4.275–5.826 | 6.985–7.611 | 3/3 |
| node22 | candidate | rich changed | 1.457–1.795 | 4.272–5.175 | 6.224–6.340 | 7.573–15.982 | 3/3 |
| node24 | baseline | compact no-change | 0.072–0.082 | 0.167–0.202 | 0.597–0.724 | 1.365–1.661 | 3/3 |
| node24 | baseline | rich no-change | 0.083–0.092 | 0.157–0.207 | 0.368–0.436 | 1.132–1.491 | 3/3 |
| node24 | baseline | compact changed | 1.118–1.162 | 2.419–2.683 | 7.895–8.488 | 9.436–13.301 | 3/3 |
| node24 | baseline | rich changed | 1.186–1.235 | 2.702–2.807 | 8.632–9.171 | 10.363–13.045 | 3/3 |
| node24 | candidate | compact no-change | 0.074–0.081 | 0.175–0.233 | 0.545–0.671 | 1.280–1.642 | 3/3 |
| node24 | candidate | rich no-change | 0.078–0.086 | 0.148–0.177 | 0.273–0.515 | 0.901–1.155 | 3/3 |
| node24 | candidate | compact changed | 1.127–1.214 | 2.619–2.740 | 6.762–7.882 | 9.505–13.208 | 3/3 |
| node24 | candidate | rich changed | 1.212–1.232 | 2.921–2.951 | 8.725–9.446 | 10.748–11.148 | 3/3 |

### 7.3 What the B10B numbers show and do not show

- Every gated population of every run is within its gate except series A node22 run2-**baseline** compact changed.
  All 6 candidate runs per runtime (3 in A, 3 in B) are within all four gates.
- These Node 24 results differ from the dots dispatcher series (compact changed up to 12.314 ms, rich changed up to
  15.716 ms on candidate). This host is different; per the brief, a changed host is not proof that the earlier failures
  were invalid.
- Isolation is **not** established: this is the owner's workstation with other agent sessions and services running; the
  1 s sampler uses `ps` lifetime-average %CPU and short-lived processes (`pg_isready`, `runc`) show as high values. It
  detects agent-controlled overlap from this verification (none: all steps were serialized), not continuous quiet.
- No GC/allocation diagnosis, no instrumented runs, no trimming or pooling were performed.

## 8. Deviations, conflicts and limits

1. `docs/cloud/B10B-S3F-PERF.md` exists on `universal-hud` but not on `dots/b10b-s3f-perf`; it was read from `universal-hud`.
   No content conflict between the documents was found that required stopping a step.
2. `universal-hud` and `dots/b10b-s3f-perf` advanced during the run (documentation only); tests stayed on the pinned
   commits (§2.2). `universal-hud` `f261242` STATE records that the owner would have local Claude test and publish here;
   `42aadb8` adds the provenance requirements addressed in §2.4.
3. Proxy-variable policy changed mid-run and the Node 22 matrix exists twice (§2.4, §5.2). Both are reported.
4. Driver bug: the first pass skipped the separate `test:mjs` after node22 `npm test` stopped at unit; it was run as a
   supplementary step (§3).
5. §5.1's result depends on the process ancestry; this run used a detached driver under the root-owned WSL relay.
6. Host load was not controlled (§7.3). Performance numbers are design evidence for this host, not P-06-7 qualification.
7. The temporary worktrees and the downloaded Node 22 runtime stay in `<VERIFY_ROOT>` (not deleted).

## 9. Redaction (public repository)

Before publication the text files were copied through `scripts/redact.py`: the local user's home and project paths
became `<HOME>`, `<REPO>`, `<VERIFY_ROOT>`; the machine name became `<host>`; a local proxy URL became
`<local-proxy>`. A residual scan for home paths, user/host names, e-mail, token/key patterns and the proxy port was run
on the published copy (`manifest/redaction-scan.txt`). Process names in the load snapshots (e.g. `codex`, `claude`,
`herdr`, `pi`, `python3`) are kept because they identify the interference; no process arguments were recorded. Test
commands, exit codes, commit/tree SHAs, runtimes, performance data and error text are unchanged.

## 10. Files

- `REPORT.md` (this file), `SUMMARY.json` (machine-readable; every step, counts, failing tests, all perf populations),
  `SUMMARY.steps.json` (raw parse), `SHA256SUMS` (all other files).
- `manifest/`: `environment.txt`, `refs.txt`, `targets.tsv`, `results.tsv` (every step: target, env, step, exit, start, end,
  command), `capability-probe-*.json`, `dist-provenance-*.txt`, `b10b-perf-order*.txt`, `proxy-policy-change.txt`,
  `redaction-scan.txt`, `scripts/` (the exact driver scripts used).
- `logs/<target>/<env>/<step>.log` (check set, focused, supplementary), `logs/perf-series/` (RUNZ1 perf and B10B series A,
  builds), `logs/perf-series-B/` (series B runs and monitors), `logs/setup/` (npm ci), `logs/master*.log`, `perfB.log`.
