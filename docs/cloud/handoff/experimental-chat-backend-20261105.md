# Experimental managed-run chat backend delivery

## Scope and source

- Base: `727284b1d5e3617860cfdfc8d27d942c50a06991`.
- Dedicated branch: `dots/experimental-chat-backend-20261105`. Publication is not integration into another branch, a release or capability promotion.
- Backend only: trusted opt-in protocol launch, the existing supervisor's retained stdin/stdout, a private exact-run/generation endpoint, correlated command acceptance, and bounded failure/drain behavior. No UI or other chat adaptation is added.
- [Behavior and reproduction commands](../managed-run-chat.md). [Exact changed source hashes](experimental-chat-backend-20261105/source-manifest.json).
- Protocol provenance: [Pi v0.73.1 RPC source snapshot](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/rpc.md). Fixtures are synthetic and do not establish an installed Pi version or provider compatibility.

## Final validation on 2026-11-05

Linux x64, Node 24.22.1, npm 11.9.0. Checks ran against the final uncommitted source changes on the pinned base; the source manifest identifies those bytes. All counts below are focused results, not a full-suite pass.

| Command / check | Result | Evidence |
| --- | --- | --- |
| `npm run build` | PASS, exit 0 | [output](experimental-chat-backend-20261105/build.txt) |
| `npm run build:test` | PASS, exit 0 | [output](experimental-chat-backend-20261105/build-test.txt) |
| `npm run build:hud-mcp` | PASS, exit 0 | [output](experimental-chat-backend-20261105/build-mcp.txt) |
| `node --test dist-test/tests/unit/run-chat-memory.test.js dist-test/tests/unit/run-chat-drain.test.js tests/unit/pi-chat-protocol.test.mjs` | PASS, 17/17, exit 0 | [output](experimental-chat-backend-20261105/socket-free.txt) |
| `node --test dist-test/tests/unit/run-artifacts.test.js dist-test/tests/unit/run-process.test.js` | PASS, 19/19, exit 0 | [output](experimental-chat-backend-20261105/regression.txt) |
| Prettier 3.9.9 on all 20 changed source/test/fixture files | PASS, exit 0 | [output](experimental-chat-backend-20261105/format.txt) |
| `node --check` on all seven new fixture modules | PASS, exit 0 | [output](experimental-chat-backend-20261105/syntax.txt) |
| `git diff --check` | PASS, exit 0 | No whitespace diagnostics |

The package-local formatter was absent; the initial invocation failed with `MODULE_NOT_FOUND`. An already-installed same-host Prettier 3.9.9 was used, found seven fixture formatting issues, and corrected them before the final passing check. No dependency manifest or lockfile was changed.

Review requested one final correction: an acknowledgement may arrive before its pipe write callback. Per-request admission ownership now permits the next explicit send after correlated acceptance/rejection and prevents an older callback from unlocking a newer validation. Three socket-free tests cover those orderings. Late pipe failure still invalidates the channel without retroactively labelling an acknowledged command `not_submitted`, and never replays it.

Scoped independent review: **ACCEPT for experimental backend code only**. It independently read the final 17-test result and rechecked the admission correction. Identity fencing, no reroute/replay, endpoint opt-in and bounded stdout drain were in scope. The reviewed acceptance does not cover the unverified paths below.

## Still unverified

- **Unix endpoint and managed SQLite/binding end to end: BLOCKED / not verified.** The earlier AF_UNIX listen attempt returned `EPERM`. The operation was not retried through TCP, a different environment or another transport. `run-chat-channel.test` and `chat-managed.test` are provided for a suitably authorized environment, not reported as passing.
- The 17 passing checks use an in-memory socket substitute and owned synthetic child pipes. They do not prove the actual socket client's behavior or managed ledger/binding integration.
- Node 22, real-provider behavior, installation and full interactive capability were not tested. No supported capability, default profile or production setting was changed.
- No full `npm test` or broad cloud-check pass is claimed for this final tree. The ordinary cloud runner does not include the experimental managed-endpoint scenario. Hosted CI is separate evidence and must be checked for the published commit.
- A one-second post-helper stdout drain deadline closes observation if a descendant holds the pipe and records an explicit diagnostic. It neither kills that descendant nor proves scope completion; final receipts still require independent scope proof. Software deadlines are not hard OS guarantees.
