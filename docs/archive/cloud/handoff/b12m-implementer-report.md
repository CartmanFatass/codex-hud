# B12M implementer report (round 0)

Saved by the orchestrator from the implementer's text report. Worktree branch `cloud/b12m` from `universal-hud` 6fcf08a.

## Summary

All six failure modes in the brief have a test on real SQLite, and all pass. The compatibility fixture was recorded before any source change and passes on both the base tree and this branch. The focused B12/B16 suites and the B10C suites are green. The README check set is green except for failures that also happen on the unmodified base tree, plus one known flake that passed when rerun alone. No contract or design forks came up. One design choice needs review: the "active grant" for lazy reads is set on the store (decision 2).

## Changed files (all within the brief's ownership)

- `src/core/types/checkpoint.ts`: new types, plus optional `getMetered`/`pageMetered` on `RecoveryIndexLookup`.
- `src/core/interfaces/observation-store.ts`: optional `readRecoveryMetered?` and `activateRecoveryGrant?` on `PreparedObservationStore`.
- `src/core/observation-store.ts`: `RecoveryGrant`, `RecoveryReadError`, the metered recovery, metered and pinned lookups, the grant activation, and pins for the commit-ACK lookups.
- New tests: `tests/unit/b12m-helpers.ts`, `tests/unit/b12m-compat.test.ts` + `tests/unit/b12m-compat-fixture.json`, `tests/unit/b12m-metered.test.ts`, `tests/int/b12m-performance.mjs`.
- Not touched: `src/core/checkpoint.ts` (the overlay still calls the legacy `lookup.get/page`; a grant active on the store meters those calls). Also not touched: collectors, schema, `readerVersion`, the checkpoint format, publish/lease/fencing.

## Exported API (additive; existing signatures and behaviour unchanged)

```ts
// types/checkpoint.ts
interface RecoveryReadStats { bytesRead; recordsRead; elapsedMs }
interface RecoveryReadGrant { now(): number; remaining(): ReaderBudget; charge(s: RecoveryReadStats): void; drain(): RecoveryReadStats }
type RecoveryReadRefusalReason = 'bytes' | 'deadline'
type MeteredLookupResult<T> = {kind:'value',value,stats} | {kind:'refused',reason,minimumBytes?,stats} | {kind:'stale',stats}
type MeteredRecoveryResult = {kind:'recovered',recovery,stats} | {kind:'continuation',continuation: ReaderContinuation,stats} | {kind:'stale',stats}
RecoveryIndexLookup.getMetered?(grant, namespace, key): MeteredLookupResult<string|undefined>
RecoveryIndexLookup.pageMetered?(grant, namespace, after, limit): MeteredLookupResult<readonly RecoveryIndexEntry[]>
// observation-store.ts
class RecoveryGrant implements RecoveryReadGrant {
  constructor(budget: ReaderBudget, options?: { deadline?: number; now?: () => number }); readonly deadline; get charged() }
class RecoveryReadError extends ObservationStoreError { stats; minimumBytes? }
ObservationStore.readRecoveryMetered(target, grant): MeteredRecoveryResult
ObservationStore.activateRecoveryGrant(grant | null): RecoveryReadGrant | null   // returns the previous grant
```

## Bytes definition (in the `RecoveryReadStats` doc comment)

- **bytesRead**: logical decoded payload, the UTF-8 byte length of TEXT values actually loaded into JS (checkpoint body and identity, index lineage, entry keys and values). Size probes (`octet_length`), integers, and pin/reference equality checks run inside SQLite and count 0. Not storage I/O: page, overflow, WAL and OS-cache reads are not observed or claimed.
- **recordsRead**: 1 per recovered checkpoint, 1 per fetched value, 1 per fetched page entry.
- **elapsedMs**: monotonic time on the grant's clock, probes and refusals included.

## Decisions

1. Admission: `readRecoveryMetered` runs one probe (`octet_length` of body, identity and index lineage) inside one read snapshot, then admits, then fetches. It never selects `projection_body` (the legacy path selected it but never used it). Bytes that do not fit → `record_needs_larger_slice` with `minimumBytes` = body + identity + lineage. No time or no records left → `recovery_catching_up` (legacy shape). Target not current → `stale` (legacy `null`). Lookups admit on bytes and deadline only; records reported, not refused.
2. Charging lazy use after ACK (design choice to review): the store holds the active grant. While a grant is active, the legacy `get`/`page` on any lookup this store created run metered and pinned, and throw `RecoveryReadError` (`recovery_snapshot_stale`, `recovery_budget_exhausted`, `recovery_deadline_exceeded`) instead of returning a partial value. With no grant active, behaviour is byte-identical to before.
3. Pinning: every store-created lookup records its commit (commitSeq, sourceGeneration, seqDomain, checkpoint_id): recovery lookups, ACK lookups on a changed publish, ACK lookups on a no-op publish (pinned to the previous commit). Metered reads check the pin in the same snapshot as the data; any newer commit makes the lookup stale, including a summary-only commit reusing the checkpoint. The legacy unmetered path keeps its old index-snapshot behaviour (fixture locks it in).
4. page(): first pass reads only rowids and lengths, deadline per row; then admits on the total; then fetches per row with a deadline check. Refusal discards the page. `minimumBytes` is the full page's need.
5. Charged exactly once: a per-call meter charges the grant once on every outcome, including a throw (rethrown as `RecoveryReadError` with stats, original as `cause`). `drain()` returns what was charged since the previous drain.

## Failure-mode tests

`tests/unit/b12m-metered.test.ts`, `tests/unit/b12m-compat.test.ts`:

