# A2b — Codex connection-native role admission

## 1. Recommendation

Keep ordinary daemon-backed Codex role admission fail closed for this package's current evidence; **do not implement a log-to-TUI guessing bridge or trust the whole `_meta` object**. There is a promising, narrower native candidate: **top-level `params._meta.threadId`**. In the installed Codex 0.167.0, a two-client, two-thread, zero-model local RPC probe showed that app-server injects this field and overwrites an attempted conflicting value with the RPC's target thread. The same probe showed that `sessionId`, `callId`, `itemId`, and nested `x-codex-turn-metadata` can pass through from that RPC client. This establishes neither model-path stamping nor isolation against a second client targeting another thread, nor the lifecycle evidence needed at A2's final fence. Consequently, no complete reliable admission path is established yet. Qualify this candidate with the targeted check below before commissioning positive admission; meanwhile preserve the six tools, return `identity_unverified`, and disclose the Codex limitation at A8 activation. This is an evidence-limited conclusion, not a claim that Codex never supplies thread metadata or that a solution is impossible.

## 2. Reasons and evidence

1. **Observed repository state:** inspection was against `ebe454358960ee8b7751a1a8888704cafbea9373` (`git rev-parse HEAD`). A2 already resolves on every call, pins physical ancestry, and rechecks immediately before facade dispatch: `src/roles/caller-resolve.ts:14`, `src/roles/caller-resolve.ts:18`, `src/roles/caller-resolve.ts:34`, `packages/hud-mcp/src/role-source.ts:24`, `packages/hud-mcp/src/role-extension.ts:24`. A2's ordinary 0.167.0 smoke recorded MCP → adapter → app-server daemon → TUI and refusal, not successful admission (`tmp/tasks/R6A-A2/report.md:114`; `docs/reviews/2026-11-09-r6a-a2-review-2.md:21`). **Inference:** stepping past the daemon to its founding TUI would misattribute other threads served by that daemon.

2. **Observed log semantics:** the collector correlates startup `thread/start|resume|fork` requests/spans, daemon connection IDs, and later thread responses (`src/collectors/daemon-binding.ts:78`, `:132`, `:189`, `:252`). Its strict mode rejects ambiguous and pre-existing connections; review 1 demonstrated a foreign-session attribution when the history check was absent (`docs/reviews/2026-11-09-r6a-a2-review-1.md:7`; review 2, `:9`). **Inference:** even exact correlation of a startup TRACE request to its span answers “which thread did this app-server request open?”, not “which thread emitted this separate MCP request?”. MCP JSON-RPC IDs and app-server RPC request IDs are distinct namespaces. Their numeric/string equality or proximity is not a join. These SQLite tables, logging targets, span text, client-name strings, and retention behavior are implementation evidence, not a public authorization protocol.

3. **Observed historical metadata, with a material limit:** 0.166.0 model-driven probes recorded `sessionId`, `threadId`, `callId`, `windowId`, `itemId`, and `x-codex-turn-metadata`; initialize had no session, and tools/list only had a progress token (`docs/probes/codex-mcp-launch.md:61`). Argument spoofing did not overwrite envelope metadata, but the report explicitly left stamping/overwrite provenance unverified (`:79`, `:99`). Its daemon supplement did **not** exercise today's daemon-owned MCP topology (`docs/probes/codex-daemon.md:130`). Native children can retain their parent's `sessionId` while `threadId` names the child (`docs/probes/b1-call-source.md:75`). **Inference:** neither the historical success nor a parent-looking `sessionId` can establish current root authority.

4. **Observed installed protocol:** `~/.local/bin/codex --version` returned `codex-cli 0.167.0`. `app-server generate-ts --experimental --out <temporary directory>` returned exit 0 and generated:

   ```typescript
   type McpServerToolCallParams = {
     threadId: string;
     server: string;
     tool: string;
     arguments?: JsonValue;
     _meta?: JsonValue;
   };
   type DynamicToolCallParams = {
     threadId: string; turnId: string; callId: string;
     namespace: string | null; tool: string; arguments: JsonValue;
   };
   ```

   These are **app-server client-facing** types, not evidence that an MCP child receives all these fields with protected provenance. The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) documents `mcpServer/tool/call`, thread-scoped MCP inventory, and experimental dynamic-tool callbacks. The [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) documents registration and transports; it does not establish the thread-stamping or cross-client authorization guarantee needed here. Publicly described APIs are distinguishable from the incidental fields observed below; the installed CLI labels schema generation experimental. No version-number allowlist or historical capability manifest is proposed (`docs/contracts/05-capabilities.md:3`).

