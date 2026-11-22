# Native HUD local validation handoff

This development branch implements the approved thin HUD/MCP revision. Cloud synthetic checks are not evidence of a live Codex, Claude, Pi, Jev or terminal installation passing.

## Build and entrypoints

Use the project's supported Node runtime (Node 22.13+ or Node 24). From the checkout:

```sh
npm ci
npm run build
npm run build:test
npm run build:hud-mcp
```

Keep the existing harness-native authentication and settings. The implementation discovers the installed `codex`, `claude` and `pi` executables through configuration or PATH; it does not admit or refuse clients by an exact vendor version. The Claude SDK library is a project dependency, not the user's Claude CLI.

- The MCP entry remains `packages/hud-mcp/bin/hud-mcp.mjs`.
- Existing caller-source registration uses `<HUD_HOME>/delegate.json`; do not substitute a shared owner for the real native session.
- Backend profiles optionally use `<HUD_HOME>/native.json`. If absent, `codex`, `claude`, and `pi` are default backend profile IDs. Explicit executable, args, environment and native options are supported.
- Read `integrations/skills/hud-delegate/SKILL.md` for the current tool schemas, native request responses and Claude background waiter. Old `delegate_spawn/report` recipes do not describe the new default entry.
- Pi wake is loaded once from `integrations/pi/hud-wake.ts`, alongside the delegation extension; it imports built code. Do not double-register the same listener.
- Jev calls the already installed `jev_ultrafast.Agent`; the thin Python bridge is included in packaged output. No browser model, credentials or browser installation is provisioned by these changes.

### Jev serial API and run observations

The existing Agent API is synchronous. `jev_run` returns the collected native yielded snapshots when its generator finishes; `jev_snapshot`, `jev_command` and `jev_close` on that instance wait behind an active run. Close is not an interrupt. The bridge forwards each actual generator yield as it arrives, without threads or interleaving Agent calls. `jev_list` and the HUD can read the latest received output with its original `source` and `receivedAt` timestamp while the run is still executing. This is a previously received native value, not a fresh snapshot request or a guarantee of continuous page updates. Refreshing the HUD does not refresh that timestamp. A caller timeout/disconnect does not stop, retry or close the Agent; blocked/CAPTCHA pages remain for explicit handoff or close. If a yielded value cannot be JSON-encoded, the bridge still consumes the native generator and reports an `observation_encoding` error afterward; it does not stop or retry the run to fix display output.

## Local checks still required

1. Start each native source through its configured identity path and discover managed/Jev MCP tools. Verify a different native session cannot access its child, even under the same configuration.
2. Create, send, read, and explicitly resume the same official session. Inspect actual native events, original callback payloads and response delivery.
3. Close the parent/MCP front end during a running synthetic or safe real task. Confirm the independent host continues, reconnect from the same native parent, and read official history. Closing a HUD panel or ending a wait must not stop the child.
4. Exercise native Codex queue, Claude native background-task notification and Pi triggerTurn with actual idle/busy parents. Queue acceptance is not evidence that the model read or acted on the event.
5. Run Jev through its existing browser environment; confirm blocked/CAPTCHA leaves the owned page open and snapshot display remains read-only. Close only by explicit request.
6. Check original native HUD rows, selection, model summaries, optional native details and direct-call rows in the real terminal. No new summary system was introduced.
7. Explicit interrupt and close must map to their documented native operation. A tool or external process continuing independently is not rewritten as stopped by HUD.

## Known verification limits

The execution environment prohibited Unix-domain socket listening (`EPERM`), including an explicitly requested elevated attempt. Socket-specific tests are marked SKIP; in-process composition and synthetic subprocess tests still ran. There are no claims of real provider/browser validation or installed terminal acceptance. Test results and independent review evidence are recorded in the implementation handoff; unresolved failures must not be presented as passed.
