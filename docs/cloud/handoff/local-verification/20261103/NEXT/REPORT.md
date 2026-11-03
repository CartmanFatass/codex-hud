# Owner-run local verification of B10B-S3F-NEXT `0cca9ca` (2026-11-03)

Independent local verification requested by the owner, run by a local Claude Code session on the owner's WSL machine.
Verification only. Nothing was fixed, merged or accepted. No source, test, benchmark, threshold, sample count, timing
boundary, security setting or real session file was changed. Acceptance stays with the Oracle.

This directory adds to `local-verification/20261103`; the earlier `../REPORT.md` (old PERF target `9496910`) and its
evidence are untouched. Paths are relative to this `NEXT/` directory. `<VERIFY_ROOT>`, `<HOME>`, `<REPO>`,
`<SESSION_TMP>`, `<host>`, `<proxy>` and `<no-proxy-list>` replace private values (§9).

Governing inputs read first (from `origin/universal-hud` `48abc4f`): `docs/cloud/B10B-S3F-NEXT.md` (§8 commands,
timeouts and isolation; §9 strict rules) and `docs/cloud/rulings/b10b-next-post-review-route.md` (§7, the owner test
need).

## 1. Short result

| Item | Result |
|---|---|
| Target identity | commit `0cca9caa6ddf3249291c8ed85a41da1eed800ee4`, tree `4b66dca450ad717455321e2b103dc9b5d190716c`: **match**. |
| Fresh builds (build, build:test, build:hud-mcp) | Node 22.23.4: 3/3 exit 0. Node 24.22.1: 3/3 exit 0. |
| Strict B10B, Node 22.23.4 | 3 processes: **3/3 exit 0, all 4 gates pass in each**. |
| Strict B10B, Node 24.22.1 | 3 processes: **3/3 exit 0, all 4 gates pass in each**. |
| README check set (Node 24.22.1) | **Not green.** `npm test` exit 1: unit stage 2450 pass / 2 fail / 16 skip of 2468; mjs stage **not reached**. Separate `npm run test:mjs` 47/47 pass. `test:core` 209 + 1 skip, `test:visual` 331/331, `test:hud-mcp` 83 + 1 skip, `format:check`, `check:fixtures` and `git diff --check` all exit 0. |
| `npm test` failures | (a) `B21 real-SQLite MCP refusal is stable and never dispatches a launch`: `ledger_busy`. This is the README's listed ledger_busy family (b21-capacity), so it got the one permitted isolated rerun of `b21-capacity.test.js`: 5/5 pass. Both logs kept. (b) `ledger processes: concurrent same key with different parameters rejects the losing request`: `intent.rejected` event count `0 !== 1` (ledger-processes.test.js:154) after a logged 20 ms busy-budget retry. Not a listed known flake, so **not rerun**; it stays a failure. |
| NEXT §8 focused commands | facts + perf-regression: 16/16 pass. `b10b*.test.js` (normal invocation, not strict): 385/385 pass. |

These strict results are the first six exact-NEXT processes on this machine. They do not replace or cancel the cloud
Node 24 failures (implementer 0/3, dispatcher 0/3) or the corrected dispatcher Node 22 1/3 recorded in the ruling. They
are a separate host and a separate observation (§6). One measured series per runtime was run. Nothing was rerun or
selected.

## 2. Identities

Raw: `manifest/identity.txt`, `manifest/refs.txt`.

- `origin/dots/b10b-s3f-next` contains `0cca9ca`; worktree `<VERIFY_ROOT>/wt/next` is a new detached `git worktree`
  at exactly `0cca9ca`. HEAD and tree re-read at every step header: unchanged.
- `e5ccee3` (NEXT baseline) is an ancestor. `e5ccee3..0cca9ca` changes exactly `src/render/delegation/facts.ts`,
  `src/render/delegation/projection.ts`, `tests/unit/b10b-s3-facts.test.ts` and `tests/unit/b10b-s3-perf-regression.test.ts`
  (4 commits).