5. **Observed new direct-RPC probe, authorized by `qa/q1.answer.md:1`:** fresh temporary HOME/CODEX_HOME, empty synthetic workspace, no auth file, a synthetic provider configuration, and a local stdio stub. One task-owned app-server listened on a temporary Unix socket; two independent WebSocket clients created ephemeral THREAD_A and THREAD_B without starting turns. Each thread discovered its own stub MCP process. An unshared network namespace prevented external connectivity. No `turn/start`, provider inference, live daemon access, or HUD job was used. Both direct MCP calls returned `synthetic-ok`.

   The relevant received shapes, with task-created IDs normalized to synthetic labels, were:

   ```json
   {
     "method": "initialize",
     "params": {
       "protocolVersion": "2025-06-18",
       "capabilities": {
         "elicitation": {"form": {}, "url": {}},
         "experimental": {"codex/auth-change": {}}
       },
       "clientInfo": {"name": "codex-mcp-client", "title": "Codex", "version": "0.167.0"}
     }
   }
   ```

   Both MCP children received this same client identity and no thread identity during initialize. Both tools/list calls carried `_meta: {"progressToken": 0}`.

   ```json
   {
     "method": "tools/call",
     "params": {
       "name": "probe",
       "arguments": {"case": "ordinary-A"},
       "_meta": {"threadId": "THREAD_A", "progressToken": 1}
     }
   }
   ```

   Client B next called the RPC with **outer `threadId = THREAD_B`**, but supplied `_meta.threadId = THREAD_A`, `_meta.sessionId = THREAD_A`, and nested A identity. B's MCP child received:

   ```json
   {
     "method": "tools/call",
     "params": {
       "name": "probe",
       "arguments": {"case": "B-claims-A"},
       "_meta": {
         "threadId": "THREAD_B",
         "sessionId": "THREAD_A",
         "callId": "forged-call",
         "itemId": "forged-item",
         "x-codex-turn-metadata": {
           "session_id": "THREAD_A",
           "thread_id": "THREAD_A",
           "turn_id": "forged-turn",
           "thread_source": "user",
           "codex_version": "0.167.0"
         },
         "progressToken": 1
       }
     }
   }
   ```

   **Inference, bounded to this path:** top-level threadId is injected/overwritten from app-server's RPC target; the other tested fields are caller-controllable here. Requiring merely a valid UUID and an existing matching rollout would not authenticate those other fields: another session can name an existing thread. Top-level threadId's protected treatment on this direct-RPC path is a candidate, not a demonstrated model-path guarantee.

6. **Explicitly unverified:** no model-issued tools/call on 0.167.0 was captured in this task; no attempt was made by client B to set the **outer RPC target** to THREAD_A; no resume/fork/switch/cancellation race was exercised. The two observed MCP processes do not prove exclusive per-thread transports in every configuration or across lifecycle changes. An app-server subscriber observing native `item/started`/`item/completed` would still need a protected exact correlation to the arriving MCP request; observing a thread/event is not authorization to act as it. Dynamic tools would require owning the client integration, and would not be the ordinary TUI's registered MCP path.

7. **Observed but insufficient leads:** read-only binary-string inspection found `mcp_request_meta`, `codex/connection-lease`, `codex/connectionLease`, and a duplicate-metadata error. This establishes only that those strings occur in the installed program. The ordinary stub handshake did not advertise a connection-lease identity contract. No lease contents, thread mapping, authentication, or expiry semantics were established. Do not invent a protocol from these names or enable an undocumented flag as an admission fix.

