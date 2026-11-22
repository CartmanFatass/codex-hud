# B12M re-check (Oracle, Fable max, fresh agent), after fix round 1

Saved by the orchestrator from the reviewer's text. Read-only; mutations were run on compiled copies outside the worktree.

**Verdict: accept.** No P0–P2 regressions.

| # | Status | Evidence |
|---|---|---|
| F1 | fixed | `b12m-metered.test.ts:11` `WIDE` (60 s) for every real-clock grant not under deadline test; deadline tests keep `tickingClock()`. Mutation `WIDE.budgetMs → 0`: 5/8 fail with `recovery_deadline_exceeded`. 3 quiet + 5 loaded runs all 8/8. Residual: test 1 still uses real-clock 1000 ms grants, each used immediately; the one reuse asserts only `continuation` (acceptable). |
| F2 | fixed | `observation-store.ts:456–470`: `recovery_grant_active` refusal; scoped, idempotent deactivator, no-op after `close()`; defensive `recovery_grant_mismatch`; `close()` clears the grant (:1079). Mutations: refusal removed → test fails; pre-fix unconditional clear → `[1,1]` charge assertion fails. Invariant holds today: `tick.ts:426` awaits each `collect()` in sequence. |
| F3 | fixed (doc) | Adoption list item 1 uses `Math.min(collectionDeadline, this.deadline)` (`delegation.ts:704`), same `performance.now()` clock as `RecoveryGrant`, always finite; item 5 states the slice-loss cost. |
| F4 | fixed (doc) | Item 7 propagates `RecoveryReadError.minimumBytes` with the same key as :677/:762. |
| F5 | fixed | `NO_STATS` gone. |
| F6 | fixed | `#inTransaction` (:292/:303), `#meteredSnapshot` (:340–343). Mutations: always-`#snapshot` fails the in-transaction test; a stuck flag fails the racing part of the thrown-read test. |
| F7 | fixed | Deactivator no-op after close; closed-no-op removed → `recovery_grant_mismatch` at `assert.doesNotThrow`. |
| F8 | no change | as agreed |
| F9 | fixed | meter finished after COMMIT; doc `checkpoint.ts:115–116`. Not observable by test (accepted). |

**Additive:** `activateRecoveryGrant` did not exist on `universal-hud`; no caller outside the store, its interface and the b12m tests. No-grant legacy path: `legacyGet`/`legacyPage` text identical to the old `get`/`page`; the compat fixture re-recorded from a clean `git archive universal-hud` extract deep-equals all 18 values.

**New note (P3):** `observation-store.ts:458` — a leaked activation is cleared only by `close()`: every later activation throws `recovery_grant_active`, and legacy reads throw once the dead grant's deadline passes. Intended fail-loud design; adoption-list item 5 should say "the deactivator must always run (finally); a leaked activation is cleared only by close()". (Added to the handoff's adoption list.)

**Checks:** builds clean; b12m 8/8; b12* + b16-writer 86 (85 pass, 1 skipped); B10C 33/33; `npm test` 2251 (2219 pass, 8 fail, 7 cancelled): pre-existing `b45-launch`, `hud-link-export`, `run-control` plus `b11-cli` #329 (20/20 alone, three times); `test:core` 209/210 + 1 skipped; `test:visual` 292/292; `test:hud-mcp` 2 `ledger_busy` failures under load (`src/ledger/transaction.ts:16`, the ledger does not import the store), reproduced on the unmodified base extract in 2 of 3 runs; format, fixtures, diff-check clean.

**Performance:** legacy `readRecovery` p50 0.313 / p95 0.721 / p99 1.183 / max 1.638 ms; `readRecoveryMetered` p50 0.355 / p95 0.653 / p99 1.243 / max 2.634 ms; probe p50 0.041 / p99 0.113 ms (n=2000, warm-up 200, nearest-rank). Probe overhead ≈ +0.04 ms p50.
