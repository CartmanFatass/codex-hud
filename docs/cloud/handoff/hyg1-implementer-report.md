# HYG1 implementer report (round 0)

Saved by the orchestrator from the implementer's text report. The brief is `docs/cloud/HYG1.md` (on `cloud/briefs-2`). Branch `cloud/hyg1` from `universal-hud` 6fcf08a.

## Summary

`npm test` now has one failure: a product defect in `run-control`, reported and left failing as the brief says. `hud-link-export` and `b45-launch` were environment or test causes, fixed in the tests. `b12-store` now fails clearly when the build is missing. All other checks are green.

Baseline on unmodified 6fcf08a (Node 22.23.4, temporary HOME): hud-link-export `# tests 11 # pass 4 # fail 6` (1 skipped); b45-launch `# tests 15 # pass 8 # cancelled 7`; run-control `# tests 20 # pass 19 # fail 1`.

## 1. hud-link-export — 6 failures — environment (Node 22 runtime warning)

- Evidence: `node -e "require('node:sqlite')"` on Node 22.23.4 prints `ExperimentalWarning: SQLite is an experimental feature…` plus the `(Use \`node --trace-warnings ...\` …)` line; Node 24.22.1 prints nothing. The 6 failures are exactly the cases where a launched `bin/hud` loads `node:sqlite` through `src/ledger/runtime.ts`; each actual stderr is that warning, then the expected text.
- Fix (tests only): `hudStderr()` removes one copy of exactly that warning (the line plus the optional trace-warnings line), applied in `child()` and the two direct spawn sites in the async-stdout test. Chosen over `NODE_NO_WARNINGS=1`, which would hide every other warning. All "stderr otherwise empty or exact" assertions unchanged.
- Mutations (compiled copy outside the worktree; unmutated copy 10/10): extra `synthetic-noise` on stderr → 8 fail; a different warning (`DeprecationWarning`) → the same 8 fail; a second copy of the SQLite warning → the 6 sqlite-loading processes fail; extra line after `internal_or_output_failure` in `dist/cli/hud.js` → test 6 fails.

## 2. b45-launch — 7 cancelled — test defect exposed by Node 22's test runner

- Evidence: `launchPreparedRun` (`src/core/launch/supervisor.ts:62`) `unref()`s the detached supervisor by design. Test 9 awaits `result.completion`; nothing keeps the loop alive, so Node 22's runner cancels it ("Promise resolution is still pending but the event loop has already resolved") and every later test in the file. Minimal reproduction (detached, unref'd child awaited): Node 22 `# tests 1 # pass 0 # cancelled 1`; Node 24 `pass 1`. Unmodified b45-launch passes 15/15 on Node 24.
- Fix: a bounded keep-alive `setTimeout(() => {}, 10_000)` held only while awaiting `completion`, cleared in `finally`. Not a raised timeout: if completion never settles, the timer runs out, the loop drains and the test is cancelled (fails, does not hang). Completion took ~54 ms on Node 24; 10 s matches the file's other process bounds.
- Mutations (on `dist-test/src/core/launch/supervisor.js` in a copy): completion reports `code: 1` → test 9 fails; `RUN_NODE_FLAGS` dropped → test 9 fails; completion never resolves → test 9 cancelled after 10017 ms.

## 3. run-control "supervisor death receiptless Q" — `uncertain` instead of `ended` — product defect, triggered by the environment; left failing

- Environment trigger: the container's PID 1 (`/process_api --firecracker-init …`) reaps orphans late (orphan zombie lifetimes 1415–1793 ms measured; one zombie `sh` has sat for 3+ hours). Fails on Node 24 too.
- Trace: after the test's 1800 ms sleep, the run's group holds one member `{"state":"Z","ppid":1}` and `kill(-pgid,0)` succeeds; reconcile reads `uncertain ["Z"]` at +0/+500/+1000 ms and `ended []` at +1500 ms (PID 1 reaped it).
- Why a product defect: contract 04 line 73 (ScopeCheck) — gone "可以是可信完整成员枚举且只剩Z，不能只要求kill(-pgid,0)=ESRCH"; T-04-11 maps "仅Z或空" to gone. `proveGroupGone` (`src/core/run/process.ts`) returns false when `inspection.members.length !== 0` (line 164: zombies count as members) and then also requires `kill(-pgid,0)` to fail with ESRCH (lines 166–173), which never happens while a zombie remains. A Z-only scope is never proven gone; the run stays `uncertain` with its slot held until something reaps the zombie.
- Minimal reproduction: a Python parent forks a child that leads its own group and exits, unwaited → `member states ["Z"] enumerated true` / `leader processState dead` / `proveGroupGone … false`.
- **Orchestrator correction after review 1:** the patch below is **unsafe and withdrawn**. Do not apply it. The reviewer reproduced two races where it says "gone" while a live process is in the group:
  - a fork after the `/proc` readdir snapshot;
  - a same-session process joining a pgid that a zombie still holds.

  See [`hyg1-review-1.md`](hyg1-review-1.md) finding 1 for the corroborated direction: a second scan, a session check for headless scopes, an architecture ruling for visible scopes, and regression tests for both races. The original text is kept for the record.