- "B12M oversized checkpoint body/identity: admission refuses before any fetch, with stats; projection never selected"
- "B12M deadline inside page(): stops at the deadline with stats and no partial page"
- "B12M lookup after a replacing commit: typed stale result, no data from the new commit"
- "B12M lazy use after ACK under an active grant is charged once (reader and collector both drain)"
- "B12M a thrown read after partial work still reports and charges the work done"
- "B12M compatibility callers without grants match the pre-change recorded fixture" (recorded with `B12M_RECORD=1` before any `src` edit; passes on an extracted 6fcf08a tree and on this branch)
- Mutation check: six deliberate breakages of the compiled store each failed the targeted test.

## Check output (Node 22.23.4, SQLite 3.53.4)

- `npm run build && npm run build:test && npm run build:hud-mcp`: clean.
- `env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=$(mktemp -d) npm test`: `# tests 2249 # pass 2218 # fail 7 # cancelled 7 # skipped 17`. The failures are in `b45-launch`, `hud-link-export`, `run-control`; they fail identically on unmodified 6fcf08a (alone: `# tests 46 # pass 31 # fail 7 # cancelled 7` in both trees). Environmental (e.g. Node's SQLite ExperimentalWarning on stderr; "Promise resolution is still pending").
- `npm run test:core`: `# tests 210 # pass 209 # fail 0 # skipped 1`.
- `npm run test:visual`: `# tests 292 # pass 292 # fail 0`.
- `npm run test:hud-mcp`: run 1 `# tests 84 # pass 82 # fail 1` (`b20-advice` `ledger_busy`, known flake); run 2 alone `# tests 84 # pass 83 # fail 0 # skipped 1`.
- `npm run format:check`: "All matched files use Prettier code style!".
- `npm run check:fixtures`: "check-fixtures: OK".
- `git diff --check`: clean.
- `node --test dist-test/tests/unit/b12*.test.js dist-test/tests/unit/b16-writer.test.js`: `# tests 84 # pass 83 # fail 0 # skipped 1`.
- B10C suites: `# tests 33 # pass 33 # fail 0`.

## Performance

Size-probe overhead per recovery. Command: `npm run build:test && node tests/int/b12m-performance.mjs`. n=2000 per population, warm-up 200, interleaved, nearest-rank, ms per call, synthetic 2000-entry index, temporary `HUD_HOME`.

| Population | p50 | p95 | p99 | max |
|---|---|---|---|---|
| legacy `readRecovery` | 0.274 | 0.643 | 1.088 | 1.579 |
| `readRecoveryMetered` | 0.315 | 0.655 | 1.008 | 4.375 |
| probe query alone | 0.036 | 0.077 | 0.109 | 0.552 |

B12 focused suites, median `duration_ms` over 7 alternating runs, base 6fcf08a vs B12M: b12-store 1440/1467, b12d-wal 3669/3784 (base range 3604–4046), b12r-claude-recovery 592/592, b12r-codex-recovery 794/708, b12r-store 663/685. Within noise.

## B10D adoption list (`src/collectors/delegation.ts`)

- :646 where `collectionDeadline` is set: `grant = new RecoveryGrant(<remaining shared allowance>, { deadline: collectionDeadline })`, once per logical operation from the shared 8 MiB allowance.
- :674 `source.store!.readRecovery(prior, budget)` → `source.store!.readRecoveryMetered(prior, grant)`; map `stale` → current `!recovery` path, `continuation` → current `'kind' in recovery` path (keep the `minimumBytes` handling at :676–677, from `r.continuation`), `recovered` → `r.recovery`.
- :678 the conservative `this.charges = { bytesRead: budget.maxBytes, recordsRead: budget.maxRecords }` → `this.charges = grant.drain()`.
- :683–690 delete the `canonicalJson(inline)` estimate; charge `grant.drain()`; next budget `grant.remaining()`.
- :707–710 around `reading.reader.read(budget)`: `const prev = source.store?.activateRecoveryGrant(grant)` before, `activateRecoveryGrant(prev ?? null)` in a `finally`.
- :763–769 `charged` = reader stats + `grant.drain()`.
- :772–778 catch path: `grant.drain()` plus the reader's full budget only for the native read part; a `RecoveryReadError` carries `.stats` already in the grant, do not add them again.
- :785 `takeUnattributedIO()` unchanged; drain once per slice into `this.charges`.

## Open items

1. The reader's own file I/O during `read(budget)` is not charged to the grant while the read runs; one slice can overshoot the shared allowance by up to the reader budget unless B10D splits the allowance or charges reader stats into the grant between slices. B10D's call.
2. A legacy `page()` refused under an active grant throws and the reader fails that slice; a 128-entry overlay page that keeps not fitting could starve. Fair-continuation sizing belongs to B10D/B16.
3. Any newer commit makes a lookup stale, including summary-only commits (brief's "replaced commit" wording); safe because every own publish hands the overlay a fresh ACK lookup.
4. Pre-existing failures on 6fcf08a in this environment: `b45-launch`, `hud-link-export` (SQLite ExperimentalWarning on stderr), `run-control`. `b12-store`'s process tests passed in a base tree with no `dist/` built, so they may not detect a missing build.

## Orchestrator verification

- `git status`/`git diff --stat` match the listed files (3 src files, +513/−30; 5 new test files).
- Rebuilt; `node --test dist-test/tests/unit/b12*.test.js dist-test/tests/unit/b16-writer.test.js` → `# tests 84 # pass 83 # fail 0`; B10C suites → `# tests 33 # pass 33 # fail 0`; `format:check` clean; `git diff --check` clean.
- Base tree (main checkout at 6fcf08a, freshly built): `b45-launch`, `hud-link-export`, `run-control` alone → `# tests 46 # pass 31 # fail 7 # cancelled 7`, matching the claim.
