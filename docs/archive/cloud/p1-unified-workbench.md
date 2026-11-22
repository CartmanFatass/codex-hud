# Unified synthetic HUD workbench

This is a fixed cloud lab, not a provider client or production capability. A fresh private temporary delegation SQLite ledger contains a simulated Claude-labelled parent, bound synthetic Codex/Pi children and an unbound synthetic Pi cancellation target. The panel uses `LinkTickCollector`, the existing delegation tree/destinations and Inspector. Two durable **SIMULATED Jev** jobs now appear under their exact recorded parent in the same Agents tree. There is no parallel Jobs list or separately invented selection key.

```sh
npm run build
npm run build:hud-mcp
npm run build:test
node scripts/workbench/unified.mjs
```

In a terminal use `j`/`k` or arrow keys to select, `i` for Inspector, `l` for selected owned-run stdout, `c` to request cancellation of the selected owned run, `r` to refresh, `s` to advance the finite synthetic job scenario, and `q` to exit. Job selection has no run ID, logs, cancel, resume or open action. Selection follows the standard canonical node identity and destination mapping. Accepted cancellation of a run is a request, not proof of termination. The world only controls run IDs it accepted; it does not access user sessions or arbitrary files.

## Durable jobs, separate authority

The independent job database uses the laboratory's `JEVL` marker and **format v2**, adding optional immutable `parentContext: {ledgerId, ref: SessionRef}`. This supersedes the D1 laboratory's v1 format for newly created stores; existing v1 stores are refused without migration or rewriting. This is not a production ledger schema change. The original in-memory fake remains unchanged.

A scoped job records its full parent harness/source/session/thread identity and exact temporary delegation ledger ID at enqueue. Presence, absence and every parent-context field are immutable request parameters. A standalone job has no parent edge; adding a parent on replay is a conflict. Changing the ledger, source or session cannot silently reattach an existing job. Same external keys across accounts/providers remain distinct. Browser locks still span accounts on one instance, and reopening cannot reset consumed tickets or generations.

The pure `job-display.ts` boundary validates bounded snapshots and copies only display fields, excluding owner/request internals. Job nodes use a distinct `simulation-job` edge and share traversal, canonical deduplication, node/depth limits and continuation accounting. They contribute to job counts, never confirmed-session counts, run slots or capabilities. They have no manufactured managed Link, Run, session observation, observation stamp, native exit or committed production status.

The reader's store ID/revision is separate from `ledgerId/asOfSeq`. The two reads are not a cross-database transaction. The collector's memo includes normalized job display data, so job-only state, holder and generation changes appear without an unrelated ledger event, while unchanged input remains a cache hit. The existing no-job behavior remains unchanged, and a job-only tree is no longer discarded just because there are no managed links.

## Availability and historical display

Only an available validated snapshot supplies current job facts. Busy, missing, private-path, unsupported-format, corrupt or closed-reader results may retain an earlier validated snapshot from the same non-null pinned/expected store ID. Retained nodes are explicitly `last_known`, coverage is degraded, and no current answer is exposed. The screen labels their state/holder as historical and says the current count/holder is unknown.

Null/foreign store identity or **any** `store_identity_mismatch` clears retention, even when the result carries the expected old ID. It is not evidence of zero jobs, a free browser or completion. Every projection, including retained data after root/ledger changes, reapplies exact parent-context matching. No fallback snapshot authorizes attachment to another world. No unavailable read creates, repairs or writes a database.

The workbench displays bounded, sanitized synthetic job rows and an Inspector with provider/account/key, state, shared-browser holder and generation, independent revisions, reconciliation and a synthetic answer only after reconciliation. It does not turn these into model success, billing or authorization claims.

## Finite scenario and checks

`node scripts/workbench/unified.mjs --json` exercises:

1. An uncertain consumed ticket and a second account queued on the same browser.
2. A real close/reopen with the same store/key/generation and no resend.
3. `needs_human`, retaining ownership.
4. A terminal observation which still holds the browser and exposes no answer.
5. Matching reconciliation and release, followed by the second account's modeled dispatch.

It also inspects Pi/Codex, reads owned logs, requests the fixed cancellation target and rejects unowned/job actions. There is no real browser, network request, provider send or external exactly-once guarantee. The Pi ordinary observation comes from the synthetic v3 session through `PiAdapter` and remains a sample, not a committed observation. Codex transcript coverage stays unloaded unless independently observed.

Relevant finite checks include the new `c45-jev-tree` unit suite, updated durable-job suite, existing B9/B10A projection/data/memo/tick tests, `tests/workbench/unified.test.mjs`, and `unified-paint.test.mjs`. `python3 tests/workbench/unified-tty.py` exercises actual terminal input/restoration. The existing bounded `tests/int/b10a-performance.mjs` is regression evidence on its declared synthetic populations, not B14/WSL qualification. The integration coordinator must add `c45-jev-tree.test.js` and `c45-jev-durable.test.js` to the finite cloud-check list; this increment does not edit that centrally owned script.

The launcher supplies an allowlisted environment. The world owns its private temporary root, closes the independent job handles, and uses its existing bounded cleanup and corroborated process scopes/stamps. It never sweeps by process name. Real-client identity, production Pi/Jev capability, installation and live-provider recovery remain unverified; existing adjacent failures are not converted into a full-suite-green claim.
