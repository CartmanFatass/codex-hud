# Synthetic Claude → Codex vertical workbench

This is a disposable, finite cloud lab. It does not run Claude Code, Codex, a provider account, or an MCP server. It exercises the real `DelegationService` Codex preparation and intent acceptance, real SQLite, `launchPreparedRun`, `hud-run` headless supervisor, `LinkTickCollector`, and `delegationAgentsRows` together. Linux procfs and Node 22 >= 22.13 or Node 24 are required.

From the repository root:

```sh
npm run build
npm run build:hud-mcp
node scripts/workbench/vertical.mjs
node --test tests/workbench/vertical.test.mjs
```

Use `node scripts/workbench/vertical.mjs --json > frames.json` to save the machine-readable frames and observations. The runner creates a private temporary home, runs the lab in an allowlisted environment, then deletes the home. The fixed test executable is copied from `scripts/workbench/synthetic-codex.mjs` into the temporary home; it never invokes a provider. No program, target, account, or capability can be selected by a CLI argument. It submits one synthetic request, replays the same request key, shows the active and terminal ledger-backed panel frames, then submits a different waiting request and asks the existing control service to cancel it. Replay must retain the same run; there are two dispatches for two distinct requests. The panel and relation summaries are from the real ledger reader and renderer.

## Evidence boundaries

- **SIMULATED:** the Claude-labelled parent, process reader, session observation, caller/identity evidence and capability verdict are explicitly lab-only. The local verifier recognizes only the synthetic executable, source, headless mode and spawn operation. This proves neither Claude MCP/source attribution nor any shipped capability. The injected launch wrapper calls the real launcher and does not invent supervisor success.
- **Real in this lab:** accepted intent, request-key replay, supervisor-owned process/scope and ledger events, slot state, cancellation intent, and panel reads. A cancelled request may finish with unconfirmed cancellation rather than a confirmed cancellation; inspect the actual returned state and events. Scope ended is not proof of task success, and native exit may remain unknown.
- **Not demonstrated:** child handshake/binding, report submission, real provider authentication, live CLI compatibility, native transcript discovery, orphan supervision of a real parent, or production capability promotion. The panel deliberately shows the child as an unbound intent/handshake, not a verified child session. The parent observation is synthetic, not a fabricated provider transcript.
- This is a finite scripted scenario, not an interactive control surface. On an error, cleanup targets only still-matching process stamps captured by the run's ledger metadata; no process-name sweep or blind process-group signal is used. Terminal and slot transitions are made by the existing supervisor/reconciler, not direct SQL updates.
