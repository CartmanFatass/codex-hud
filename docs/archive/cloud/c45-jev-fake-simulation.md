# C4/C5 Jev fake: cloud-only design laboratory

This is an in-memory **SIMULATED** model under `tests/fakes`, not a production Jev backend, browser lease service, storage schema, authorization system, or MCP tool. It runs no browser, provider CLI, network request, or external communication. All accepted values are explicitly synthetic, and state disappears when the process exits. No crash durability, inter-process serialization, real browser identity, external acceptance, or live-client compatibility is claimed.

The laboratory exercises the existing `JobRef`, HUD `projectLinkTree` identity path, and `leaseReleasePolicy`; it does not change them. The production MVP `jev_send` and `browser_control` policies remain `unsupported`. Job/lease persistence and production semantics remain unfinalized as stated in [execution contract §三类租约](../contracts/02-execution.md) and [concept §6.6.7](../universal-hud-concept.md). This lab is not a proposal to enable them.

## Model and guardrails

- Full `(kind, provider, account?, key)` distinguishes JobRefs. Owner, request ID, fake browser instance and synthetic request fingerprint are immutable per tuple. The same owner/request ID cannot change its target JobRef. Exact enqueue replay does not dispatch again; changed parameters conflict.
- Different accounts share a simulated lock when their fake browser instance is equal; another instance can progress. Queued jobs do not dispatch while held. Each acquisition receives an increasing instance-local generation. A stale or foreign owner/token cannot update or release.
- Fake dispatch consumes its only dispatch before returning a modeled acknowledgement. A lost reply is `uncertain`; no retry or replacement send is implied. Simulated timeout, runner loss and `needs_human` do not release or permit takeover. No real TTL mechanism is modeled.
- Terminal answered/failed observations retain the lock until a matching owner, generation and explicit matching reconciliation release it via the existing browser lease release policy. Conflicting terminal observations are rejected. An identical reconciliation replay is idempotent and cannot release a later lease. A synthetic answer appears only after reconciliation and is never a real output path.
- `view` labels all state `SIMULATED`; the production tree projection receives only the JobRef as an unloaded node with degraded ledger coverage. Fake state is returned separately, never injected as committed HUD observation, identity proof or authorization. Holder label is read from the same current fake lease snapshot and never used as identity; job and session counts are separate.

## Run

Node 22 >= 22.13 or Node 24, with isolated temporary HOME/HUD_HOME:

```sh
npm run build:test
node --test dist-test/tests/unit/c45-jev-fake.test.js
node scripts/demo-jev-fake.mjs
```

The example covers lost reply → human attention → answered/reconciled, with a second account queued on the same synthetic browser, then dispatch. Tests also cover distinct browsers, full identity and idempotency, conflicting requests, stale generations, unknown/timeout/runner loss, failed reconciliation, fake view isolation and unchanged unsupported production gates. These are simulation tests, not evidence that external side effects or real recovery work.

## JEV-D1: separate durable SQLite laboratory

The original `FakeJevBrowser` and its tests remain unchanged. The demo now uses
`tests/fakes/jev-durable.ts`, an independently versioned **SIMULATED** store. It
is not `ledger.sqlite` schema v1, a production migration, an identity authority,
a real Jev sender, or an enabled `jev_send`/`browser_control` capability. Its
application marker is `JEVL`, format version 1. Only explicit `create` initializes
an empty private file; `open` and the separate `SimulatedJevReader` refuse missing,
unknown-format, malformed or inconsistent stores. The reader opens SQLite
read-only and does not create, initialize, migrate, reconcile or repair anything.
Both reopen APIs accept `expectedStoreId` and reject a different valid store before
returning a usable snapshot or changing state. Callers that remember the ID must
provide it; omission means first discovery, not proof of continuity. Each opened
handle pins the store ID for its later transactions.

