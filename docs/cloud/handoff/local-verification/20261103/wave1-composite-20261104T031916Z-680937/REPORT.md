# Local verification: Wave 1 composite candidate C3 (run wave1-composite-20261104T031916Z-680937)

This verification was requested by the owner and run on the owner's WSL machine by a local Claude Code session. It
covers the one frozen Wave 1 combined candidate:

- **C3** `36d3fd584bd403ed7ada95d1d863a8f63e96588b`, tree `0c8c67ede1f13122987802d9a0346cd6e6ecf73b`
- documentary successor **H** `87ef8d1f59177badeebf8c863a5ad29abdc20ba1`
- benchmark baseline **U** `f248f320d42528fd1eb97db9f1cd2ba97e6d3c86`

Scope rules:
- Verification only. No source, test, assertion, fixture, baseline, driver, script, README gate, dependency
  declaration, lockfile or capability setting was changed.
- No merge, cherry-pick, new candidate or branch change. The only Git write is this evidence directory.
- No delegation, no real harness/Herdr/tmux/Jev/live statusline/install, no B13_REAL, B45 real closure or B14.
- **Nothing here is acceptance.**

Paths are relative to this directory. `<VERIFY_ROOT>`, `<REPO>`, `<HOME>`, `<SROOT>`, `<host>` and `identity-R<n>`
replace private values (§8, `redaction-manifest.json`).

## 1. Short result

| Area | Result |
|---|---|
| Shared README matrix, 3 profiles | **PASS on all three profiles.** Every command exit 0; no timeout, signal, rerun or skip beyond the suites' own skips (§3). |
| Focused commands | **PASS.** All 4 all-profile commands on 3 profiles; all 4 enabled-only commands on 2 profiles (§4). |
| Real PID > 1 optional-ancestor gate | **PENDING: natural PID > 1 optional-ancestor denial did not occur (自然 PID > 1 optional-ancestor 拒绝未出现)** (§5). |
| MCP benchmark, 12 processes | Window met the isolation criterion declared beforehand; **12/12 executed**. C3: 6/6 exit 0, driver gate met. U (baseline): 5/6 exit 0; **`bench-node24-u-1` exit 1, `performance gate exceeded`, cold p95 208.7 ms ≥ 200** (§6). |
| Acceptance | **Not claimed.** The dependent set stays NOT ACCEPTED / NOT MERGEABLE until a fresh final integration Oracle decides (§9). |

## 2. Identity, environment, isolation

**Targets** (`manifest/refs-and-docs.txt`, `manifest/identity.txt`)
- origin is `https://github.com/CartmanFatass/codex-hud.git`.
- C3 and U are new detached worktrees: `<VERIFY_ROOT>/wt/w1-c3` and `wt/w1-u`. HEAD and tree match the pinned
  values, and both were clean at checkout.
- H's only parent is C3. C3..H adds only the four composition documents.
- At fetch, `origin/dots/wave1-compat-integration` was at `27990db7`. That is one more documentary commit after H,
  adding `oracle-v0-composition-review-20261104.md`. It was not used as the test identity.
- U..C3 has 58 leaf changes, and C3 has 1370 leaf entries.
- C3 contains no tracked `dist`, `dist-test` or `packages/hud-mcp/dist`.
- C3 `node_modules` tree is `77829c47…`; `.package-lock.json` blob is `8c35e164…` (both as declared).
- C3 and U share package-lock blob `87327f35…`, `tests/fixtures` tree `4392d6bf…` and `benchmark.mjs` blob
  `c36817de…`.
- Blobs for all binding documents read at H are in `manifest/refs-and-docs.txt`: the integration ruling, connector
  addendum, implementation report, composition manifest, candidate-tree.tsv, check-inventory.json, AGENTS.md, dots.md,
  README, STATE, the three briefs, and their reviews and rulings.