- Benchmark `tests/unit/b10b-s3-perf.test.ts` blob `371b8f784229636f66e88434c422484dd85251eb` and fixture
  `tests/fixtures/b10b-big.ts` blob `a711705346161d155324c86564ab819e546d3fae`, in HEAD and as `git hash-object` of the
  worktree files. Both match NEXT §9.
- Production blobs: facts.ts `6820c8f3…d426`, projection.ts `77c61250…62a5`; test blobs b10b-s3-facts
  `20f2f7a7…f79f`, perf-regression `53aa1088…2edb`; package-lock.json `87327f35…6a01` (full values in identity.txt).
- Source manifest: SHA-256 of all 1329 tracked files (`manifest/source-sha256.txt`, file digest
  `254b3e28…ced1`); `git ls-files -s` in `manifest/source-ls-files.txt`.

## 3. Host, runtimes, dependencies

Raw: `manifest/environment.txt`. WSL2 kernel 6.18.33.2-microsoft-standard-WSL2 x86_64, Ubuntu 24.04.4 LTS, AMD Ryzen 7
8745H (16 logical CPUs), 15.6 GB RAM, ext4 root (`/dev/sdd`). Worktree, temporary HOME/HUD_HOME/TMPDIR all on that
ext4 root (not `/mnt/c`, not tmpfs). `kernel.yama.ptrace_scope=1`.

- Node 22: `<VERIFY_ROOT>/runtimes/node-v22.23.4/bin/node` v22.23.4, npm 10.9.9, binary SHA-256 `94efd062…9a90` (the
  official tarball checked against nodejs.org SHASUMS256 in the earlier run).
- Node 24: `<HOME>/.nvm/versions/node/v24.22.1/bin/node` v24.22.1, npm 11.19.1, binary SHA-256 `e32e2d16…afb`.
- Dependencies: one `npm ci --ignore-scripts --prefer-offline` (Node 24/npm 11.19.1, 600 s limit, exit 0,
  `logs/setup/npm-ci.log`) against the unchanged lockfile, used unchanged for both runtimes. The proxy variables
  were passed to this step only. Installed: chokidar 5.0.0, prettier 3.9.9, readdirp 5.0.0, typescript 5.9.3,
  undici-types 6.21.0, @iarna/toml 2.2.5, @types/node 20.19.29. Full per-file SHA-256 of `node_modules/` plus
  package-lock: `manifest/dependency-sha256.txt` (332 entries, digest `843e84e7…42f3`).
- `git status --short` after install and after all checks shows only ` M node_modules/.package-lock.json`
  (written by npm ci; never staged). No tracked source, test or visual-baseline change
  (`manifest/git-status-*.txt`, `manifest/git-diff-stat-after-checks.txt`).

## 4. Isolation wrapper (every build, test and strict process)

Driver `scripts/lib.sh` `step()`; the expanded wrapper with the actual temporary paths is in each log's `# wrapper:`
line:

```
cd <wt>/next
env -i PATH=<selected node bin>:/usr/bin:/bin HOME=$(mktemp -d <SESSION_TMP>/home.XXXXXX) \
  HUD_HOME=$(mktemp -d <SESSION_TMP>/hud.XXXXXX) TMPDIR=<SESSION_TMP> LANG=C.UTF-8 TERM=xterm-256color \
  npm_config_cache=<VERIFY_ROOT>/npm-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
  [B10B_PERF=1 for strict runs] timeout -k 10 <NEXT §8 seconds>s bash scripts/anc-exec.sh <ancestry file> <command>
```

- A new HOME and a new HUD_HOME for every process, under one session TMPDIR `<SESSION_TMP>` = `<SESSION_TMP>`
  (short path because of AF_UNIX path limits; the same ext4 root).
- `env -i` means `NO_COLOR`, `FORCE_COLOR`, `NODE_USE_ENV_PROXY`, `NODE_OPTIONS`, real `HUD_HOME`, proxy variables and
  all `CLAUDE*`/`HERDR*`/`CODEX*` variables are absent. This is stricter than NEXT §8's `env -u …` form, which
  clears the same four named variables but inherits the rest. The invoking shell had `NODE_USE_ENV_PROXY` set; it did
  not reach any build or test. No heap or GC flags were set.
