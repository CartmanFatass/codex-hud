# Pi extension-context binding lab

This finite lab simulates a Claude-labelled parent and a Pi-labelled child. It runs no provider CLI or account. The synthetic child creates its own v3 session header and official-shaped extension context, independently of its synthetic launch claim. Its explicit report tool call produces a real binding/report through the existing MCP service, SQLite and supervisor. The panel shows that report while the scope remains live and its slot held, then shows actual scope end separately. A second request remains unbound and exercises cancellation; its final state may be unconfirmed. Same-key replay returns the original run even when the lab capability verdict is withdrawn.

```sh
npm run build
npm run build:hud-mcp
npm run build:test
node scripts/workbench/vertical.mjs --pi
node --test tests/workbench/pi-extension-context.test.mjs tests/workbench/pi-channel-state.test.mjs tests/workbench/vertical.test.mjs packages/hud-mcp/dist/tests/hud-mcp/pi-source-root.test.js
```

`--json` writes structured frames to stdout. The workbench uses a fresh, private temporary root and an allowlisted environment; it removes only directories it creates. The fixed reporter is a real direct child of the fixed synthetic runtime, with real Linux procfs stamps and ancestry. It never substitutes PID, argv or domain. The parent passes its synthetic claim privately in the child environment; the claim is never a source of session identity and is not put in a channel frame or output.

## Identity and scope

- Pi process source-root diagnosis requires exactly one separate `--session-dir` and absolute canonical existing directory immediately following the identified Pi entrypoint; it does not infer from HOME or cwd. This is physical diagnosis only. The ordinary production Pi call resolver remains unsupported, the default launch map remains Codex-only, and no shipped capability is promoted.
- The lab-only source uses the pinned v0.73.1 extension callback shape and captures only `toolCallId`, tool name, and `ctx.sessionManager.getSessionId()`, `getSessionFile()` and `getSessionDir()`. It does not read model arguments, the claim, RPC state or transcript bodies as identity. The independently checked session directory must match procfs-derived source. The file must be canonical, contained, regular and have a bounded v3 header matching the context session ID. A missing lazily persisted file is pending, not proof. The synthetic fixture creates only its own synthetic header.
- One private bounded sequential channel and one fixed reporter belong to one extension epoch. The helper independently rechecks its parent stamp, source, sequence, epoch and header before calling the normal `HudMcpServer` and `DelegationService` whoami/report interfaces. Session changes require a new epoch and cannot retarget the helper. The reporter is not selectable by tool metadata, configuration or an ambient user environment variable.
- Shutdown invalidates the local epoch and closes its owned reporter. A request not admitted after shutdown is refused. An already admitted write may have committed before cancellation arrives; a lost response is **unknown**, not rolled back and not automatically retried or transferred to a new epoch. This is not transaction-time revocation and does not qualify production Pi capability.
- This proves synthetic-context and real-process/ledger plumbing, not the identity of an official Pi binary or compatibility with a live provider. The source adapter is deliberately lab-only; no generic production Pi identity resolver is installed.

Pinned upstream evidence: [extension API and events](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/extensions.md), [extension types](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/extensions/types.ts), [session manager](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/session-manager.ts), and [CLI argument parser](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/cli/args.ts). RPC `get_state` remains observation only and never grants caller identity.
