# One-level HUD delegation

The owner-selected model is one level of **new independent harness sessions**
created through HUD MCP. A verified root may create managed children, subject to
existing capacity and capability gates. A managed child cannot use HUD MCP to
create another new session. This does not set a one-child concurrency limit.

The independent harness's native subagents, execution model and internal tree
are outside this restriction. HUD does not disable or intercept native agent
tools. Historical deeper HUD relationships remain readable under their existing
owner scopes; existing-session lifecycle operations are retained.

## Acceptance boundary

`delegate_spawn` returns `nested_delegation_not_supported` for a fresh new-session
intent when either of these restrictive signals applies:

- The MCP service started with any of `HUD_RUN`, `HUD_LINK` or `HUD_CLAIM` present.
  Empty, partial, unknown or contradictory values still restrict. This flag is
  captured at service construction and is not a tool argument or authority grant.
- The independently resolved caller's complete SessionRef matches any durable
  `runs.target_session_ref`. The lookup uses the existing `runs_target` index,
  not a current-binding-only lookup or an unbounded ancestry traversal. Terminal
  runs, revoked bindings, historical links and server/store restarts do not turn
  the same managed identity into an unrestricted root. Matching only sessionId
  is insufficient: source and thread identity also have to match.

Caller authorization and exact idempotency replay happen first. A previously
accepted intent returns its original result without another launch, even when
that historical caller is now restricted. A conflicting request key still
conflicts. The new guard precedes capacity, capability acceptance and all new
intent writes: refusal creates no link, run, claim, slot, idempotency result or
accepted event, and dispatches no process.

`delegate_whoami`, `delegate_report`, `delegate_resume`, cancellation and the
read tools keep their existing authorization. Same-owner `predecessor` handover
reuses an existing SessionRef rather than creating a new session, and retains
its normal lifecycle and cycle gates. This change grants no new lifecycle rights.

## Provenance limit

The supported managed launch path supplies the HUD markers to its MCP service,
which covers the interval before successful `delegate_whoami`. After binding,
the durable SessionRef also covers marker loss and restart. A manually modified
launch that strips every marker before the first binding is outside that launch
provenance contract. The guard does not claim to sandbox an independently
controlled harness, scan arbitrary processes/transcripts or prevent deliberate
replacement of its configuration/store. No new persistent schema is introduced.

## Cloud regression coverage

`tests/hud-mcp/delegation.test.ts` covers marker-only pre-bind denial, stable MCP
refusal output, marker capture, caller authorization, atomic refusal, terminal and
revoked durable identity after reopening the ledger, accepted historical replay,
owner-scoped list/status/wait, resume/handover, full source/thread isolation,
inconsistent current-binding state, and verified whoami/report. Existing MCP
handshake, authorization, list and expected-run suites remain applicable.

These tests use temporary homes and synthetic launch functions. They validate
cloud backend behavior, not live Codex/Claude/Pi capability or local installation.
The existing production wall-clock budgets remain unchanged; a budget refusal in
a loaded test environment is recorded, not converted into a successful result.
