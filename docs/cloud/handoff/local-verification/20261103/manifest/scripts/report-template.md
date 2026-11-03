# Local verification of dots/hyg2, dots/runz1 and dots/b10b-s3f-perf (run {{RUN}})

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

{{CHECKS_HYG2}}

Focused (`node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/process-client.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js`):

{{FOCUSED_HYG2}}

HYG2 item 1's new test `hud export leaves fresh-process raw stderr free of SQLite initialization warnings` passes on
Node 24 and Node 22 without `NODE_USE_ENV_PROXY`. Its Node 22 failure with `NODE_USE_ENV_PROXY=1` shows the undici EHPA
proxy warning on stderr, not a SQLite warning.

### 3.2 RUNZ1

{{CHECKS_RUNZ1}}

Focused (`node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js`):

{{FOCUSED_RUNZ1}}

Brief acceptance scenarios, per test name, in all six runs that contain them (`npm test` and focused × node24, node22,
node22-noenvproxy): `RUNZ1 true zombie-only own session ends while the kernel still holds its PGID`, `RUNZ1 fork after
the first census snapshot cannot end a live group` (race 1), `RUNZ1 same-session outsider can join a zombie-held PGID
and never produces gone` (race 2), `RUNZ1 visible shared-session zombie stays unknown until ESRCH despite a living
session outsider` and `run-control` `supervisor death receiptless Q uses registered stamp…`: **pass in all six**.
`cancel escalates INT then TERM then KILL…` passed in five of the six and failed once (§5.4).

### 3.3 B10B-S3F-PERF candidate

{{CHECKS_PERF}}

Focused (`node --test --test-concurrency=1 dist-test/tests/unit/b10b*.test.js`, includes R1's direct-child and the
fifth-sub-row tests and the new `b10b-s3-perf-regression` suite; the strict benchmark file runs in its non-strict mode here):

{{FOCUSED_PERF}}

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

{{RUNZ1_PERF}}

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

{{B10B_A}}

Ranges, series A (ms):

{{B10B_A_RANGES}}

Interference in series A (not started by this verification): the snapshots show `chrome-headless` at ~1100 % CPU at the
end of node22 run1-cand, `npm exec vite build` plus `python3`/`MainThread` processes at ~260 % CPU and 1-min load up to
11.7 around node22 run2 (baseline and candidate), and a `python3` at ~95 % at the start of node24 run1-base. Node22
run2-base is the only failing run (compact changed p99 14.319 ms > 10 ms; its compact-changed p50 2.351 ms is ~1.6–1.8× the other node22 baseline runs). Series
A is kept unchanged.

### 7.2 Series B (16:49–17:01Z), replacement series with a continuous 1 s sampler

Declared after series A showed interference and before execution, same order and env policy
(`manifest/b10b-perf-order-seriesB.txt.note`). Sampler output per run: `logs/perf-series-B/*.monitor.txt`.

{{B10B_B}}

Ranges, series B (ms):

{{B10B_B_RANGES}}

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