- The selected Node directory is first on PATH, so `npm` and its child scripts use the same runtime.
- Timeouts per NEXT §8: npm ci 600, each build 180, strict 300, npm test 1200, test:mjs 300, core/visual/hud-mcp 600,
  format/fixtures 180, diff 60, facts+regression 180, b10b* 600, known-flake rerun 600. **No step timed out.**
- Real `~/.hud`, `~/.claude`, `~/.codex*`, `~/.pi` were not read or written by any step.

### 4.1 Process ancestry

Each step recorded its ancestry (PID, comm, UID; no arguments) from inside the wrapper (`logs/**/*.ancestry.txt`). It
was the same for every step:

```
bash (anc-exec, uid 1000) <- timeout (1000) <- bash driver (1000) <- zsh (1000) <- claude (1000) <- zsh (1000) <- herdr (1000) <- systemd PID 1 (uid 0)
```

The drivers ran as children of the local Claude Code session's Bash tool, not detached. Unlike the earlier run (where
`nohup` left the root-owned WSL `Relay` as parent and `test:hud-mcp` hit `EACCES` on its `/proc/<pid>/environ`),
there is no root-owned ancestor below PID 1 here. `test:hud-mcp` passed, including the physical caller registration
test. That pass reflects this ancestry. It is not evidence about the root-owned-ancestor case.

## 5. Builds and generated output

Before each runtime's builds, `dist/`, `dist-test/` and `packages/hud-mcp/dist/` were deleted
(`manifest/clean-node22.txt`: absent in the fresh worktree; `manifest/clean-node24.txt`: removed the Node 22 output).
Each build ran separately (`logs/build-node22/`, `logs/build-node24/`), all exit 0.

Generated-file manifests (`manifest/generated-sha256-node{22,24}.txt`, 2341 files: dist 1081, dist-test 1027,
hud-mcp dist 233) are **byte-identical** between the Node 22 and Node 24 builds (manifest digest `649becaf…dc0e0`;
aggregates in `*.summary.txt`). Compiled strict benchmark `dist-test/tests/unit/b10b-s3-perf.test.js` SHA-256
`24a2437918e49b34339f5eb15c3c325e50bb9d1cf9b0faefada2139d74425022`. That equals the compiled-benchmark value NEXT §3
records for the old final builds, consistent with the unchanged benchmark source.

## 6. Strict series

Command (inside the wrapper, `B10B_PERF=1` set in the env wrapper): `node --test dist-test/tests/unit/b10b-s3-perf.test.js`.
Order: Node 22 fresh build, runs 1/2/3, then Node 24 fresh build, runs 1/2/3; serial, no other agent-controlled build
or test in between. Unchanged benchmark, fixture, samples (1000 after 200 warm-ups), nearest-rank and limits
(2/2/10/15 ms). Full output: `logs/strict/b10b-strict-node{22,24}-run{1,2,3}.log`. Every printed population (n,
p50/p95/p99/max, strict flag) is in `SUMMARY.json` → `strict`.

Gated populations, per-run p99 / max in ms (not pooled):

| Run | UTC start–end | CN p99/max | RN p99/max | CC p99/max | RC p99/max | Gates (no-change, compact, rich, printed) | Exit |
|---|---|---|---|---|---|---|---|
| node22 run1 | 22:30:39–22:31:35 | 0.735 / 1.267 | 0.666 / 1.108 | 5.326 / 5.804 | 5.506 / 6.537 | pass pass pass pass | 0 |
| node22 run2 | 22:31:35–22:32:30 | 0.599 / 1.459 | 0.557 / 1.163 | 4.536 / 6.020 | 5.224 / 6.236 | pass pass pass pass | 0 |
| node22 run3 | 22:32:30–22:33:29 | 0.707 / 2.288 | 0.625 / 1.360 | 4.693 / 5.780 | 6.652 / 7.977 | pass pass pass pass | 0 |
| node24 run1 | 22:33:46–22:34:53 | 0.573 / 2.035 | 0.288 / 1.080 | 7.756 / 11.031 | 11.440 / 16.414 | pass pass pass pass | 0 |
| node24 run2 | 22:34:53–22:35:51 | 0.457 / 2.456 | 0.388 / 1.441 | 8.414 / 10.759 | 8.535 / 10.897 | pass pass pass pass | 0 |
| node24 run3 | 22:35:51–22:36:49 | 0.419 / 1.695 | 0.315 / 2.044 | 7.653 / 10.981 | 9.301 / 10.908 | pass pass pass pass | 0 |

