# Authenticated links as an embedded MCP resource

This first task-7 increment adds `format: "resource"` to the existing
`delegate_list` tool. Omit `format`, or use `"json"`, to retain the original
text and `structuredContent` response. The resource option calls the same
owner-scoped read service once, after resolving the exact `delegate_list`
source identity. It does not enable another read route.

## Request and response

Send a normal authenticated MCP `tools/call` request with
`name: "delegate_list"` and arguments such as
`{ "format": "resource", "limit": 20 }`. Identity evidence stays in the
existing call metadata channel. Arguments cannot select an owner, source,
path or URI. The existing limit and cursor rules remain unchanged.

A successful resource-format response contains a short explanatory text block
and one MCP embedded resource:

```json
{
  "type": "resource",
  "resource": {
    "uri": "hud://links/<opaque-page-snapshot-sha256>",
    "mimeType": "application/json",
    "text": "<JSON-encoded owned-links-page>"
  }
}
```

The original service outcome remains in `structuredContent`. The text block
does not repeat that outcome, avoiding a third serialized copy. The resource
is an in-memory detached projection, not a generated document, persistent
cache, subscription or automatic share. Arbitrary `outcome.content` and
`outcome.resource` values cannot become protocol content blocks.

The URI hashes the projected page and verified source/scope identity. It is
not a bearer credential, cross-owner receipt, cursor or durable read handle.
No service remembers it. Reusing a URI cannot authorize any later request.

## Payload contract (schema version 1)

- `schemaVersion: 1`, `kind: "owned-links-page"`.
- `availability: "committed-metadata-only"` describes this representation,
  not current freshness, a live process check, a complete tree or the absence
  of other links.
- `hasMore` and `nextCursor` are copied from the authorized page. Request
  subsequent pages explicitly using the existing cursor. There is no loop
  across pages and no total-count claim.
- `items` contains at most 50 entries. Public scalar fields are limited to
  `linkId`, `runId`, `backend`, `role`, `linkState`, `runState`, `childRef`,
  and `isCurrentRun`, `currentOwner`, `slotHeld` when actually present.
- `childRef` includes only harness/source/session/thread identity fields.
- `observationAvailability` preserves the original current/stale/unavailable
  value. `observationStamp` retains only its original sequence domain,
  commit/input-ledger sequences, reference, run and binding/source generation
  fields. Observation stamps are never advanced by the resource read.
- `statusProjection` is reduced to closed activity, pending reason, last-turn
  outcome and liveness values, plus existing terminal/sequence/time scalars.
  `freshnessNow` contains only its existing state, stale-since time and clock
  anomaly flag. Omitted values stay omitted; null remains unknown.

There are no model summaries, state-key text, labels, paths, brief/report or
transcript bodies, claims, error strings or arbitrary nested freshness source
records in the embedded projection. Existing `structuredContent` is unchanged
and retains its prior public service contract.

Encoded UTF-8 resource text is capped at 128 KiB, independently of JavaScript
string length. A page that exceeds either bound returns the sanitized tool
failure `{ "ok": false, "code": "resource_too_large" }`, without a partial
resource. The service's identity, stale-context and invalid-cursor refusals
are retained. Cancellation or shutdown during an async resource read also
discards the page. No extra ledger write, effect journal, capability check,
launch, harness process or provider call is added.

## Authentication boundary and deliberately unsupported work

Initialization still advertises only tools. `resources/list`,
`resources/read` and `resources/templates/list` return method-not-found,
including requests naming a genuine `hud://links` URI. Native resource
requests do not carry the authenticated per-tool evidence used by the
selected integrations, so no anonymous reader, filesystem export,
`hud://tree` endpoint or metadata workaround is provided.

Existing source contracts remain Codex 0.166.0, Claude
2.1.305/claude-hook-2, and the Pi 1.4.0 extension. Claude's hook set already
includes `delegate_list`; Pi imports the shipped tool schema. This increment
does not change either bridge, capability manifests or supported versions.

Native resource discovery/read authentication is follow-on work. Send/ask is
not resume or stdin write, and visible-window close is not process killing.
Neither feature is implemented here.

## Synthetic verification and local handoff

`tests/hud-mcp/links-resource.test.ts` covers the projection and MCP response,
exact 50-item/128-KiB limits, unchanged JSON defaults, schema rejection,
closed nested fields, scope-bound identifiers, refusal and cancellation.
Its callback source is explicitly a server/service composition seam.

`tests/hud-mcp/links-resource-source.test.ts` separately uses the production
`SessionRefResolver`, `DelegationService`, `ReadControlService` and a temporary
ledger from the original handshake fixture. It adds canonical-UUID actors
with trusted-session records, bounded synthetic rollout headers and the
pinned Codex metadata shape used by the existing source tests. Only the
existing process, locator and scope ports are injected. No unconditional
successful resolver replaces source verification. Scenarios include root,
thread, source, version, process-start and namespace forgery, source identity
collision, retired context/scope, stale captured premises, empty-page
authorization and owner/context cursor replay. Ledger rows are compared
before and after reads; launch/capability ports fail if invoked.

These fixtures are synthetic identity-conformance inputs, not proof of an
installed client's identity or rendering, and do not require real accounts.
Do not block implementation on unavailable real-provider checks or replace
missing checks with a broader production claim. The owner canceled the
project repair-count quota; independent exact-tree review, scope and security
limits still apply.

Run on supported Node 22.13+ or 24 with the repository's locked dependencies:

```sh
npm ci
npm run build
npm run build:test
npm run build:hud-mcp
node --test packages/hud-mcp/dist/tests/hud-mcp/links-resource.test.js packages/hud-mcp/dist/tests/hud-mcp/links-resource-source.test.js packages/hud-mcp/dist/tests/hud-mcp/delegate-list.test.js packages/hud-mcp/dist/tests/hud-mcp/skeleton.test.js packages/hud-mcp/dist/tests/hud-mcp/hook-source.test.js packages/hud-mcp/dist/tests/hud-mcp/pi-source-root.test.js
```

Also run `node --test tests/unit/pi-delegation-bridge.test.mjs` and relevant
existing MCP source/server tests when their required build outputs exist.
Keep baseline suites unchanged. Record each actual command and exit status;
source inspection is not a compiler or runtime pass. If locked dependency
installation or emission is unavailable, mark the build-dependent checks
`NOT_RUN` with the exact environmental reason. Do not borrow a compiler,
transform TypeScript, change executors or use a network workaround.

Delivery labels:

- `PRODUCT_EMBEDDED_LINKS_RESOURCE_IMPLEMENTED`
- `SYNTHETIC_IDENTITY_CONFORMANCE_NOT_RUN` in the current cloud handoff:
  Node 24.22.1 is present, but repository TypeScript dependencies are absent.
  Update the evidence classification only after executing the actual suites.
- `REAL_CLIENT_RESOURCE_RENDERING_NOT_RUN`
- `NATIVE_RESOURCES_READ_NOT_IMPLEMENTED`
- `SEND_ASK_NOT_IMPLEMENTED`
- `VISIBLE_CLOSE_UNSUPPORTED`

This is one useful bounded resource slice, not completion of every task-7
feature. Publication belongs on the dedicated test branch after independent
review, without changes to main, integration or capability status.

## Protocol references

- [MCP 2025-06-18 tools and embedded resources](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP 2025-06-18 TextResourceContents](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)

The embedded-resource content block does not imply native resource
list/read support or require advertising that unavailable capability.