- Proposed fix (as originally written; withdrawn):

  ```ts
  if (!inspection.enumerated || inspection.members.some((m) => m.state !== 'Z' && m.state !== 'X')) return false;
  if (inspection.members.length !== 0) return true; // only Z/X: complete enumeration per 04 §ScopeCheck
  ```

  Keep the ESRCH probe only for the empty enumeration. On a compiled copy outside the worktree, the reproduction prints `true` and run-control passes 20/20. Owner to decide whether a process can join a pgid whose only members are zombies (setpgid from the same session) between enumeration and decision. Other suites were not run against the patched copy.

## 4. b12-store — process tests did not pass without a build; they failed unclearly

- Evidence (compiled copy with `dist/` removed, original tests): Node 22 `# tests 13 # pass 9 # cancelled 3` ("Promise resolution is still pending…"); Node 24: the 3 process tests time out after 30 s. `tests/int/b12-process.mjs` imports `../../dist/core/observation-store.js`, dies on import, its stderr was never read and pending IPC calls never settled. The run-1 observation was probably made with a `dist/` present; `npm test` always rebuilds.
- Fix: `ProcessClient` reads the helper's stderr (bounded to 8 KiB); if the helper closes without a kill the test asked for (`stopping`), every pending and later call is rejected with `b12-process exited (code …, signal …) before replying: <stderr>`. `send` takes a callback, so a dead channel is reported the same way.
- Mutations: no `dist/` → the 3 tests fail in ~85 ms with `ERR_MODULE_NOT_FOUND` in the message; helper `process.exit(3)` on `publish` → the 3 tests fail with `exited (code 3…)`. The crash test's own SIGKILLs are unaffected (12/12).

## Changed files

`tests/unit/hud-link-export.test.ts`, `tests/unit/b45-launch.test.ts`, `tests/unit/b12-store.test.ts`. No changes to `package.json`, `src`, `bin` or docs.

## Checks

Each fixed file alone, 5 runs on Node 22, temporary HOME — green every time: hud-link-export `# tests 11 # pass 10 # fail 0 # cancelled 0` (1 skipped: root bypasses file permissions); b45-launch `15/15`; b12-store `13, pass 12` (1 skipped: `B12_BENCHMARK` unset). All three also pass on Node 24.22.1.

| Check | Result |
|---|---|
| build, build:test, build:hud-mcp | rc=0 |
| `npm test` | rc=1, only the product defect: `# tests 2243 # pass 2225 # fail 1 # cancelled 0 # skipped 17` (`not ok 1502 - supervisor death receiptless Q uses registered stamp, no replacement execution or writer files`). `npm test` stops before `test:mjs`; run alone: `47/47` |
| `test:core` | 210, pass 209, skipped 1 |
| `test:visual` | 292/292 |
| `test:hud-mcp` | 84, pass 83, skipped 1 |
| `format:check` / `check:fixtures` / `git diff --check` | clean / OK / clean |

## Open items

1. Product defect for the owner: `proveGroupGone` Z-only scope (`src/core/run/process.ts:164`, `:166–173`; contract 04 line 73, T-04-5, T-04-11, T-02-14). run-control stays red in this container until it is fixed. The fix needs corroboration beyond one scan (see review 1, finding 1), not the patch in §3.
2. Not a contract defect: on Node 22 a real `hud link export` also prints the SQLite ExperimentalWarning on stderr. The panel suppresses it (`src/collectors/daemon-binding.ts:47`); `src/ledger/runtime.ts` does not. Contract 07 does not require an empty stderr on success. The owner may want the same suppression in the CLI.
3. Other process helpers (`tests/int/b12r-process.mjs` and others) use the same "import dist/, stderr unread" pattern; outside this brief.

## Orchestrator verification

`git status`: only the three test files. Rebuilt; each file alone with a temporary HOME: hud-link-export `11 / 10 pass / 0 fail / 0 cancelled`; b45-launch `15/15`; b12-store `13 / 12 pass / 0 fail`; run-control `20 / 19 pass / 1 fail` (the reported defect). `src/core/run/process.ts:164` reads `if (!inspection.enumerated || inspection.members.length !== 0) return false;` followed by the `kill(-pgid, 0)` / ESRCH probe, as described.