The bounded store keeps at most 128 jobs in one SQLite state row. `BEGIN IMMEDIATE`
serializes mutations across independent connections; the jobs, request bindings,
leases, generations, consumed tickets and revisions commit together. Reads validate
the exact simulation schema and singleton key. A mutation must update exactly one
row and reread its intended revision and payload before it can return a dispatch
permission. Corruption is refused without rewriting or repairing the file. It uses
SQLite DELETE journaling and synchronous FULL, a caller-owned 0700 directory and
0600 regular file. The laboratory is for owned temporary synthetic paths, not
untrusted concurrent filesystem attackers or user configuration directories.

- `enqueue` binds canonical full JobRef and `(storeId, owner, requestId)` to the
  immutable browser, request fingerprint and optional synthetic display label.
  Exact replay returns the existing state without another write. Property order
  does not change identity; absent account differs from every named account.
  Input and persisted records have explicit field allowlists. Unknown fields are
  rejected, and public DTOs are assembled only from approved fields.
- `consumeDispatch` checks expected row revision, consumes a single ticket and
  acquires the browser-instance lock with a durable increasing generation. The
  committed state is **uncertain before any simulated send**. There is no sender
  callback or automatic retry. A consumed ticket never returns a new dispatch
  permission, including after close/reopen or a lost response. An acknowledgement
  may be recorded later with `observe(..., 'sent')` at the current revision.
- `observe` requires owner, full JobRef, current lease generation and expected row
  revision. Unknown outcome, runner loss and timeout are represented by
  `uncertain`; `needs_human` also holds the lease. There is no TTL takeover API.
  A terminal observation requires an explicit synthetic evidence token and does
  not itself release the browser or expose an answer.
- `reconcile` requires matching terminal state/evidence, owner, generation and
  row revision. It atomically records the receipt, optional synthetic answer and
  release. Exact receipt replay returns the original revision without another
  release, even if a later job holds a newer generation. Conflicting terminal
  evidence, stale revisions, foreign owners and stale generations are refused.
- Each successful read transaction returns detached
  `{provenance, availability: "available", storeId, revision, jobs}`
  with each job's revision, canonical identity and current browser lease from the
  same snapshot. `holderLabel` is derived from the held job's optional display
  label, never from an owner token by default. Missing labels are omitted. This
  revision is **not** the delegation ledger's sequence or a committed HUD
  observation; unified-tree consumption remains a separate follow-on increment.
- The standalone reader reports failures as
  `{provenance: "SIMULATED", availability: "unavailable", storeId, revision: null,
  jobs: [], reason}`. Stable reasons are `missing_store`, `private_path_required`,
  `unsupported_format`, `store_identity_mismatch`, `store_busy`, `corrupt_store`
  and `reader_closed`. The ID is the expected/pinned ID, or null before discovery;
  it never adopts a mismatching file's ID. Empty jobs on an unavailable result
  are not evidence of zero jobs or a released browser. Consumers must first
  check availability. Constructor failure stays unavailable until an explicit
  new reader is created; an existing reader can retry a later read after a busy
  transaction ends. Neither path creates or repairs a database. Writer operations
  continue to throw on invalid input/store state and never return dispatch
  permission after a refused transaction.

Fresh verification commands, with temporary HOME/HUD_HOME, are:

```sh
npm run build:test
node --test dist-test/tests/unit/c45-jev-durable.test.js dist-test/tests/unit/c45-jev-fake.test.js
node scripts/demo-jev-fake.mjs
```

The durable tests use actual close/reopen, independent SQLite connections
contending for one transaction, and owned synthetic child processes killed before
and after the dispatch commit. Before-commit rollback preserves an unconsumed
queued job; after-commit recovery preserves the consumed uncertain ticket and
requires reconciliation. These finite cloud checks do not establish live browser
recovery, production inter-process authorization, external exactly-once delivery,
or survival of every storage/OS failure. Unknown commit results must be inspected,
not retried as a fresh send. Existing production gates remain unsupported.
