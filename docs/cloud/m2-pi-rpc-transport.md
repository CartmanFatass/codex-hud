# Opt-in bounded Pi RPC child transport

```sh
npm ci
npm run build
npm run build:test
node --test dist-test/tests/unit/pi-rpc-observation.test.js dist-test/tests/unit/pi-rpc-transport.test.js
node scripts/demo-pi-rpc-transport.mjs
```

Node 22 >= 22.13 or Node 24. The demo launches a real synthetic Node child, not Pi.
Temporary HOME, explicit environment and invented events require no provider or
account. It exercises actual `PiRpcTransport` wired to the versioned `PiRpcObserver`.
No CLI default, managed capability, panel, Claude, Codex or Jev path is changed.

## Wire contract and API

Official source pins and differences are in
[the versioned observer guide](m2-pi-rpc-simulation.md): v0.73.1 commit
781152fc24841dc54b22284514604048ebe5e2c9 and newer source commit
9b9cb30ae16e5802ba556b282b38fc41117ee5e1. Both document `pi --mode rpc`, `--no-session`,
LF-framed JSON commands, optional correlation IDs and prompt acceptance responses.
The new version additionally distinguishes `agent_settled` and handled disposition.
The supplied source commit is a caller assertion, not binary/version authentication.

Create `PiRpcTransport` with absolute executable/cwd, explicit env, sourceCommit
and optional timeoutMs. It launches exactly `--mode rpc --no-session`, shell=false.
HUD_* authority and stale PI_SESSION_ID/PI_SESSION_FILE variables are stripped.
Other supplied values remain caller-authorized; the transport is not a sandbox.
It disables Pi session persistence but cannot promise an arbitrary executable or
extension makes no other writes. Only the synthetic demo is isolated from accounts.

`prompt(message)` sends one `{id:"prompt-1",type:"prompt",message}` JSONL record.
A second prompt is rejected; no steering, queueing, resume, abort command, approval
or generic command API is exposed. Stdin remains open for the RPC session. The
single write callback provides local flush/backpressure evidence, not child
consumption. Correlated successful prompt response means acceptance only.

The promise reports a detached boundary observation, never task success:

- Newer source: `settled` or `aborted` only after `agent_settled`.
- Newer handled response: `no_run` for this prompt, session quiescence unknown.
- Legacy: `legacy_run_end` at `agent_end`, **not settled**; retries/compaction may
  still follow. The connection keeps observing after the promise resolves.
- Unknown version: cannot trust a settled event; bounded wait returns `stopped`.
- Rejected prompt: `rejected`; transport/protocol errors: `stopped`.

Boundary resolution requires the local prompt write callback plus correlated
response. `snapshot()` exposes current observation; an earlier boundary snapshot
is not a continuing guarantee. Returning a boundary does not shut down the child.
Call `shutdown()` explicitly when intended; the connection lifetime is also bounded.
In particular, shutting down after legacy_run_end can interrupt later automatic
work. The demo does this only to its owned synthetic peer, not as a production
recommendation to terminate Pi after agent_end.

## Limits and lifecycle

LF is the only delimiter; CRLF is accepted through JSON whitespace. Split UTF-8
and Unicode U+2028 inside strings stay within a record. Invalid UTF-8/JSON,
uncorrelated or duplicate response IDs and truncated EOF stop observation. Unknown
events remain counted by the observer. Extension UI requests stop the transport
without any automatic response or user decision.

Limits: 64 KiB outbound record/inbound line, 4 MiB stdout, 64 KiB discarded stderr,
2,000 observed events. Default lifetime is 30 seconds, configurable from 1 ms to
5 minutes. The owner schedules actual monotonic idle expiry, so unsupported or
missing events cannot leave a promise waiting indefinitely. Limits are defensive
implementation choices, not official protocol or performance guarantees.

On timeout/error or explicit shutdown, close stdin, TERM the owned direct child,
then KILL after 250 ms. `closed` resolves from observed child close, or reports
`reaped:false` after 1.5 seconds. This is not process-group supervision or a hard
OS deadline. A false reap receipt requires caller attention; the demo fails it.
EOF, local write error, timeout or killing the direct child do not prove the prompt
was unaccepted, remote work ended or external effects did not occur. There is no
retry; a future owner must reconcile uncertainty before further action.

## Validation scope

Real synthetic subprocess tests cover request flags/environment stripping,
correlation, split UTF-8/CRLF/Unicode separators, modern retry before settled,
legacy run end, unknown-version idle expiry, handled/aborted/rejected outcomes,
unsupported UI requests, mismatched ID, silent peer and truncated EOF. The runnable
demo covers modern/legacy/unknown profiles. No live Pi compatibility, real model
execution, managed delegation, MCP authorization or complete M2 is claimed.
