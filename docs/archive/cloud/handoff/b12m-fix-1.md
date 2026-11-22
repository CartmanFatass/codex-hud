# B12M fix round 1 report

Saved by the orchestrator from the implementer's text. Responds to `b12m-review-1.md`.

## Per finding

- **F1 (P2)** — `tests/unit/b12m-metered.test.ts` adds `WIDE = { ...BUDGET, budgetMs: 60_000 }`, used for every real-clock grant whose deadline is not under test (stale, charged-once, thrown-read incl. `racing`, new tests). Deadline tests keep `tickingClock()` with explicit deadlines. `BUDGET` in `b12m-helpers.ts` unchanged (the compat fixture's legacy calls use it). Proof: 8 consecutive runs of `b12m-metered` + `b12m-compat`, all `# fail 0`.
- **F2 (P2)** — new signature `activateRecoveryGrant(grant: RecoveryReadGrant): () => void` (mirrored on `PreparedObservationStore.activateRecoveryGrant?`). Activating while another activation is open throws `ObservationStoreError('recovery_grant_active')`. The returned deactivator ends exactly that activation: idempotent, no-op after `close()`, throws `recovery_grant_mismatch` rather than clear a grant it did not activate (defensive; unreachable given the refusal). `close()` clears `#activeGrant`. No-grant legacy path untouched; compat fixture passes. Test: "B12M grant activation is scoped: no interleaved activation, stale deactivators never clear a live grant, close". Mutations caught: refusal removed; pre-fix unguarded clear restored; closed no-op removed.
- **F5** — `NO_STATS` removed.
- **F6** — `#transaction` sets `#inTransaction` (cleared in `finally`); new `#meteredSnapshot` runs work in the open transaction (via `#read`) when set, else `#snapshot`. Metered paths only; legacy bodies unchanged. Test: "B12M metered reads inside an open write transaction run in it instead of nesting BEGIN" (a second store's lease clock calls `getMetered` inside `acquire()`'s BEGIN IMMEDIATE); always-`#snapshot` mutation fails it.
- **F7** — the deactivator is a silent no-op after `close()`; `activateRecoveryGrant(null)` no longer exists; activating on a closed store still throws `observation_store_closed`. Test: end of the F2 test.
- **F9** — snapshot work returns results without stats; `#meteredSnapshot` attaches `stats: meter.finish()` after COMMIT, so `elapsedMs` includes it; a throwing COMMIT is still charged via `meter.fail`. Doc comment updated. No dedicated test (COMMIT timing not observable).
- **F8** — no change (info).

## Check output (Node 22.23.4)

- build, build:test, build:hud-mcp: clean.
- `npm test` (temp HOME, HUD_HOME unset): `# tests 2251 # pass 2220 # fail 7 # cancelled 7 # skipped 17` — the pre-existing `b45-launch`, `hud-link-export`, `run-control` failures, identical on 6fcf08a.
- `test:core` 210/209 pass, 1 skipped; `test:visual` 292/292; `test:hud-mcp` 84 (83 pass, 1 skipped); `format:check` clean; `check:fixtures` OK; `git diff --check` clean.
- `node --test dist-test/tests/unit/b12*.test.js dist-test/tests/unit/b16-writer.test.js`: `# tests 86 # pass 85 # fail 0 # skipped 1` (8 b12m tests).
- B10C suites: 33/33.
- Orchestrator re-ran the b12*/b16 set after rebuilding: `# tests 86 # pass 85 # fail 0`; format and diff-check clean.

## Performance rerun (loaded host, right after the full suite)

`node tests/int/b12m-performance.mjs`, n=2000, warm-up 200, nearest-rank, ms:

| Population | p50 | p95 | p99 | max |
|---|---|---|---|---|
| legacy `readRecovery` | 0.309 | 0.670 | 1.225 | 4.837 |
| `readRecoveryMetered` | 0.347 | 0.682 | 1.309 | 10.155 |
| probe query only | 0.040 | 0.087 | 0.128 | 2.223 |

## B10D adoption list (`src/collectors/delegation.ts` at 6fcf08a)

**Invariant.** No interleaved collects on one store: one active grant per store, enforced by `recovery_grant_active`. Grants and lookups never cross threads; `tick.ts` serialises `collect()`; the B10C worker runs one operation at a time.

1. One grant per slice, before its first use (:646 / :702–705): `new RecoveryGrant({ maxBytes: <remaining shared allowance>, maxRecords: <remaining>, budgetMs: <rest> }, { deadline: Math.min(collectionDeadline, this.deadline) })` — the reader's effective deadline at :704 (F3). Create it just before :674 when `reading.recoveryPending` is set, otherwise right after :705; same grant for recovery and read. In the worker, take it from the operation's shared 8 MiB / deadline grant.
2. :674 — `const r = source.store!.readRecoveryMetered(prior, grant)`: `stale` → current `!recovery` path; `continuation` → current `'kind' in recovery` path (at :676–677 use `r.continuation.kind` / `.minimumBytes`); `recovered` → `r.recovery`.
3. :678 — conservative charge → bytes and records of `grant.drain()`.
4. :682–690 — delete the `canonicalJson(inline)` estimate; charge `grant.drain()`; next budget from `grant.remaining()`.
5. :707–710 — `const end = source.store?.activateRecoveryGrant(grant); try { … await reading.reader.read(budget) … } finally { end?.(); }`. **Slice loss (F3):** a lazy read straddling the deadline or not fitting the remaining bytes throws `RecoveryReadError` inside `read()` and fails the whole slice (no yield at a record boundary). **Allowance split:** the reader's own file I/O is not charged to the grant during `read()`; split the allowance or `grant.charge()` reader stats between slices.
6. :763–769 — `charged` = `result.stats` + `grant.drain()`.
7. :772–778 (catch) — `grant.drain()` plus the reader's budget only for the native-read part; a `RecoveryReadError`'s `.stats` are already in the grant. F4: `if (error instanceof RecoveryReadError && error.minimumBytes !== undefined) this.minimumBytes.set(displayNodeKey({ kind: 'session', ref }), error.minimumBytes);`
8. :785 — `takeUnattributedIO()` unchanged; drain exactly once per slice into `this.charges`.

## Open items (unchanged)

- Reader file I/O not charged to the grant during a read (item 5).
- A repeatedly refused 128-entry page could starve; fair-continuation sizing is B10D/B16's.
- Any newer commit, including summary-only, makes a lookup stale.
- Pre-existing `b45-launch`, `hud-link-export`, `run-control` failures in this environment.