**Source bytes** (`manifest/source-check-*.txt`)
- HEAD and tree never changed.
- The tracked-bytes digest excluding `node_modules/` is identical at every checkpoint: C3 `1d9362af…` (7
  checkpoints) and U `252fb5b9…` (4 checkpoints).
- The only working-tree change is ` M node_modules/.package-lock.json`. `npm ci` rewrites that file. It was never
  staged.

**Host** (`manifest/environment.txt`)
- WSL2 kernel 6.18.33.2-microsoft-standard-WSL2 x86_64, Ubuntu 24.04.4 LTS.
- AMD Ryzen 7 8745H ×16, 15.6 GB RAM.
- Worktrees and `<SROOT>` (a per-run `mktemp -d` directory under `/tmp`) are on the same ext4 root device. Not `/mnt/c`, not tmpfs.
- uid/euid 1000/1000; `kernel.yama.ptrace_scope=1`.
- Capability probe (`logs/<profile>/00-capability-probe/`, Node 22 and 24): AF_UNIX OK, ptrace TRACEME and attach to
  own child OK, `/proc/.../children` OK. Nothing was bypassed.

**Runtimes**
- Node 22.23.4 at `<VERIFY_ROOT>/runtimes/node-v22.23.4/bin/node` (sha256 `94efd062…9a90`), npm 10.9.9.
- Node 24.22.1 at `<HOME>/.nvm/versions/node/v24.22.1/bin/node` (sha256 `e32e2d16…afb`), npm 11.19.1.
- Each command's `meta.txt` records the binary, version and digest it used. The selected bin directory is first on
  PATH, so npm child scripts run on that Node.

**Dependencies**
- Both fresh worktrees lacked `tsc` and `prettier`. `npm ci --ignore-scripts` ran once per worktree (node24-envproxy
  wrapper, 900 s, exit 0; logs in `logs/install/`).
- Both resulting `node_modules` manifests are identical: 332 files, digest `843e84e7…42f3`, no native `.node` files.
  This is the same installation identity as the earlier local runs.

**Generated output**
- Before each profile's builds, `dist/`, `dist-test/` and `packages/hud-mcp/dist/` were deleted
  (`manifest/clean-*.txt`) and rebuilt by that profile's runtime.
- All four C3 builds (three profiles plus the benchmark arm) produced byte-identical output: 2327 files, manifest
  `6f10b7d9…`; dist 1077, dist-test 1013, hud-mcp dist 237 files. U benchmark build: 2303 files, manifest `d5bfba52…`.
- Per-file manifests are in `manifest/generated-*.txt`.

