# Pi sessions in the ordinary collector and panel

The ordinary `HudDelegationCollector` now registers configured Pi sources alongside
Codex/Claude. A session already known to the ledger/tree is read through the existing
PiAdapter and source-contained PiTranscriptFiles resolver. Source configuration alone
does not enumerate a new session list, manufacture a managed run or launch Pi.

A profile uses `harness: "pi"`, an absolute existing `source.root`, `env: {}` and
`mcpServerName`. The adapter's source ID is derived from the canonical source root.
The selected session's full harness/source/session/thread identity is preserved;
a matching filename with a different JSONL header does not become that session.
Native topology is the adapter's explicit empty Pi subagent topology, not a fabricated
Codex/Claude catalog. Metadata resolution and reader work remain in the existing
ordinary grant/deadline path. No new performance gate or budget is introduced.

The ordinary panel's selected Pi Inspector shows source ID, session ID, observation
coverage, reported token components and reported session cost (not an invoice).
Unknown metrics stay absent. Transcript bodies are not rendered. Append changes
schedule another normal read; file replacement/truncation/removal invalidate current
lineage through the existing fencing path. Source generation, observation stamps,
publication leases/CAS and read-only recovery retain their existing mechanisms.

This is observation integration only. PiAdapter capabilities remain empty, managed
resume remains capability_unverified, and transcript data cannot authorize launch,
MCP identity or process control. The separate explicit foreground/RPC launch seams
are not activated by registering a source. No real Pi account/provider is needed.

Validation uses a real synthetic Pi v3 JSONL file and an isolated ledger-known Pi
session, invokes ordinary collector ticks, draws the real panel/Inspector and checks
identity, usage, coverage, append refresh, header mismatch and ordinary publication.
The ledger fixture is test setup, not a new discovery or authority-granting API.

```sh
npm run build
npm run build:test
node --test dist-test/tests/unit/pi-ordinary-collector.test.js
```

This does not claim automatic discovery of arbitrary unregistered sessions, live
Pi compatibility, native Pi subagent navigation or full Phase C/M2 completion.
