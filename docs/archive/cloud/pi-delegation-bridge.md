# Opt-in Pi delegation bridge

This extension exposes the shipped `delegate_*` MCP tools inside the official
`@earendil-works/pi-coding-agent` **1.4.0** Node installation on Linux. It does not
replace the Pi interface, intercept Pi's native tools, or constrain the harness's
own agents. HUD-managed session creation remains **one level**: a managed child
cannot create another HUD-managed session. Existing authorization, claim,
idempotency and capability checks still apply.

The public extension API and lifecycle are pinned to
[Pi commit 4a080252f06caf63a525d7873c5d94d3c23887e0](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0).
Relevant sources are the official
[extension types](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/types.ts),
[session manager](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts)
and
[RPC lifecycle](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts).
Other Pi versions, Bun, native packaged binaries and other operating systems
are not supported by this bridge profile.

## Explicit use

Build both packages, use a private owned `HUD_HOME`, and select an existing Pi
profile in `HUD_HOME/delegate.json`. The profile must have `harness: "pi"`,
`source.root` equal to the canonical Pi session directory, and
`callSource: { "kind": "pi_extension_v1" }`. Those fields select the mechanism;
they do not attest a runtime or grant a capability. All normal required profile
fields still apply. A complete caller-only example is:

```json
{
  "version": 1,
  "profiles": [{
    "name": "pi-caller",
    "harness": "pi",
    "source": { "root": "/absolute/canonical/pi-sessions", "label": "Pi" },
    "launch": { "argv": ["/bin/false"] },
    "headless": null,
    "resume": null,
    "resumeHeadless": null,
    "host": { "kind": "none", "layout": "none" },
    "env": {},
    "mcpServerName": "hud",
    "claimTransport": "config_env",
    "clientToolTimeoutMs": null,
    "responseMarginMs": 1000,
    "orphan_policy": "continue",
    "managedShellVerified": false,
    "callSource": { "kind": "pi_extension_v1" }
  }]
}
```

The `/bin/false` launch field is deliberately not a working target backend.
Configure any delegation target separately using the project's existing
qualification and authorization flow. This delivery does not promote a launch,
resume, timeout or wake capability and does not ship a synthetic verified cell.

```sh
npm run build
npm run build:hud-mcp
HUD_HOME=/absolute/private/hud HUD_MCP_PROFILE=pi-caller \
  pi --session-dir /absolute/canonical/pi-sessions \
  -e /absolute/path/to/codex-hud/extensions/pi/hud-delegate.ts
```

`--session-dir` must be the first Pi option, in split form, with no duplicate
selector or `--` terminator. Symlinked/noncanonical roots are refused. The normal
npm `.bin/pi` symlink is resolved to the pinned installed entrypoint.

As with the existing MCP client flow, call `delegate_whoami` to establish the
caller context before read-only list/status tools. A non-delegated root can return
`claim_missing` after establishing that context; it has no managed-child claim.
Read-only tools do not fabricate a missing context.

`/hud-delegate close` fences the bridge and closes its owned MCP child.
`/hud-delegate reconnect` starts a fresh context epoch after cleanup. Session
start/reload, new/resume/fork and tree navigation perform the corresponding
lifecycle automatically. A cancelled switch/fork/tree remains conservatively
fenced; use the reconnect command to continue. An uncertain cleanup permanently
fences that bridge instance rather than launching a replacement alongside it.

There are no user-settings writes, global installation, automatic prompts or
provider calls in the extension itself. Loading it makes the tools available to
the harness; actual tool invocations remain subject to the existing MCP checks.

## Identity and failure behavior

- The host supplies only `sessionManager.getSessionId()`, `getSessionFile()` and
  `getSessionDir()` from each real tool callback. Tool arguments, environment
  session IDs, RPC state and arbitrary MCP metadata are never caller authority.
- Pi 1.4.0 changes `process.title`, erasing its OS argv. The owned child receives
  original argv/root over private fd3. It separately verifies direct parent PID,
  process start stamps, PID namespace/domain, Node executable and the installed
  package/entrypoint tuple, before registry initialization and on every call.
  No `ProcessReader` observation is rewritten to recover erased argv.
- A per-call random lookup ticket links MCP stdin to the private evidence frame.
  Sequence, epoch, tool name and call ID must match. Tickets are single-use;
  malformed, replayed, oversize or closed evidence streams fail shut.
- Both ends validate the canonical source/file, hold directory descriptors,
  reject symlinks/nonregular files, bound and hash the v3 session header, and
  pin inode/header identity. They never scan transcript content for a session.
- A missing persisted file is pending and starts no MCP server. Once that exact
  file is persisted it can become ready. A previously unassigned file path
  becoming assigned requires a new epoch; no path is guessed from the ID.
- Shutdown fences synchronously before cleanup. Concurrent reconnects wait for
  the same cleanup receipt. Aborted, disconnected or timed-out calls are not
  automatically retried, and admitted call IDs cannot be resubmitted during the
  bridge's lifetime. Existing structured MCP refusals remain errors.

This authenticates the supported owned host channel, not hostile same-UID code.
It is not a sandbox, code-signing check, or protection from another extension
that can mutate the Pi process or installed package. Configuration and synthetic
fixtures cannot establish production provider qualification.

## Reproduce the evidence

```sh
npm run build && npm run build:test && npm run build:hud-mcp
node --test tests/unit/pi-delegation-*.test.mjs
node scripts/check-cloud.mjs
node scripts/pack-cloud-preview.mjs
```

The normal `npm test` entrypoint builds HUD, test output and hud-mcp before
running the unit suites. Channel tests import ordinary `build:test` output.
The six synthetic full-host cases require Linux, Node22.18+ (22.x) or Node24+,
`registerHooks` and enabled built-in TypeScript loading. They explicitly skip
when those fixture capabilities are missing; the pure cleanup case still runs.
This fixture floor is distinct from the ledger's Node22.13 minimum and does not
change a production capability claim. On a supported fixture runtime, missing
hud-mcp build output is a failure, not a skip. SQLite is loaded only after the
full-host runtime gate.

The synthetic full-host fixture runs the product extension, real process reader,
private pipes, MCP server and temporary SQLite. Its synthetic installed package
is explicitly labelled and does not substitute a production resolver/capability.
Tests include pending persistence, version/entrypoint mismatch, source confinement,
replay, process loss, concurrent reconnect, lifecycle changes and uncertain
cleanup. The package preview includes the two explicitly allowlisted Pi extension
entries and their freshly built runtime dependencies.

An optional installed-official-client probe requires no credentials or model:

```sh
node tests/probes/pi-delegation-official.mjs /absolute/pi-coding-agent
```

It uses the real official loader, session context and process, with a synthetic
session and explicit callback calls. Its final `get_state` RPC command only lets
Pi honor the requested orderly shutdown. It is **not** a provider/native-agent
conversation test and does not certify model-driven tool selection, managed
launch/resume, or a full production deployment. Real-provider qualification is
NOT_RUN and is not a prerequisite for this cloud development delivery.