**Wrapper** (`scripts/lib.sh` `run()`; every command's expanded wrapper is in its `meta.txt`):

```
cd <wt>; env -i PATH=<selected node bin>:/usr/bin:/bin HOME=<new> HUD_HOME=<new> TMPDIR=<new> LANG=C.UTF-8 TERM=xterm-256color
  npm_config_cache=<VERIFY_ROOT>/npm-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY + lowercase forms (values unchanged from the owner's shell)
  [NODE_USE_ENV_PROXY=1 in *-envproxy only]
  NODE_PROXY_EVIDENCE_DIR=captures/<profile>/<command>/node-proxy RUNZ1_KILL_EVIDENCE_DIR=captures/<profile>/<command>/runz1-kill
  timeout -k 10 <limit>s bash scripts/anc-exec.sh <ancestry.txt> <command>
```

- **Isolation per command.** Fresh, empty HOME, HUD_HOME, TMPDIR and both evidence dirs. They were removed after the
  command; the evidence dirs stay under `captures/`. Real `~/.hud`, `~/.claude`, `~/.codex*` and `~/.pi` were not
  used.
- **Proxy handling.** All eight proxy variables were present, and the upper- and lowercase forms are equal. Only their
  presence is logged, never values.
- **Control profile.** The invoking shell had `NODE_USE_ENV_PROXY` set. `env -i` drops it, the enabled profiles set it
  explicitly, and the control profile omits it (no argv or `NODE_OPTIONS` activation).
- **Removed variables.** The names of every invoking-shell variable that `env -i` removed are listed in each
  `meta.txt` line "removed by env -i".
- **Diagnostic variables.** `NODE_OPTIONS`, `NODE_NO_WARNINGS` and `NODE_REDIRECT_WARNINGS` were absent in the
  invoking shell, so there was no discrepancy. No warning-disable, redirect, preload or trace flag was used.
- **Raw output.** stdout and stderr are separate raw files, not trimmed, filtered or merged.
- **Cleanup.** After each command, the check for leftover processes with cwd in the worktree or `<SROOT>` found
  `none`, every time (`result.json` `owned_left`). No process was killed by name or pattern.

**Ancestry** of every command (`*/ancestry.txt`, PID/comm/UID only): `bash(anc-exec) ← timeout ← bash driver ← zsh ←
claude ← zsh ← herdr ← systemd(PID 1, uid 0)`. All processes except PID 1 are UID 1000.

**Order**:
1. setup (03:21–03:22Z)
2. matrix: node22-envproxy → node22-noenvproxy-control → node24-envproxy (03:22–03:35:36Z)
3. benchmark builds (03:35:36–03:36:29Z)
4. benchmark window (03:36:29–03:38:38Z)

Nothing ran concurrently, and no other build, test or benchmark from this session was running at the time.

## 3. Shared README matrix (`logs/<profile>/<command>/`)

| Command (limit s) | node22-envproxy | node22-noenvproxy-control | node24-envproxy |
|---|---|---|---|
| build / build:test / build:hud-mcp (600 each) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| npm test (1800) | **0**: unit 2394/2410, 0 fail, 16 skip; mjs 47/47 | **0**: same counts | **0**: same counts |
| test:mjs separately (600) | not needed (npm test reached mjs) | not needed | not needed |
| test:core (900) | 0: 209 + 1 skip | 0: same | 0: same |
| test:visual (600) | 0: 319/319 | 0: 319/319 | 0: 319/319 |
| test:hud-mcp (900) | 0: 107 + 1 skip | 0: same | 0: same |
| format:check (300) / check:fixtures (300) / git diff --check (60) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

- These are all **fresh runtime executions**. No result was reused across profiles. Format, fixtures and whitespace
  were also run per profile instead of using the reuse the prompt allowed.
- No command failed, so no known-flake rerun was needed or done. The README flake list was checked; no `ledger_busy`
  or other listed failure occurred.
- The node24 npm test parser shows an extra "3 tests" block. That is a nested subtest summary inside b21-capacity, not
  a separate run.
- **stderr**: node22-envproxy commands carry Node's own envproxy startup warning bytes (180 B per Node process, e.g.
  `04-npm-test` 1260 B), kept raw. The control profile and node24 have 0-byte stderr everywhere.
- **Captures** were taken with the existing tests' own capture paths, nothing added:
  - `captures/<profile>/04-npm-test/node-proxy/`: 391 files per profile
  - `…/runz1-kill/`: 4 KILL JSON per profile

## 4. Focused commands (unchanged, no name filter or skip)

| Command (limit s) | node22-envproxy | node22-noenvproxy-control | node24-envproxy |
|---|---|---|---|
| 11 node-proxy-profile, concurrency 1 (300) | 0: 5/5 | 0: 5/5 | 0: 5/5 |
| 12 hud-link-export + run-process + run-light-leader, concurrency 1 (600) | 0: 76/76 | 0: 76/76 | 0: 76/76 |
| 13 same three files, normal runner (600) | 0: 76/76 | 0: 76/76 | 0: 76/76 |
| 14 HYG2 six-suite (900) | 0: 76/76 | 0: 76/76 | 0: 76/76 |
| 15 run-control-kill-evidence + run-control, concurrency 1 (600) | 0: 44/44 | (enabled only) | 0: 44/44 |
| 16 runz1-process + run-control + run-process, normal (600) | 0: 54/54 | (enabled only) | 0: 54/54 |
| 17 hud-mcp ancestor-discovery + skeleton + int-ledger-registry (300) | 0: 43/43 | (enabled only) | 0: 43/43 |
| 18 prettier --check four MCP files (300) | 0 | (enabled only) | 0 |