8. **Settled product constraints:** six static tools and main-session chaining remain (`docs/universal-hud-concept.md:769`); records do not steer the orchestrator (`:864`). A8's registration may point at a HUD-owned entry under `$HUD_HOME`, but a static config entry supplies no per-call thread identity (`tmp/tasks/R6A-PLAN/design.md:43`; concept `:919`). A wrapper can preserve native metadata, not manufacture its provenance. Existing source/identity contracts retain native isolation without reinstating the old ledger/grant machinery (`docs/contracts/01-identity.md:3`).

### Probe completion and limits

The first transport attempt used newline JSON on the Unix socket and failed before initialization: 0.167.0's Unix listener expected a WebSocket handshake. The corrected probe used WebSocket framing and completed the two calls above. Both attempts reported `CLEANUP remaining live task processes 0`; owned process start stamps were checked before signalling, child processes were reaped, and both temporary probe directories were removed. Temporary schema-generation directories were also removed. No auth files were copied or created; no live configuration/state was read or modified. The installed executable was inspected through its permitted symlink. Background plugin discovery attempted network access and failed inside the isolated namespace; this was not a provider/model request. No application tests, source changes, git mutations, installs, or subagents were used. Synthetic examples above are observations normalized from the temporary probe, not captures from a personal session.

## 3. For the implementer

### Deliverable now: explicit safe unavailability

Keep the present per-call resolver and final facade fence. For an ordinary Codex daemon-owned MCP call without qualified native provenance, return the existing `{ "ok": false, "code": "identity_unverified" }`, with MCP `isError: true`, as `packages/hud-mcp/src/server.ts:147` already does. Preserve `identity_source_missing` for unavailable physical evidence and `stale_context` for a changed pinned process/context. Do not look up job contents, selections, receipts or idempotent results before admission; do not launch, send, answer or close anything on refusal.

**No role tool becomes anonymously available, including `hud_roster` and `hud_read`.** `hud_roster` also selects a session preset; `hud_read` requires owner identity and can refresh job state. Although the underlying roster facade has identity-free list behavior, the MCP surface intentionally authenticates every call (`src/roles/facade.ts:979`, `:1309`, `:1783`; `packages/hud-mcp/src/server.ts:131`). Keep initialize, ping and tools/list available as protocol discovery, with exactly the existing six schemas. These are not a substitute read-only role interface. Existing passive panel/native-session observation remains available under its existing rules; no new cross-session MCP read bypass or automatic fallback to another harness is added.

A8's activation result/help should state: **“HUD role calls are unavailable in this Codex connection because HUD cannot verify the calling thread. Passive HUD observation remains available.”** Keep the finite error code intact. Document this explanation in the integration guidance; do not rely on repeatedly prompting the model to retry, supply an ID, relaunch, or use a hidden transport. Activation may register the MCP and verify discovery, but must not label that “role admission verified.” This A8/documentation coordination belongs to the orchestrator. No extra tool, identity argument, state file, daemon or credential is required for this cut.

### Candidate positive design, conditional on provenance qualification

Do **not** implement the following as an enabled fallback solely from this report. If the qualification below establishes all premises, the smallest design is a Codex-specific per-call resolver using protected native metadata, with no TUI connection search:

- `src/roles/caller.ts`: reuse physical ancestry/start-stamp and canonical native-store discovery. An app-server ancestor proves physical transport ownership and its source root, not a TUI or logical session. Never use MCP arguments or a newly injected env thread ID to choose that root.
- `packages/hud-mcp/src/role-source.ts`, optionally one small `codex-role-source.ts`: use only genuine envelope `params._meta`, received through `CurrentCallSourcePort`. Parse the **qualified exact native thread field**, initially top-level `threadId` as the candidate. Missing/malformed evidence refuses; contradictions refuse rather than choosing the convenient ID. Do not use `sessionId`, nested turn metadata, clientInfo or a native-looking callId as independent authority. Copy the needed validated scalars into an immutable per-call capture, not a process-global “current thread.”
- Resolve the native thread under the independently established source root with bounded read-only lookup. Confirm its native identity and source kind; missing, conflicting or inaccessible native records refuse. A record corroborates existence/source, not who issued the call. Preserve existing root/native-child admission policy; never substitute the root `sessionId` for a child `threadId` or project via `rootThreadOf`. The new source must express Codex's exact thread in `sessionRef.sessionId`, with `threadId: null`, matching the repository's identity model.
- Keep a per-call internal ID; do not trust the tested pass-through `callId` for authority or consume/replay protection. Existing role request keys remain the business idempotency mechanism.
- Keep the current WeakMap admission callback and synchronous `RoleFacadeTools.invoke` fence. The Codex callback must revalidate the captured physical instance/source and the **qualified request/transport validity premise** immediately before dispatch. Do not re-run the old TUI-log resolver for a daemon, and do not compare against the daemon's globally latest thread. Comparing a captured metadata object to itself is not a freshness check. Qualification must establish either a native per-thread transport whose lifecycle invalidates obsolete calls, or an equivalent current native epoch/request proof. If neither exists, positive admission remains unavailable; a HUD-generated epoch does not repair that gap.
- `src/roles/caller-resolve.ts`: preserve existing Claude/direct-native behavior; factor only the physical pin if needed. `src/collectors/daemon-binding.ts`: no A2b authority expansion; its display path and A2 strict refusals stay unchanged. `role-main.ts` retains the role-only composition, private HUD-home validation and parent lifetime. `role-extension.ts` remains the final admission boundary. Do not import the retired execution host.

A8 may configure the entry and HUD_HOME as already decided. A per-install token shared by every Codex session, a static thread variable, a wrapper PID, or a “single current session” restriction does not establish per-call origin. Do not change the user's Codex daemon mode or install hooks to work around this without a separately evidenced design.

### Qualification: the one live check to request

Request **one controlled two-session exact-thread provenance scenario** from the orchestrator, not an implementation acceptance claim: on the actual installed ordinary daemon-backed TUI path, use two synthetic sessions under temporary homes and a recording stub. Have A and B each issue a model-driven stub call, with B instructed to put A's synthetic identity in tool arguments; capture the genuine envelope and independently recorded native thread identities. In the same scenario, test a second native API connection targeting A directly and with forged metadata, and delay one call across a session transition/cancellation to observe validity at the admission boundary. Root → native child → root is a negative attribution control if native children are supported in that scenario.

The deciding result is a protected field that names the exact originating native thread on the model path, cannot be redirected into another thread by the supported alternate API path, and has a valid lifecycle/final-fence premise. A successful ordinary call alone does not satisfy this. A version-matched native implementation trace or documented upstream contract should explain the overwrite and lifecycle rules; bounded black-box successes cannot prove every alternative path. This scenario was **not run**; q1 expressly reserves model/provider permission to the orchestrator. If its result is incomplete or negative, keep the safe behavior above and request the upstream contract below.

### Test plan — observed-shape fixtures and negative controls

Use synthetic fixtures in `tests/hud-mcp/role-source.test.ts` and the actual shipped entry test in `tests/unit/role-entry.test.mjs`; extend existing fixtures only as needed. Never store real thread IDs, homes, logs, auth, or program output in public fixtures. For the fail-closed cut, only refusal/discovery/documentation checks are needed. Positive cases below belong to the candidate implementation **after** its native premise is qualified.

