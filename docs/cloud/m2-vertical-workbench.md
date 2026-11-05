# Synthetic Claude → Codex vertical workbench

This finite cloud lab runs neither Claude Code nor Codex and uses no provider account. It exercises the real `DelegationService` Codex preparation and intent acceptance, real SQLite, `launchPreparedRun`, the `hud-run` headless supervisor, caller registration, `HandshakeService`, `LinkTickCollector`, and `delegationAgentsRows` together. Linux procfs and Node 22 >= 22.13 or Node 24 are required.

From the repository root:

```sh
npm run build
npm run build:hud-mcp
node scripts/workbench/vertical.mjs
node --test tests/workbench/vertical.test.mjs
```

Use `node scripts/workbench/vertical.mjs --json > frames.json` to save machine-readable frames. A private temporary home and allowlisted environment are used; the lab deletes only directories it creates. The fixed synthetic executable and helper never invoke a provider. The CLI can select only the fixed synthetic scenario; no arbitrary target, account or capability can be selected.

The finite script submits one request, replays its request key, and shows an active intent, accepted binding/report while the scope and slot remain live, and eventual scope end. It then submits a different waiting request and asks the existing control service to cancel it. The same-key replay keeps the same run; two requests produce two dispatches. In the Pi lab, replay also succeeds after the synthetic capability verdict is withdrawn, without a second dispatch. All panel frames and relation summaries use the real ledger reader and renderer.

## Evidence boundaries

- **SIMULATED:** Claude parent process/session authority; Codex child session identity; and a lab-only process-reader wrapper that verifies the exact owned fake parent process and script then substitutes only its harness classification argv. Real procfs supplies PID, start time, ancestry, namespace and domain. The fixed reporter is an actual child of that process. It privately receives the synthetic run claim through the existing prepared `-c` environment overrides. The wrapper does not prove real Codex source validation or real Claude MCP/source attribution. A lab-only capability verifier recognizes only this synthetic executable/source and headless spawn; shipped capabilities are unchanged.
- **Real in this lab:** accepted intent and request-key replay, supervisor-owned process/scope and ledger events, actual caller registration and root authorization, `HandshakeService.whoami` and report writes, slot state, cancellation intent and panel reads. The report is synthetic and does not terminate a live scope or release its slot. Scope end is not proof of task success, and native exit may remain unknown. Cancellation may be unconfirmed; inspect the observed state and events rather than assuming success.
- **Not demonstrated:** real provider authentication, live CLI compatibility, provider transcript discovery, real-parent orphan supervision, or production capability promotion. Synthetic child identity is chosen by the fixture independently of the claim. The second request intentionally remains unbound.
- This is a finite scripted scenario, not an interactive control surface. On error, cleanup signals only still-matching process stamps from the owned run metadata. It never uses a process-name sweep or blind process-group signal. Binding and reports use the actual writer APIs; terminal and slot transitions belong to the existing supervisor/reconciler, never direct SQL updates.

## Synthetic Pi intent

`node scripts/workbench/vertical.mjs --pi` runs the same finite UI flow with a fixed synthetic Pi-labelled child. The workbench injects a lab-only spawn/headless preparer and a verifier restricted to that fake executable and temporary source. The production preparer registry defaults to Codex only: Pi remains unsupported unless trusted code explicitly injects a preparer, and no shipped capability is promoted. The real supervisor, SQLite, replay, slot and panel paths run as above. The first Pi request uses a synthetic extension context and v3 session to exercise an actual child binding and explicit synthetic report; the second Pi request remains unbound and tests cancellation, whose result may remain unconfirmed. See `m3-pi-bound-workbench.md` for the trust boundaries.

Run the seam refusal tests after `npm run build:test` using `node --test tests/workbench/preparer.test.mjs`. They verify that the default map refuses Pi before dispatch and that inconsistent proposed identity/launch metadata is rejected before a capability verdict or intent acceptance.
