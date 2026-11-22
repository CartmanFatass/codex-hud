# Approved thin HUD implementation flow — 2026-11-07

The owner approved the revised [architecture](../architecture/simplified-harness-architecture.md) and parallel implementation. Its explicit corrections supersede contradictory legacy control-policy requirements for the new path. This is an implementation plan, not acceptance evidence.

## Workspace and preservation

- Working/delivery branch: `universal-hud` (owner requested direct development after dispatch); recovery branch retained as prior checkpoint; initial HEAD `f9818714bf2afee9d7724b65aa6b00b0c4e62d89`.
- Existing uncommitted candidate work is preserved and revised within file ownership. No main changes, force push, or node_modules changes are included.
- Existing official readers, HUD rendering and model summaries remain. Old histories are not removed.

## Parallel work and dependencies

1. **Core host and MCP boundary** defines the small native transport ABI first, then implements detached local connection ownership, direct relations, MCP forwarding, and parent-disconnect continuation. It owns `src/managed/`, MCP main/server/tools/config, and host integration tests.
2. **Codex adapter** concurrently updates app-server transport and adapter, native events/read/resume/steer, and focused fixtures/tests. It consumes the shared ABI without modifying it.
3. **Claude adapter** concurrently updates SDK input/callback/resume handling and actual user executable/config selection, with SDK boundary tests.
4. **Pi adapter** concurrently uses the installed Pi's official JSONL RPC, native history/state/session operations and request/response forwarding. No package-pinned runtime or inferred completion.
5. **Source identity and version removal** concurrently removes vendor-version admission checks while preserving actual per-native-session identity and cross-session refusal.
6. As those packages finish, **Jev wrapper**, **existing wake integration**, and **HUD relation/display integration** consume the settled ABI in separate owned files. These remain part of this implementation, not a new deferred product scope.
7. A fresh independent Oracle reviews the integrated candidate, including the actual default-entry dependency graph. Implementers fix findings; applicable checks rerun on final code before publication.

## Constraints checked across packages

No custom task/operation database, approval policy, forced tool configuration, version whitelist, automatic retirement, hidden timeout cancellation, or task-goal judgment. Official payloads and errors remain authoritative. Explicit calls map to official operations. Parent/MCP detach does not close children. Direct ownership is recorded at creation. Local-only scope; reuse existing summaries. Synthetic tests use temporary HOME/HUD_HOME and do not assert real-provider acceptance.

## Delivery

Report changed functionality, actual tests and remaining real-client verification separately. Publish to the owner-selected `universal-hud` development branch after review and applicable checks. Do not describe the candidate as merged or fully validated merely because focused tests pass.

## Branch consolidation review

A separate read-only Oracle audited 130 remote references against the preserved recovery baseline: 73 are ancestors, 57 divergent, and 8 divergent references contain only patch-equivalent changes. Composition commits already include many otherwise differently identified reader/display changes.

Bounded selections approved for integration review:
- `22a9174426425e0c2413b905c6256acf9a729d04`: retained digest-reader test fixture repair; no production behavior.
- `9216565f8fb0280d06263597a0f3f198c58dab7a`: neutral HUD launch/layout aliases, preserving existing validation.
- `e862d75914b6ab36f36161fe19b346dac34681e4`: opt-in supplied native statusline details, preserving compact defaults and current native-call wiring.

Do not wholesale import old authenticated-link run/slot projections, configuration-observer transport, completed-report notes/lifetime/panel controls, experimental chat or qualification branches. Existing SmallModel/ProgressSummarizer/RecapStore are retained independently of those optional features. Original branches remain untouched. Source selection is not integrated-tree acceptance.