1. **Actual role-entry refusal.** Daemon ancestry plus the observed initialize/list shapes, with missing or unqualified call metadata, refuses all six schema-valid calls. Exactly six tools still list. Spy at facade/executor boundaries and assert zero selection/receipt changes and zero execution; known job IDs and same-key retries must not bypass admission. **Must go red** if failure resolution is bypassed or reads/roster are exempted.
2. **Observed direct-RPC metadata conflict.** Use the B-claims-A shape above verbatim with synthetic IDs. It must never authorize A; under the proposed conservative conflict rule it refuses. A matching native A record must not rescue the forged fields. **Must go red** if sessionId or nested thread_id wins over the protected field, or metadata plus record existence is treated as provenance.
3. **Qualified per-call isolation.** After the premise is established, interleave A/B calls sharing daemon/source/cwd and identical RPC IDs on different transports. A's preset, jobs and same-key results remain A's; B cannot read/control them. Test different source roots with the same synthetic thread ID. **Must go red** if authority is cached at startup, keyed only by daemon PID, copied from the last call, or keyed by thread without source.
4. **Final fence and cancellation.** Delay source resolution, then replace/recycle the physical owner, change the qualified native epoch/transport binding, cancel, or close the input before dispatch. Refuse without side effects. Resume/new/fork must follow the proven native lifecycle; unrelated B activity must not invalidate A merely because a daemon log's latest thread changed. **Must go red** if the final callback is skipped, compares only captured values, or uses global latest-thread authority.
5. **Hostile/confused claims.** Cover arguments._meta, ordinary env thread IDs, forged clientInfo, absent/oversized/wrong-type envelope fields, contradictory root/child IDs, and uncorroborated native records. Verify direct-RPC target spoofing according to the qualified native contract; if the upstream permits indistinguishable foreign-thread impersonation, this is a failed premise, not a test to weaken. **Must go red** if any candidate hint becomes authority without that premise.
6. **Existing boundaries.** Retain A2's pre-existing-connection, unmatched TRACE, simultaneous-TUI, PID reuse, shared tolerance, Claude rebinding and pi final-epoch tests. Retain role-only import/discovery checks. No change to display ranking, six schemas, routing semantics, chaining, job ownership or Herdr/Jev execution.

Run targeted real-entry/resolver tests for changes and the repository's current integration merge checks when an implementation exists. Run mutation controls on an isolated implementation checkout and restore them; this advisory task did not mutate code or claim those tests passed. Native qualification, synthetic implementation tests, and provider-backed acceptance must be reported separately.

### What Codex would need to expose if the candidate fails

A documented, runtime-authored per-invocation identity on the MCP side: exact native thread identity and source/transport association, protected against tool arguments and app-server client `_meta` overrides; explicit treatment of root versus native child; and lifecycle validity/revocation semantics suitable for a final admission check. If app-server clients may freely target any loaded thread, the contract must distinguish target selection from the originating authorized call, or supply a native access boundary/opaque request proof bound to that invocation and transport. A signed token is not inherently necessary on a private authenticated local channel; a self-reported JSON field is not enough. It must define reuse across resume/fork/reconnect and provide a way to refuse stale or replayed proof. Logging timestamps, a client-supplied name, an unbound request ID, and an env bearer shared across sessions do not meet this requirement.

## 4. Risks and cuts

- The protected top-level threadId is a real new lead. Calling it absent would discard useful evidence; calling it fully trusted would overstate a direct-RPC experiment.
- A hostile client can supply all tested nested/session/call fields. Changing the outer RPC target may be possible; it was not tested and must not be assumed forbidden. A model calling a normal MCP tool cannot directly set the envelope through ordinary arguments in the older bounded probe; that is a different attack surface.
- This protects native logical-session attribution, not against arbitrary same-UID malware replacing binaries, writing the native store or editing HUD data. Do not describe the local native evidence model as an OS security boundary it does not have.
- Freshness is separate from field provenance. A protected thread ID without a usable native lifecycle premise does not reproduce A2's final fence.
- No new logging parser, authentication framework, durable context registry, polling service, broad version gate, read-only MCP bypass, native launcher, daemon replacement, or workflow controller is justified by this request.
- Safe delivery leaves ordinary Codex role execution unavailable. Record that limitation explicitly; preserve passive HUD features and working harness paths. Do not mark R6A's all-three-harness admission objective complete.

**Optional hardening:**

- Maintain a small vendor-protocol conformance probe for future Codex updates, reporting supported evidence behavior without imposing version-number admission gates.
- After a native contract exists, add fuzz cases for metadata shape parsing and request interleaving beyond the concrete regressions above.

## 5. Scope

**Needs orchestrator:** decide whether to commission the single live qualification scenario; coordinate the A8 activation disclosure and package acceptance boundary; seek an upstream provenance/lifecycle contract if the candidate remains insufficient. The authorized read-only design task is complete. Preserving fail-closed resolution and its regression tests is inside A2b; enabling the proposed native metadata path is not justified by the current evidence. No code, configuration, git state, jobs or installed runtime were changed by this answer.
