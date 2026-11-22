# HYG1 final review (Oracle, Opus max), round 1

Saved by the orchestrator from the reviewer's text. The review was read-only. Reproductions ran on compiled copies under the session scratchpad (`hyg1r/`).

**Verdict: fix required, in the report text only.**
- The three test fixes are acceptable, and every classification is confirmed.
- §3's proposed `proveGroupGone` patch must not reach the owner as written (finding 1).
- "Fails, does not hang" holds on Node 22 only (finding 2).

## Findings

### 1. `hyg1-implementer-report.md` §3 proposed fix and open item 1 (P2)

**Defect.** The patch returns "gone" when a single `/proc` scan shows only zombies, with no atomic corroboration.
- A single scan is never a complete observation (`src/core/run/process.ts:104`; `tests/unit/run-process.test.ts:182`).
- Today's code accepts "gone" only after `kill(-pgid,0)` returns ESRCH, which is atomic.

**Failure scenario 1.** A live member forks a child after the scan's `readdir`, then exits before its stat is read.
- The scan sees only zombies, so the patch says "gone".
- The run is ended and its slot freed while the child runs in the group. This breaks T-02-14, T-04-5 and T-04-11 ("S/T/D members block termination").
- Reproduced 3/3: current code `false`; patched code `true`, with a live member of state S (`hyg1r/race/demo.mjs`).

**Failure scenario 2.** The report's own caveat, confirmed real. While a zombie still holds the pgid, a live process in the same session can join the group (`hyg1r/race/rejoin.mjs`).
- Control: once the zombie is reaped, `kill(-L,0)` returns ESRCH and `setpgid(0,L)` returns EPERM.
- So the ESRCH proof is final, and a zombie-only proof is not.

**Coverage gap.** All 17 run-related suites pass against the patched copy (206 tests: 196 pass, 0 fail, 10 skipped), so neither race is tested today.

**Suggested direction for the owner.** A zombie-only scan counts as "gone" only with corroboration:
- **Second scan.** A second complete scan, started after the first finishes, must return a subset of the same zombie stamps. Zombies cannot fork. A pid that vanishes between `readdir` and its stat read makes the scan incomplete.
- **Headless scopes.** These run in their own session (`process.ts:287`, `detached`). Also require no live process in session `scope.sid`.
- **Visible scopes.** These share the terminal's session (`visible-process.ts:59,70`). They need an architecture ruling, or stay `uncertain` until ESRCH.
- **Tests.** Add regression tests for both races.

### 2. `tests/unit/b45-launch.test.ts:331–339` (P3)

**Defect.** The 10 s keep-alive bounds the wait on Node 22 only. Node 24's runner keeps the event loop alive itself, so a `completion` that never settles hangs there. That was already true before this change.

**Suggested fix.** Race `completion` against a rejecting 10 s timer (`'supervisor did not exit within 10 s'`), cleared in `finally`.
- Checked on a compiled copy: 15/15 on Node 22 and Node 24.
- With `completion` never settling, both runtimes fail only test 9, after about 10.5 s.

### 3. `tests/unit/hud-link-export.test.ts:51–55` (P3, optional)

**Defect.** The filter applies on every Node version. On Node 24, which prints no SQLite warning, one copy of that exact text emitted by hud itself would be hidden.

**Suggested fix.** Strip only on Node 22.

### 4. Report citations (P3)

- `unref()` is at `supervisor.ts:65`, not `:62`.
- §3 could also cite T-04-5 and T-02-14 ("Z-only可终结").

## Verified

**Scope**
- Only the three test files changed, plus the untracked report.
- `package.json`, `src` and `bin` are untouched.
- Hygiene, prettier and `git diff --check` are clean.

**Baseline**
- Reproduced on a scratch copy built from the `universal-hud` sources.
- Node 22: hud-link-export 4 pass, 6 fail; b45-launch 8 pass, 7 cancelled.
- Node 24: both files are green.

**hud-link-export: an environment issue**
- The filter removes exactly one copy of the exact warning line plus its hint line. It handles the warning landing before or after hud's own text.
- A second copy, other warnings and changed variants all survive the filter.
- All mutations reproduced: noise at exit (8 fail), noise first (9), a DeprecationWarning (8), another ExperimentalWarning (8), a second SQLite warning (6, exactly the SQLite-loading processes), an extra line after `internal_or_output_failure` (test 6).

**b45-launch: a test defect**
- The minimal reproduction is confirmed.
- Production never awaits `completion` (`packages/hud-mcp/src/delegation.ts:463`).
- Mutations reproduced: exit code 1 → test 9 fails; dropped Node flags → test 9 fails; a `completion` that never settles → test 9 cancelled at 10015 ms on Node 22.
- Test 9 takes 64–87 ms.

**b12-store**
- Without `dist/`, the original tests cancel 3 on Node 22 and hit three 30 s timeouts on Node 24. The new tests fail in under 1 s on both, quoting `ERR_MODULE_NOT_FOUND`.
- A helper that exits with code 3 → 3 fail with the clear message.
- The crash test's own kills are unaffected: `stopping` is set before SIGKILL. 12/12 every run.

**run-control: a product defect, triggered by the environment**
- Trace: the leader zombie stays under PID 1, `kill(-pgid,0)` succeeds, and `ended` comes only at +3485 ms.
- Orphan zombies here live 1018–1902 ms, and one `sh` zombie has been around for about 4 hours.
- It fails on Node 24 too.
- The defect against contract 04 line 73 and T-04-11 is real.

**Check set** (Node 22.23.4)
- Builds: rc 0.
- `npm test`: `# tests 2243 # pass 2225 # fail 1 # cancelled 0 # skipped 17`. The only failure is `not ok 1502` (run-control).
- test:mjs 47/47; test:core 209 pass, 1 skipped; test:visual 292/292; test:hud-mcp 83 pass, 1 skipped.
- format, fixtures and diff-check clean.
- Each fixed file passed 5 runs on Node 22 and 2 on Node 24.

**Scratchpad note.** The reviewer's first copy step overwrote `scratchpad/base`, probably the implementer's baseline copy; it is not part of the repo. The worktree was not modified, and no demo processes were left running.
