# HYG1 re-check (Oracle, Opus max, fresh agent), after fix round 1

Saved by the orchestrator from the reviewer's text. The review was read-only. Reproductions ran on compiled copies under the session scratchpad (`hyg1rc/`).

**Verdict: accept.**
- F1, F2 and F3 are fixed.
- F4 was partly fixed; the remaining report-text items were corrected by the orchestrator in `hyg1-implementer-report.md`: `:62` → `:65`, "superseded" notes on §1 and §2, and `:165–172`.
- The fixes introduced no regressions.

## Previous findings

### F1: fixed

- The report now withdraws the `proveGroupGone` patch plainly, names both races and links review 1.
- The open item asks for corroboration beyond one scan.
- No src change: the diff is empty for `src`, `packages`, `bin`, contracts, design, `package*.json` and `tsconfig*`. `src/core/run/process.ts` is identical to `universal-hud`.

### F2: fixed

`tests/unit/b45-launch.test.ts:335–343` races `completion` against a rejecting 10 s timer, cleared in `finally`.

| Variant | Node 22.23.4 | Node 24.22.1 |
|---|---|---|
| Fix, unmutated | 15/15 ×5 | 15/15 ×2 |
| Fix + `completion` never settles | test 9 fails at 10019 ms; 0 cancelled | same |
| Round 0 + never settles | 7 cancelled | **hangs** (killed at 45 s) |
| Fix + completion code 1 | test 9 fails fast | same |

### F3: fixed

`tests/unit/hud-link-export.test.ts:52–57` gates the filter to Node 22. This matches `bin/hud`'s own runtime gate: 22 ≥ 22.13 or ≥ 24, and 23 refused.

Mutation m3 (hud emits one copy of the warning itself):

| Version | Node 22 | Node 24 |
|---|---|---|
| Round 0 | 6 fail | 0 fail (undetected) |
| Fix | 6 fail | 8 fail |

The Node 22 residual was accepted in review 1.

### F4: partly fixed (report text); orchestrator corrected the rest

## New findings

No regressions. One optional item, which existed before HYG1:

- **`tests/unit/b45-launch.test.ts:336–343`**
  - **Defect:** when the 10 s timer fires, the detached supervisor is left running.
  - **Severity:** P3, optional.
  - **Suggested fix:** kill `result.pid` before rethrowing.

## b11-cli #329 `ledger_busy`: an unrelated load flake

1. **The throw site is a wall-clock check, not a lock wait.**
   - It is `packages/hud-mcp/src/delegation.ts:417`: `if (performance.now() >= deadline) throw new LedgerBusyError()`.
   - The deadline is `performance.now() + 30`, set by `resumeLocal` at `:503`: the P-06-5 30 ms budget.
   - The check runs before `acceptIntent` and before any lock. It fires whenever preparation takes 30 ms or more: `readSnapshot`, and in `prepareCodexLaunch` the realpath, stat, brief and config reads plus the TOML parse.
2. **No shared state with HYG1's files.** The test's ledger is private (`mkdtempSync`), and HYG1 changes no product code.
3. **The margin is thin even alone.** Across 40 accepts: p50 10.9, p95 27.0, max 29.3 ms.
4. **Generic load is enough.** With 3 CPU burners it failed 2 of 10 runs.
5. **A/B against HYG1's files.** With b45-launch and b12-store in each version, over 20 interleaved runs each, #329 failed 2/20 in both. The timings are equal.
6. **It was seen before HYG1,** in run 1's `cloud/b12m` full run, at the same throw site.
7. **Other files fail at the same site,** none of them touched by HYG1: hud-mcp #18 (B45 accepted spawn), hud-mcp #62 (G03 old request key), b21-capacity #570, and the listed hud-mcp B20 advice flake.

Recommendation:
- List these as one flake family: "`ledger_busy` from `DelegationService.accept`'s 30 ms budget".
- Owner question: should P-06-5's 30 ms include the preparation I/O before the lock?

## Check set (Node 22.23.4, temporary HOME, HUD_HOME unset)

| Check | Result |
|---|---|
| builds | rc 0 |
| `npm test` run 1 | 2243 tests: 2223 pass, 3 fail. The failures are #329 (flake), #1502 (run-control product defect) and #1549 run-light-leader "portable waiter topology … bash --posix" (143 !== 3); the last passes 53/53 alone. |
| `npm test` run 2 | 2243 tests: 2224 pass, 2 fail (#329, #1502) |
| test:mjs | 47/47 |
| test:core | 209 pass, 1 skipped |
| test:visual | 292/292 |
| test:hud-mcp | 81 pass, 2 fail (`ledger_busy` #18 and #62), 1 skipped. Rerun alone: 83 pass, 1 skipped. |
| b11-cli alone | 20/20 |
| format / fixtures / diff-check | clean / OK / clean |

Each fixed file passed every time: 5 runs alone on Node 22 and 2 on Node 24.