- The serial focused passes do not replace the normal concurrent commands. Those also passed (13, and npm test).
- Earlier local runs failed in two places on the isolated sources:
  - `run-process` "one-shot group launch preserves argv and stdin EOF…": failed on Node 22 envproxy in both the RUNZ1
    three-file run and the MCP npm test.
  - `light leader preserves exact brief bytes…` (MCP npm test).
  
  Both **pass on C3** in every profile.
- **Proxy captures.** Captures (`captures/<profile>/1{1..4}-*/node-proxy/`) include `startup-*`, `export-*` and the
  synthetic `routing-*` cases.
  - Routing uses only test-owned loopback proxies on ephemeral 127.0.0.1 ports and `synthetic.invalid`.
  - No external proxy, HTTPS/TLS or other network API was exercised or is claimed.
- **KILL JSON** (`kill-ladder-*`, `controlled-*`) is in `captures/<profile>/15-*/runz1-kill/` and `16-*`.

## 5. Real PID > 1 optional-ancestor gate: PENDING

`scripts/ancprobe.py` ran under the same wrapper right before and after command 17 on both enabled runtimes
(`ancestry/<profile>/17a-probe-before/`, `17b-probe-after/`). For each ancestor it records pid, ppid, `/proc/<pid>/stat`
start ticks, UID (real/eff/saved/fs), and the errno of an open-then-close of `/proc/<pid>/environ`, which is never read.
All four probes show the same chain:

| Ancestor | UID | environ open |
|---|---|---|
| python3 (probe) → timeout → bash (driver) → zsh → claude → zsh → herdr | 1000 | ok (closed unread) |
| systemd, PID 1 | 0 | **EACCES** |

- The only denial is on PID 1, which does not qualify. No PID > 1 optional ancestor was unreadable.
- Command 17 passed 43/43, including the real-process case `int hud-mcp physical caller registration persists real
  procStart/cwd without logical authority`. That proves registration under readable ancestry only.
- The `simulated EACCES/EPERM optional ancestor` passes are synthetic and are **not** real-topology evidence.
- No reparenting, nohup/setsid, chosen parent, sudo or proc/permission change was used to produce the topology.
- **Status: PENDING (自然 PID > 1 optional-ancestor 拒绝未出现).**

## 6. MCP benchmark (`benchmark/`)

**Setup**
- Arms: U `f248f320` (tree `2a6491f7`) and C3, in separate worktrees with identical dependencies.
- Both were freshly built before the window with the same wrapper (node24-envproxy; `benchmark/prep/`,
  `manifest/generated-{u,c3}-bench*`).
- Driver `tests/hud-mcp/benchmark.mjs`: blob and worktree hash-object were `c36817dee4cf70c27a39a86b3965f4eb6701ceb0`
  in both arms (`benchmark/identity.txt`). Unchanged.
- Order was fixed in `benchmark/order.txt` before any run: per runtime U1, C3-1, U2, C3-2, U3, C3-3, node22-envproxy
  first. The control profile has no series.

**Isolation** (criterion declared in `profile-plan.json` before execution)
- `scripts/cpumon.py` recorded per-process CPU deltas each second (no arguments or environment read) in
  `benchmark/cpumon.tsv`. Owned means the window driver and its descendants, including the monitor.
- Q1: no 1 s sample with non-owned CPU above 1.0 core. Q2: no 5 s rolling mean above 0.5 core.
- **Pre-observation** (60 samples, 03:36:29–03:37:30Z), evaluated once: QUALIFIES, non-owned mean 0.093 / max 0.39
  core (`pre-observation-verdict.txt`).
