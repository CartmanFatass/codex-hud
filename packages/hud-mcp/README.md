# hud-mcp (B1 skeleton)

This package exposes seven stdio MCP tools: `delegate_spawn`, `delegate_resume`,
`delegate_wait`, `delegate_status`, `delegate_cancel`, `delegate_whoami`, and
`delegate_report`. Arguments are validated against strict schemas. Every tool body
is a typed `not_implemented` stub; an unverified call instead returns
`identity_source_missing`, `identity_unverified`, `unsupported`, or `stale_context`.
No claim is consumed, task launched, context authorized, or report accepted.

The [B1 call-source report](../../docs/probes/b1-call-source.md) records the actual
harness limits. Claude's default public transcript path is fail-closed, including
when a call record happens to be available. The tested Codex metadata/header/
process combination can resolve a root SessionRef as diagnostic evidence. A
resolved SessionRef is not a CallerContext, OwnerKey, child binding, or permission.
Before adding executable bodies, B2/B5 must select/revalidate the current context
in the reconciler transaction across all MCP instances, including old in-flight
calls. Local resolver invalidation alone does not implement that distributed gate.

## Runtime and commands

| Entry | Node requirement |
| --- | --- |
| Existing HUD bar (`src/index.ts` / root `npm start`) | >=18 |
| `bin/hud-mcp.mjs` | 22.x >=22.13 or >=24 (23 unsupported); checked before importing the implementation |
| Future B2 ledger integration (`node:sqlite`) | 22.x >=22.13 or >=24 (23 unsupported) |
| Process benchmark | 22.x >=22.13 or >=24 (23 unsupported); prints a skip reason on older Node |

The package currently uses no SQLite and adds no dependencies. The stricter entry
version reserves B2's unflagged SQLite/readOnly runtime without changing the bar's root `engines`.

```sh
npm run build:hud-mcp
npm run test:hud-mcp
node tests/hud-mcp/benchmark.mjs
HUD_HOME=/tmp/synthetic-hud HUD_MCP_PROFILE=synthetic \
  node packages/hud-mcp/bin/hud-mcp.mjs
```

`HUD_HOME` must be an explicit absolute directory. Optional
`HUD_MCP_PROFILE` selects a configured profile by exact name. An absent
`delegate.json` or unselected profile permits tool discovery and fail-closed
stubs, with no session resolution. An existing invalid configuration fails
startup with `configuration_invalid`. Diagnostics go to stderr; stdout is only
newline-delimited JSON-RPC. Input records are capped at 256 KiB.

## delegate.json

The envelope is `{version:1, profiles:LaunchProfile[]}`. Each profile reuses the A4
`LaunchProfile` type, extended only with optional
`roles: Record<string,{model:string,effort?:string}>`. Roles are validated and
reserved for B4. Unknown keys are rejected at every structured level. Source
roots must resolve to existing directories and are canonicalized using realpath.
Templates are exactly `{argv:string[]}` or `{shell:string,shellPath:absolute}`;
nullable templates explicitly disable the corresponding operation. A declared
`managedShellVerified` flag never upgrades a product capability cell.

Synthetic example (create the source directory before loading):

```json
{
  "version": 1,
  "profiles": [{
    "name": "synthetic",
    "harness": "codex",
    "source": {"root": "/tmp/synthetic-codex", "label": "Synthetic"},
    "launch": {"argv": ["codex", "{{prompt}}"]},
    "headless": {"argv": ["codex", "exec", "{{prompt}}"]},
    "resume": null,
    "resumeHeadless": null,
    "host": {"kind": "none", "layout": "none"},
    "env": {},
    "mcpServerName": "hud",
    "claimTransport": "config_env",
    "clientToolTimeoutMs": 60000,
    "responseMarginMs": 2000,
    "orphan_policy": "continue",
    "managedShellVerified": false,
    "roles": {"implementer": {"model": "synthetic-model", "effort": "low"}}
  }]
}
```

Timeout values are configuration, not proof of a measured client deadline. There
is no wait body yet. Resource constraint configuration is deferred pending ARCH;
it is not accepted as an unknown profile field. All command execution, template
selection, capabilities and per-launch claim/env injection belong to later WPs.

## Integration ports and bounds

- `CallerRegistryPort.register(Caller, Source|null)`: B2 supplies the ledger
  implementation. Registration records physical MCP pid/start, its actual
  parent pid/start, cwd, inferred harness/source hints, pane hint and timestamps.
  It grants no logical identity. `MemoryCallerRegistry` is the default fake;
  setting `HUD_MCP_REGISTRY_DIR` explicitly selects a private, atomic file fake
  for acceptance dumps. It is not a substitute ledger or context authority.
- `CurrentCallSourcePort`: receives only the genuine transport `params._meta` and
  tool name, never model-supplied arguments. B5 consumes validated source evidence
  together with B2's transactional generation/claim/binding checks. The skeleton
  never returns identity or claims in its tool results.
- `ProcessReaderPort`: bounded Linux `/proc` reads, at most eight ancestors, only
  HOME/CODEX_HOME/CLAUDE_CONFIG_DIR environment values retained. Recheck process
  stamps around evidence reads. `HERDR_PANE_ID` is a locator hint only. ProcessKey
  includes machine identity, boot ID and PID namespace.
- `SessionRecordLocatorPort`: exact Codex UUIDv7 suffix, UTC creation day +/-1
  (harness directories use local dates), one total 4096-entry/10 ms directory
  budget; ambiguous/missing/over-budget results refuse. Read at most 256 KiB of
  the selected rollout header. No cwd/newest-session selection or transcript
  content scan. Non-v7 and archived paths need a later exact index port.
- Claude checks the exact live pid registry (16 KiB), then only a 64 KiB tail of
  its precise root public transcript and exact tool-use ID/name. Missing records
  refuse; duplicates/contradictions refuse. No root identity is inherited from
  env, a previous call, claim, or process ancestry. There is no polling, delayed
  transcript retry, or installed hook.
- `resolvePiSession` is a standalone resolver only: exact absolute `--session`
  file, or `--session-id` with an explicit exact-ID locator callback, then a
  matching source/header. `--fork` and directory-only hints fail. pi MCP loading and binding
  remain C1.

All seven bodies are intentionally unwired. Do not attach a handler directly to
`CallResolution.ok`: it is evidence, and does not establish a current authorized
context or revalidate an old request at its commit point.

## End a headless delegation

`delegate_close({linkId, expectedRun, request_key, grace?})` ends a confirmed,
current-owned headless relationship. Only its authenticated current parent may
request it. `grace` is 0–60000 ms (default 10000); expectedRun and request_key are
mandatory and unknown fields are rejected. Cancel stops a run while retaining
possible resume; close permanently fences new resume/handover for this link.

`ok:true` and `outcome.status:accepted` mean durable acceptance, not process exit.
Inspect `current.closeState` or delegate_status/list/wait: unknown cleanup stays
pending, changed relationships are incompatible, and only independently proven
termination can produce closed. `current` may be null after a committed result.
Retrying the same key returns the original immutable outcome without advancing
cleanup; a changed request conflicts. Existing cancellation grace/clock is retained.
No visible/local-manager close, reopening, send/ask, surface operation or deletion
of sessions, reports, code or history is included. Generic mvpOperationPolicy(close)
remains unsupported; this qualified MCP entry is its only approved exception.
