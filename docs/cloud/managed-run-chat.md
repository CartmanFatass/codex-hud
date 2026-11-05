# Experimental managed-run chat backend

This opt-in backend slice adds a private local channel to a newly launched, explicitly chat-capable managed run. The existing hud-run supervisor is still the only process owner. It retains that child's stdin and observes the same stdout, teeing the existing stdout log. Attaching through the backend API does not spawn, resume, restart or replace a harness. Legacy runs have no endpoint and are unavailable. There is no chat UI, default activation, production profile adaptation or supported-capability promotion in this slice.

The frozen launch input names `chatProtocol` and uses headless protocol stdin. A trusted executable composition supplies the matching codec. The default CLI cannot turn a model-supplied JSON object into a codec. An explicit trusted `HUD_RUN_PORT_MODULE` may export `createChatProtocol(name)` for a simulation or integration. This is not a production capability declaration.

An explicit caller passes only the selected link, run and source IDs to `openSelectedRunChat`. The private ledger gate and one committed run snapshot provide the current ChildBinding, native session reference, generation, supervisor and harness stamps. The channel refuses stale, conflicting, unbound, cancelled, ended, noncurrent-owner or superseded runs. The socket is a locator, not identity authority. Successful attachment returns the pinned identity and supervisor-generated connection ID. Selection and send never guess a generation or choose the newest unrelated agent.

The supervisor serializes admission, rechecks the fixed identity and live processes before each write, and rechecks before exposing new stream batches. A state change after an admitted write cannot roll that write back. There is no SQLite transaction across pipe I/O and no atomic-delivery claim. The connection never reroutes. A pipe write is submission only; `send` resolves only on the codec's correlated command acceptance. Pi acceptance means accepted/queued/handled, not consumption or turn completion. Session text and id-less cycle boundaries are not attributed to a particular prompt. Missing acknowledgement, timeout or disconnect with a pending command is unknown and is never retried automatically.

Only one client and one pending command are admitted. Admission is released once trusted pipe I/O begins; an early correlated acceptance or rejection permits the next explicit send even if the prior write callback has not settled. Per-request admission ownership prevents an older callback from releasing a newer validation. Input is bounded at 32 KiB, encoded prompt bytes at 64 KiB, wire frames at 128 KiB, queued protocol bytes at 1 MiB, socket buffered output at 256 KiB, and acknowledgement wait at 30 seconds. Encoded-size refusal occurs before the Pi codec reserves the command ID. A correlated Pi rejection remains distinct from an unknown outcome. A pipe failure after an acknowledgement closes the channel, but cannot retroactively become `not_submitted`; there is no automatic replay. Client close detaches without cancelling the child. Supervisor shutdown/EOF invalidates the endpoint; stale sockets are never adopted or overwritten. Conversation text is not stored in a new database; existing supervisor logs retain their original role.

Sealing protocol input keeps the stdout tee alive for final output. After the shell helper exits, stdout has a one-second drain allowance. A descendant that still holds the pipe causes an explicit `hud-run chat stdout drain incomplete` diagnostic and closure of the read handle, not an indefinite supervisor wait. This does not kill the descendant or prove that the process scope is gone. The existing independent scope proof remains required for a final receipt. These are software deadlines, not hard OS time guarantees.

Validation here is limited to socket-free state-machine checks and owned synthetic child pipes. The Unix-endpoint test and managed SQLite/binding end-to-end scenario are provided for an authorized environment but are **not verified in this run**: AF_UNIX bind was denied with `EPERM`. The denied operation was not retried through TCP or another environment. No real-provider compatibility or full interactive capability is claimed. The ordinary cloud check runner does not automatically include this experimental endpoint scenario.

## Reproducing the focused checks

From the repository root, after installing the declared dependencies:

```sh
npm run build
npm run build:test
npm run build:hud-mcp
node --test dist-test/tests/unit/run-chat-memory.test.js dist-test/tests/unit/run-chat-drain.test.js tests/unit/pi-chat-protocol.test.mjs
node --test dist-test/tests/unit/run-artifacts.test.js dist-test/tests/unit/run-process.test.js
```

The first test command does not listen on or connect to a Unix endpoint. Its in-memory socket substitute exercises the server state machine; its process cases own real synthetic child pipes. It does **not** validate `connectRunChat`'s socket client or the managed ledger/binding path end to end.

The separate endpoint and managed scenario commands below require an environment authorized to perform the Unix socket operation. They are listed for reproduction, not recorded as passing, and were not rerun following the `EPERM` denial:

```sh
node --test dist-test/tests/unit/run-chat-channel.test.js
node --test tests/workbench/chat-managed.test.mjs
```

The second scenario uses only synthetic Pi/MCP identity fixtures in a disposable home. It is backend test scaffolding, not a UI or live provider integration. See the [delivery record](handoff/experimental-chat-backend-20261105.md) for exact results and remaining gates.
