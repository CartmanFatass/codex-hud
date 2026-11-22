# Opt-in Codex app-server child transport

```sh
npm ci
npm run build
npm run build:test
node --test dist-test/tests/unit/codex-app-server.test.js dist-test/tests/unit/codex-app-server-transport.test.js
node scripts/demo-codex-app-server-transport.mjs
```

The demo starts a real Node subprocess implementing an invented tiny server, not
Codex. It uses temporary HOME/HUD_HOME and no inherited credentials or provider
account. It drives the actual new `CodexAppServerTransport`, which wires the
already-reviewed `CodexAppServerObserver` to child stdin/stdout. Existing HUD CLI,
panel, managed delegation, approvals and installed settings remain unchanged.

## API and protocol boundary

Construct with explicit absolute executable/cwd, argv and environment. Shell mode
is disabled. Choosing a real executable or supplying credentials/configuration is
the caller's authorized opt-in action; this module is not a sandbox. Use
`initialize()`, `threadStart()`, `threadResume(id)`, `snapshot()` and `shutdown()`.
There is no generic request sender or server-request responder. Unsupported server
requests, including approvals, stop the connection without responding. No automatic
approve/deny, reconnect, request retry or capability promotion occurs.

The driver sends initialize, waits for its correlated response, then sends the
initialized notification. Requests use unique numeric IDs; the existing observer
validates response correlation and resume thread IDs. Interleaved notifications
are observed, not treated as task success. API promises resolve on accepted response
metadata, not semantic correctness. The interface intentionally covers only the
reviewed handshake and thread start/resume subset, not turn execution.

The wire/schema pin and official references remain those in
[the observer guide](m2-codex-app-server-simulation.md):
`openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d`. Exec JSONL and on-disk rollout
are different surfaces. A process running is not proof of official client identity.

## Bounds, backpressure and shutdown

At most eight pending requests are admitted; IDs are additionally limited to 256
per observer. Outbound JSONL frames are capped at 64 KiB. Only one stdin write runs
at a time and its write callback gates the next, including Node stream backpressure.
Tests exercise ordered real-pipe writes; they do not claim measured pipe saturation.
Inbound observer bounds are 64 KiB/line and 4 MiB/connection. Stderr is drained,
never retained/logged, and capped at 64 KiB. Invalid frames and unsupported requests
stop the connection instead of continuing on ambiguous protocol state.

Default request deadline is 5 seconds from enqueue; connection lifetime is 30
seconds. Both are configurable from 1 ms through 5 minutes. These are timers, not
OS hard-real-time guarantees. Pending promises reject on timeout, transport error
or child close. A timeout, write error, EOF or forced termination rejects the local
wait; it does not prove thread/start or thread/resume did not execute, nor that
remote work is settled. Never retry solely because a promise rejected. A future
owner must reconcile uncertain effects before deciding any further action.
No transcript/error bodies are exposed by driver diagnostics.

Shutdown is local process ownership, not a fictional protocol shutdown request:
close stdin, signal the direct child TERM, escalate to KILL after 250 ms. The driver
waits for child close; after 1.5 seconds it can return `reaped:false` rather than
claiming exit. Close listeners remain to observe eventual exit. It does not control
process groups or grandchildren. The caller must handle `reaped:false`; the demo
fails that condition rather than claiming cleanup. This is not a production daemon
supervisor or a cross-platform process lifecycle guarantee.

## Validation limits

Cloud tests use actual synthetic subprocesses for split response framing,
initialize acknowledgement, start/resume, reordered request IDs, unsupported
approval requests, malformed frames, nonzero exit, queue bounds, deadlines, missing
executable, stderr limits and TERM-resistant child escalation.
No real account/client is tested. This is a working opt-in transport seam, not
live integration or complete M2. Existing Claude, Pi and Jev paths are unchanged.