- **Whole window**, 129 samples to 03:38:38Z: QUALIFIES, 0 Q1 and 0 Q2 violations, non-owned mean 0.096 / max 0.47
  core (`window-verdict.txt`). Per-run maxima were 0.12–0.47 core.
- Non-owned activity seen: a `python3` (5.6 core-s over 23 samples), `codex` (0.7), `MainThread` (0.2) and `claude`
  (0.1). No other build, test, benchmark or install ran inside the window.
- No unrelated process was stopped, reniced or otherwise touched.
- **Limit:** CPU sampling does not prove absence of I/O, memory or cache contention, and this is not formal WSL
  qualification.

**Results** (driver output unchanged; gate: cold p95 < 200 and both method p95 < 50; exit 0 means gate met)

| Run | Arm | Exit | cold p95 ms | cold max ms | tools/list p95 | whoami refusal p95 |
|---|---|---|---|---|---|---|
| node22-1 | U | 0 | 142.8 | 216.3 | 0.396 | 0.375 |
| node22-1 | C3 | 0 | 188.3 | 227.1 | 0.419 | 0.360 |
| node22-2 | U | 0 | 148.9 | 200.9 | 0.425 | 0.396 |
| node22-2 | C3 | 0 | 150.3 | 196.3 | 0.390 | 0.353 |
| node22-3 | U | 0 | 188.9 | 299.4 | 0.376 | 0.363 |
| node22-3 | C3 | 0 | 161.1 | 206.4 | 0.381 | 0.359 |
| node24-1 | U | **1** | **208.7** | 233.9 | 0.400 | 0.424 |
| node24-1 | C3 | 0 | 169.8 | 260.8 | 0.437 | 0.383 |
| node24-2 | U | 0 | 144.2 | 235.8 | 0.395 | 0.377 |
| node24-2 | C3 | 0 | 137.8 | 278.4 | 0.384 | 0.428 |
| node24-3 | U | 0 | 176.7 | 207.2 | 0.431 | 0.425 |
| node24-3 | C3 | 0 | 162.4 | 219.6 | 0.409 | 0.367 |

**Notes on the results**
- Each run reports 30 cold samples and 200 calls per method.
- `bench-node24-u-1` is a **baseline** gate failure. The driver printed its result, then threw `performance gate
  exceeded`. It is kept as recorded and was not rerun, replaced or supplemented. There was no 13th process.
- Node 22 stderr is the process's own `UNDICI-EHPA` warning (kept raw).
- The driver does not print individual cold samples or p99, so none are reported.
- The cold p95 values sit fairly close to the 200 ms limit on both arms (U 142.8–208.7, C3 137.8–188.3). One clean
  window on this host does not establish a margin.
- The series measures the whole dependent tree. It does not show an MCP-only causal effect.
- Earlier cloud failures and the earlier local series stay as they are; these results do not overturn them.

## 7. Not run / out of scope

- Separate per-package matrices for P/M/R; the historical NODE22-PROXY matrix; mutation archives; the KILL diagnostic
  burst; RUNZ1 n=1000 scan-cost; the historical 15:57 snapshot.
- NEXT, old PERF, P065, B10D and later waves.
- A full matrix on U. Only benchmark builds ran there.
- Real harness, Herdr, tmux, Jev, B13_REAL, B45 real closure, B14, install or live statusline.
- Formal WSL/P-06-7 qualification is not claimed.
- Cloud executor holds: this local run does not show that old cloud processes ended, and does not release any held
  executor.

## 8. History, custody and redaction

**History is preserved**
- Earlier local and cloud evidence, failures, K1/K2 dispositions and rerun/fix counts are unchanged and still valid
  as history. Examples: the follow-up run's Node 22 envproxy failures on the isolated MCP and RUNZ1-KILL trees, the
  cloud benchmark failures, and the ledger_busy closeout counts.
