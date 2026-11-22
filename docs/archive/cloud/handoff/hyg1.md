# Handoff HYG1: a clean cloud test baseline

Branch `cloud/hyg1`, from `universal-hud` 6fcf08a. Cloud run 2, 2026-11-03. The brief is `docs/cloud/HYG1.md` on `cloud/briefs-2`. Not merged: the owner's local orchestrator merges after its own acceptance.

**Status: accepted.**
- The final review (Opus max) accepted the test changes and required a report correction.
- One fix round followed.
- A fresh Opus max agent re-checked it and accepted.

Records in this folder:
- [`hyg1-implementer-report.md`](hyg1-implementer-report.md): round 0, with the orchestrator's corrections and verification
- [`hyg1-review-1.md`](hyg1-review-1.md)
- [`hyg1-fix-1.md`](hyg1-fix-1.md)
- [`hyg1-recheck-1.md`](hyg1-recheck-1.md)

## What changed (tests only)

| File | Cause | Fix |
|---|---|---|
| `tests/unit/hud-link-export.test.ts` | **Environment.** Node 22 prints `ExperimentalWarning: SQLite is an experimental feature` on stderr; Node 24 does not. | On Node 22 only, `hudStderr()` removes exactly one copy of that warning and its hint line. All "stderr otherwise exact" assertions are unchanged. |
| `tests/unit/b45-launch.test.ts` | **Test defect.** Test 9 awaited an unref'd detached supervisor. Node 22's runner cancelled it and the 6 tests after it. | Race `completion` against a rejecting 10 s timer, cleared in `finally`. If the supervisor never exits, only test 9 fails, after 10 s, on both Node 22 and Node 24. |
| `tests/unit/b12-store.test.ts` | **Test defect.** A helper that died on import (for example, no `dist/`) left IPC calls pending: the tests were cancelled on Node 22 and timed out after 30 s on Node 24. | `ProcessClient` reads the helper's stderr. An unrequested exit rejects pending and later calls with `b12-process exited (…) before replying: <stderr>`. |

No `src`, `packages`, `bin`, `package.json`, contract or design change.

Each fix was mutation-tested on compiled copies, on both runtimes, by the implementer and both reviewers.

## Product defect for the owner (left failing)

**`run-control` "supervisor death receiptless Q …" reads `uncertain` instead of `ended`.**

- **Where:** `proveGroupGone` (`src/core/run/process.ts:164–172`) never proves a group gone while a zombie member remains.
  - Zombies count as members.
  - It then requires `kill(-pgid,0)` to return ESRCH, and that does not happen while a zombie still holds the pgid.
- **Rule broken:** contract 04 line 73 (ScopeCheck) and T-04-5 / T-04-11 / T-02-14 say a scope whose only members are zombies may end.
- **Effect:** the run stays `uncertain` and keeps its slot until something reaps the zombie.
- **Why it shows here:** this container's PID 1 reaps orphans late (1–2 s). It fails on Node 24 too.

**The implementer's one-scan patch is withdrawn: do not apply it.** Review 1 reproduced two races where it says "gone" while a live process is in the group:
1. a fork after the `/proc` readdir snapshot;
2. a same-session process joining a pgid that a zombie still holds.

A safe fix needs corroboration:
- a second complete scan, whose members are a subset of the same zombie stamps;
- for headless scopes (their own session), no live process in session `scope.sid`;
- for visible scopes, which share the terminal's session, an architecture ruling, or keep them `uncertain` until ESRCH;
- regression tests for both races.

## Checks (Node 22.23.4; temporary HOME; HUD_HOME unset)

| Check | Result |
|---|---|
| build / build:test / build:hud-mcp | clean |
| `npm test` | 2243 tests: 2224–2225 pass, 0 cancelled, 17 skipped |
| `test:mjs` | 47/47 |
| `test:core` | 209 pass, 1 skipped |
| `test:visual` | 292/292 |
| `test:hud-mcp` | 83 pass, 1 skipped (quiet run) |
| format / fixtures / diff-check | clean / OK / clean |

**Before HYG1** on the same base, `npm test` had 7 failures and 7 cancellations.

**`npm test` failures after HYG1:**
- #1502 `run-control`: the product defect above. It fails in every run.
- Load flakes, intermittent: see the next section.

Each fixed file, run alone, was green on every run: 5× on Node 22 and 2× on Node 24, by both the implementer and the re-checker. Orchestrator check: hud-link-export 10 pass / 1 skipped, b45-launch 15/15, b11-cli 20/20.

## Known load flakes (named here; not caused by HYG1)

**`ledger_busy` from `DelegationService.accept`'s 30 ms budget.**
- Throw site: `packages/hud-mcp/src/delegation.ts:417`, a wall-clock check set at `:503` (P-06-5).
- It fires when the preparation before the lock (snapshot read, realpath and stat, brief and config reads, TOML parse) takes 30 ms or more under load. Alone, accepts use p50 10.9 ms and max 29.3 ms.
- Seen in:
  - b11-cli #329
  - b21-capacity #570
  - hud-mcp #18 (B45 accepted spawn)
  - hud-mcp #62 (G03 old request key)
  - the README's hud-mcp B20 advice flake
- An A/B against HYG1's files shows the same rate (2/20 both ways), and it appeared in run 1 before HYG1.
- **Owner question:** should P-06-5's 30 ms include that preparation I/O?

**`run-light-leader` #1549** "portable waiter topology … bash --posix" (143 !== 3): seen once in a full run; passes 53/53 alone.

**Suggestion:** add both to the README's "Known flakes" list.

## Open items

1. **`proveGroupGone`:** fix the zombie-only defect with corroboration, as above. `run-control` stays red in this container until then.
2. **P-06-5 scope:** does the 30 ms include the pre-lock preparation I/O? This drives the `ledger_busy` flake family.
3. **`hud link export` on Node 22:** a real user also gets the SQLite ExperimentalWarning on stderr. The panel suppresses it (`src/collectors/daemon-binding.ts:47`); `src/ledger/runtime.ts` does not. Contract 07 does not forbid it.
4. **`b45-launch` cleanup (optional, P3):** when its 10 s timer fires, test 9 leaves the detached supervisor running. Kill `result.pid` before rethrowing.
5. **Other process helpers:** `tests/int/b12r-process.mjs` and others share the "import `dist/`, stderr unread" pattern that `b12-store` had.