CN/RN/CC/RC = compact/rich no-change, compact/rich changed (limits 2/2/10/15 on p99). Per-runtime ranges: Node 22 CN
0.599–0.735, RN 0.557–0.666, CC 4.536–5.326, RC 5.224–6.652; Node 24 CN 0.419–0.573, RN 0.288–0.388, CC 7.653–8.414,
RC 8.535–11.440. Every max above a limit (e.g. Node 24 CC max 11.031) is a single sample. The gates are on p99, and
they are reported as printed.

Node 24's changed-tick p99 remains clearly higher than Node 22's on this host (CC about 1.6×, RC about 1.6×), the same
direction as the cloud record. The margin to the compact 10 ms limit on Node 24 is 1.6–2.3 ms.

### 6.1 Load during the strict series

Each run has a 1 s monitor (`*.monitor.txt`: 1-minute loadavg and the top six processes by `ps` %CPU, names only) and
load before/after in the log header/footer. 1-minute loadavg: Node 22 runs 1.14–1.66; Node 24 runs 1.35–4.13 (run 1
and 2 peaked at 4.13).

The machine was **not isolated**. The owner's other sessions kept running throughout: a `codex` process (about 37–47 %),
a long-lived `python3` (about 94–99 %), and short bursts of `git`/`gh`/`git-remote-http`/`runc`, and during Node 24
run 3 `opengrep`, `ast-grep`, `typos-lsp` and `pg_isready`. No unrelated process was stopped or changed.

Limits: `ps` %CPU is lifetime-averaged per process, not instantaneous. 1 s snapshots are not continuous isolation
proof. WSL2 shares the physical CPU with Windows, which is not visible from inside WSL. No result is attributed to,
or excused by, this load.

## 7. README check set and NEXT §8 commands (Node 24.22.1)

One full README set, on Node 24, after the Node 24 strict runs. The Node 24 fresh builds in §5 are the set's first
line. Per ruling §7 and NEXT §8 ("no new full-suite runtime matrix"), the full set was **not** run on Node 22. Node 22
coverage here is its three builds and the strict series.

| Step | Command | Limit | Result | Log |
|---|---|---|---|---|
| build ×3 | `npm run build`, `build:test`, `build:hud-mcp` | 180 s each | exit 0 ×3 | `logs/build-node24/` |
| 04 | `npm test` | 1200 s | **exit 1**. Unit: 2468 tests, 2450 pass, **2 fail**, 16 skip (the 3-test block before it is the nested B21 real-process subrun: 2 pass, 1 skip). **mjs stage not reached.** | `logs/checks-node24/04-npm-test.log` |
| 04b | `npm run test:mjs` (separate, because npm test stopped) | 300 s | exit 0, 47/47 | `04b-test-mjs-separate.log` |
| 04r1 | `node --test dist-test/tests/unit/b21-capacity.test.js` (README known-flake isolated rerun, once) | 600 s | exit 0, 5/5 incl. the failed test | `04r1-known-flake-rerun-b21-capacity.log` |
| 05 | `npm run test:core` | 600 s | exit 0, 209 pass, 1 skip (`ledger benchmark …` env-gated) | `05-test-core.log` |
| 06 | `npm run test:visual` | 600 s | exit 0, 331/331; baselines unchanged (git status) | `06-test-visual.log` |
| 07 | `npm run test:hud-mcp` | 600 s | exit 0, 83 pass, 1 skip (`B45 synthetic … busy distributions` env-gated) | `07-test-hud-mcp.log` |
| 08 | `npm run format:check` | 180 s | exit 0 | `08-format-check.log` |
| 09 | `npm run check:fixtures` | 180 s | exit 0 | `09-check-fixtures.log` |
| 10 | `git diff --check` | 60 s | exit 0 | `10-git-diff-check.log` |
| 11 | `node --test --test-concurrency=1 dist-test/tests/unit/b10b-s3-facts.test.js dist-test/tests/unit/b10b-s3-perf-regression.test.js` | 180 s | exit 0, 16/16 | `11-next-focused-facts-regression.log` |
| 12 | `node --test --test-concurrency=1 dist-test/tests/unit/b10b*.test.js` | 600 s | exit 0, 385/385 | `12-next-focused-b10b-all.log` |

