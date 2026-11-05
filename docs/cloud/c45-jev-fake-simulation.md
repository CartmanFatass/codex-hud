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
