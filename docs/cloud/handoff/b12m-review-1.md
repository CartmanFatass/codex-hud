# B12M final review (Oracle, Fable max), round 1

Saved by the orchestrator from the reviewer's text. Read-only review of `cloud/b12m` against `universal-hud` 6fcf08a.

**Verdict: accept** (no P0/P1). Recommended before B10D adopts the API: findings 1 and 2 (P2); findings 3–4 into the B10D adoption list.

## Findings

1. `tests/unit/b12m-metered.test.ts:182` (also :235; `BUDGET.budgetMs: 20` at `tests/unit/b12m-helpers.ts:22`) — real-clock 20 ms grants span fsync'd publishes; `getMetered` checks the deadline (`observation-store.ts:518`) before the pin, so after >20 ms the `stale` assertions at :196/:200/:221/:222 get `refused/deadline`. Test 5 puts a 300-entry iteration under the same 20 ms real grant. Measured publishes 2–29 ms; 15/15 runs passed, margin is fsync latency. — P2 — use `tickingClock()` or `budgetMs: 10_000`; real clock only where the deadline is under test.
2. `src/core/observation-store.ts:436-441` `activateRecoveryGrant` — ambient per-store grant with an unguarded restore; safe only under strict LIFO use. A non-LIFO restore (interleaved collects, worker replacement re-entry, forgotten restore) leaves a dead grant active: lazy reads charged to the wrong grant, and legacy `get/page` throwing from a finished operation's grant. Latent (no caller activates today; `tick.ts:426` serialises `collect()`). — P2 — scoped activation: return a deactivator that restores only if `#activeGrant === grant` (else throw `recovery_grant_mismatch`), or refuse a different grant while one is active unless explicitly nested; clear `#activeGrant` in `close()`; state the "no interleaved collects on one store" invariant in the adoption list.
3. Adoption list item `:646` — grant deadline should be `Math.min(collectionDeadline, this.deadline)` (reader's effective deadline at `src/collectors/delegation.ts:702-705`). Deadline refusals through the legacy API throw, so a lazy read straddling the deadline fails the whole slice where the reader's cooperative deadline would have yielded at the record boundary (contract F10). — P3 — fix the list, note slice loss; optionally `activateRecoveryGrant(grant, { deadline: 'throw' | 'charge' })` (bytes refusal stays hard).
4. Adoption list item `:772–778` — a thrown `bytes` refusal's `error.minimumBytes` is not propagated to `this.minimumBytes`, so fair-continuation sizing never learns the need. — P3 — in the catch: `if (error instanceof RecoveryReadError && error.minimumBytes !== undefined) this.minimumBytes.set(key, error.minimumBytes)`.
5. `src/core/observation-store.ts:109` — `NO_STATS` unused. — P3 — remove.
6. `src/core/observation-store.ts:519` — metered `get` opens `#snapshot` (BEGIN); inside an open write transaction it would fail "cannot start a transaction within a transaction". No reachable path today. — P3 — in-transaction flag in `#transaction`; `#snapshot` runs `work()` directly when set.
7. `src/core/observation-store.ts:437` — `activateRecoveryGrant(null)` after `close()` throws `observation_store_closed`, masking the original error from B10D's `finally`. — P3 — make it a no-op on a closed store.
8. `src/core/observation-store.ts:206-216` — `finish()` idempotence guard unobservable by the suite. — P3/info — none required.
9. `src/core/types/checkpoint.ts:116` — `elapsedMs` excludes the read transaction's COMMIT. — P3 — finish after `#snapshot` returns, or say so in the comment.

## Decision 2 (store-wide active grant)

Within "additive and backward-compatible": signatures unchanged, new methods optional, activation explicit per instance, nobody activates today; with no grant active the legacy bodies are textually identical to base, and the compat fixture passes on this branch and on a clean `git archive universal-hud` extract. Hazards: the unguarded non-LIFO restore (finding 2) and refusals surfacing as throws inside the reader's parse loop. The second was checked safe at the reader level (`rollout.ts:1009` rethrows index errors; the Claude reader rethrows anything but `SyntaxError` and restores state on throw, `reader.ts:982/1006/1109`); its cost is slice loss (findings 3/4). Acceptable, with finding 2 hardening recommended.

## B10D adoption list

Anchors verified against `src/collectors/delegation.ts` (:646, :674, :678, :682-690, :707-710, :763-769, :772, :785). All lazy reads happen inside `read()`. Gaps: findings 3 and 4. The bytes accounting double-counts nothing.

## Verified

- Admission before fetch (probe selects only `octet_length`; `projection_body` never selected; probe and fetch in one snapshot; typed continuations); stats on every outcome including throws; pinned identity checked in the same snapshot; `page` probe/fetch by rowid safe; `octet_length` agrees with `Buffer.byteLength` for STRICT TEXT; bytes definition disclaims physical I/O.
- Ownership: only the three owned src files (+513/−30) plus `tests/unit/b12m-*`, `tests/int/b12m-*`, `docs/cloud/handoff/`.
- Hygiene: synthetic data only; `git diff universal-hud --check` and `format:check` clean.
- Builds clean (build, build:test, build:hud-mcp).
- Tests: b12m 6/6; b12* + b16-writer 84 (83 pass, 1 skipped); B10C 33/33; `tests/unit/*.mjs` 47/47; visual 292/292; check:fixtures OK. Full unit run 2249 tests, 8 fail, 7 cancelled: the three pre-existing families plus `b11-cli` #329, which passes 3/3 alone.
- Mutations: six mutations of the compiled store all caught except the `finish()` guard (finding 8).
- Performance reproduced: legacy p50 0.273 / p99 0.919 ms; metered p50 0.314 / p99 1.08 ms; probe p50 0.035 / p99 0.104 ms (n=2000, warm-up 200, nearest-rank). Probe overhead ≈ +0.04 ms p50.