- C3 passing does not explain or erase them.
- Custody and read-back of the historical proxy mutation, MCP original/R1 and RUNZ1 raw archives **remains open**. The
  stopped 13-part/44-part uploads were not resumed. No protected RUNZ1 originals were copied or published. Inherited
  documents are not treated as delivered raw archives.

**Redaction of this directory**
- Raw originals stay local and unmodified.
- The published copy makes these replacements:
  - local paths (`<VERIFY_ROOT>`, `<REPO>`, `<HOME>`)
  - the temp root (`<SROOT>`)
  - host and user name, and email
  - each distinct `identity-sha256-<hex>` scope/boot/PID-domain value, replaced with a consistent `identity-R<n>`
    so equality relations are kept
- Numbers, timings, exits, PIDs, test names, failure text and synthetic loopback capture bytes are unchanged.
- Proxy values and process arguments were never recorded.
- `scripts/redact.py` is kept local and left out of the published copy, because its patterns contain the private
  values it removes. Its transformations are listed in `redaction-manifest.json`.
- The `meta.txt` line "removed by env -i" lists variable **names** only, never values.
- `RAW-SHA256SUMS` hashes the raw originals, and `PUBLISHED-SHA256SUMS` the published copy. The two are not
  byte-identical, and that is not claimed.

## 9. Final statement

1. **C3 rows.** On C3 `36d3fd58` / `0c8c67ed`, every row of the shared README matrix and every focused command
   **passed** on node22-envproxy, node22-noenvproxy-control and node24-envproxy.
   - Not run: the separate test:mjs (npm test reached mjs everywhere) and known-flake reruns (none needed).
   - Reused: none; every runtime result is fresh.
   - Provenance: source, dependency (`843e84e7…`) and generated-output identities are in §2 and `manifest/`.
2. **Real PID > 1 optional-ancestor gate:** **not met. PENDING.** No natural PID > 1 optional-ancestor denial
   occurred; only PID 1 denied access.
3. **12-process benchmark:** the window met the criterion declared beforehand (CPU-based; limits in §6). **12/12
   executed.** C3 met the driver gate in 6/6; baseline U failed it once (`node24-u-1`, cold p95 208.7 ms). All
   results are reported. Nothing was added or replaced.
4. **History and custody:** historical evidence, custody gaps, old failures and missing facts are kept as they were.
   This run does not explain or erase them.
5. **Acceptance:** the dependent set (HYG2/NODE22-PROXY, MCP-ANCESTOR, RUNZ1/RUNZ1-KILL) still needs a **fresh final
   integration Oracle** to accept it explicitly, with a disposition for each package. This run does not declare it
   ACCEPTED or MERGEABLE, and it stays NOT ACCEPTED / NOT MERGEABLE.
6. **Merge gate:** only after that acceptance may the sole merger check drift against then-current `universal-hud`
   and do one history-preserving `--no-ff` integration. The full three-profile README gate must then be green **on
   the actual merged tree** before any push or status promotion. That gate is outside this run, and C3 passing here
   does not replace it.

## Files

| Path | Contents |
|---|---|
| `SUMMARY.json` | every command: exit, signal/timeout, UTC, limit, counts, failing tests; benchmark outputs |
| `profile-plan.json` | declared before execution |
| `commands.sh` | exact scripts, concatenated |
| `scripts/` | the scripts themselves |
| `manifest/` | results.tsv, identities, refs and doc blobs, environment, source/dependency/generated manifests, clean records, source checks, driver output |
| `logs/<profile>/<command>/` | `stdout.raw`, `stderr.raw`, `result.json`, `meta.txt`, `ancestry.txt`, `monitor.txt`, `captures-list.txt` |
| `captures/<profile>/<command>/{node-proxy,runz1-kill}/` | test captures |
| `ancestry/` | probe outputs |
| `benchmark/` | order, identity, prep builds, cpumon, verdicts, per-run logs |