The two `npm test` failures, verbatim in the log (lines about 831/1476 and the failing-tests block about 2580–2610):

1. `B21 real-SQLite MCP refusal is stable and never dispatches a launch`: `Error: Ledger busy: no operation was
   accepted within the write-lock budget` (`code: 'ledger_busy'`, b21-capacity.test.js:69). This is a README-listed
   known flake (ledger_busy family, seen in b21-capacity). Its single isolated rerun passed. The original failure
   stands, and `npm test` stays exit 1.
2. `ledger processes: concurrent same key with different parameters rejects the losing request`:
   `AssertionError 0 !== 1` at ledger-processes.test.js:154, which is
   `rows.events.filter(kind === 'intent.rejected').length === 1`. Just before it the test logged `Concurrent intent
   exhausted its 20 ms busy budget; retrying the same request once after the competitor committed.` The README does
   not list this test, so it was **not rerun**. It matches the open V1 item "core intent.rejected audit-event failure"
   in the post-review ruling §7. Its cause is not classified here.

The 16 unit skips, 1 core skip and 1 hud-mcp skip are the existing env-gated benchmark or real-process tests
(unit: B12_BENCHMARK, HUD_EXPORT_BENCHMARK ×2, B22_PROCESS, B6_PROCESS ×10, B6_PERF, HUD_LEDGER_BENCHMARK; the
nested B21 block's B21_PERF; core: HUD_LEDGER_BENCHMARK; hud-mcp: HUD_B45_BENCH). The log prints each one with its
reason.

The external load was higher during `npm test` (1-minute loadavg rising to about 10 at 22:37:35–22:37:51, mostly the
test's own worker processes plus `codex`/`python3`; `logs/checks-node24/04-npm-test.monitor.txt`). Both failures are
timing-related ledger contention paths, but that is a hypothesis, not an attribution.

## 8. Not run, skipped, limits

- Full README set on Node 22: not run (ruling §7: no new full-suite runtime matrix).
- The NEXT §9 step 4 paired allocation/CPU/GC diagnostic and the baseline (`e5ccee3`) strict series: not run. The
  ruling §5 holds new runtime diagnostics, and the owner test need in ruling §7 asks only for the candidate builds,
  strict series and README set.
- No retries of strict runs, no best-run selection; the series above is the only one.
- The only rerun is the one README-permitted known-flake rerun (§7).
- Not formal supported-WSL P-06-7 qualification; a workstation with other user sessions active.

## 9. Redaction and files

The published copy was made by `scripts/redact.py` from the local originals. It replaces the verification root, repo
path, home path, session TMPDIR prefix, host and user name, email, proxy addresses and the NO_PROXY list; numbers,
exit codes, test names and failure text are unchanged. The residual scan for home paths, user/host names, tokens/keys
and proxy hosts found 0 hits after redaction. Raw originals stay local. `RAW-SHA256SUMS` lists their hashes, so the
published files are not claimed to be byte-identical to them. `SHA256SUMS` covers the published files.
`redaction-manifest.txt` lists the substitutions.

- `SUMMARY.json`: parsed strict populations/gates and per-step test counts/failing tests.
- `manifest/results.tsv`: id, runtime, exit, UTC start/end, timeout, extra env, command for every step.
- `manifest/`: identity, refs, environment, source/dependency/generated manifests, clean records, git status.
- `logs/`: full stdout+stderr per step, with `.monitor.txt` and `.ancestry.txt` beside each.
- `scripts/`: the exact driver, wrapper, parser and redaction scripts used.

Open items not changed by this run: R2 (cloud Node 24 0/3 and dispatcher records stand), V1 (`npm test` red here as
well), NEXT-E1/E2, V2. This is not an acceptance, and no merged tree exists.
