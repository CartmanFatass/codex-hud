# M2 Codex exec JSONL simulation slice

```sh
npm ci
npm run build
npm run build:test
node --test dist-test/tests/unit/codex-exec-json.test.js
node scripts/demo-codex-exec.mjs
```

Node 22 >= 22.13 or Node 24. No Codex installation/account, subprocess, settings
changes or network access is used by the demo. Build outputs remain in the project.
The fixture is synthetic. The runnable demo invokes the actual new HUD harness
module `src/harness/codex/exec-json.ts`, not a duplicate demonstration parser.

## Official surface, pinned version

Schema identifier: `openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d`.
This is a source commit pin, not a claim about an installed/released CLI version.

- [Exec JSONL events](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/exec/src/exec_events.rs)
- [CLI flags](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/exec/src/cli.rs): `--json`, alias `--experimental-json`.
- [SDK event types](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/sdk/typescript/src/events.ts)
- [SDK items](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/sdk/typescript/src/items.ts)
- [SDK exec invocation](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/sdk/typescript/src/exec.ts): exec JSON flag, optional `resume THREAD_ID`, stdin prompt; nonzero/signal exit is separate from events.

These are **exec stdout events**, not app-server JSON-RPC and not the on-disk
rollout format. The existing CodexAdapter reads rollout `session_meta/event_msg`
records. It is deliberately unchanged: exec JSONL must not be disguised as rollout
records or substituted for source-local identity evidence.

## Implemented observation contract

One reader observes one invocation/turn. Feed arbitrary byte chunks; records are
buffered across JSON and UTF-8 boundaries. A valid final record without LF is
accepted at EOF. Truncated JSON, malformed UTF-8 or invalid event ordering records
a gap. Limits are 64 KiB per record and 4 MiB per invocation, not time budgets.

`thread.started`, `turn.started`, item started/updated/completed, turn completion,
turn failure and stream error are recognized. Only thread ID, item ID/type/event,
counts and input/cached-input/output token totals are retained. Command arguments,
outputs, message/reasoning bodies and error text are not exported. Item payloads
are not exhaustively validated or interpreted; item completion is not turn success.
Additional native usage fields are not inferred or displayed as cost/context.

The caller separately supplies process exit status/signal to `finish`. This input
is a caller assertion, **not independent process proof**. Termination is latched.
`complete` means a complete recognized observation with turn.completed and clean
caller-reported exit, not task correctness or verified execution. Interrupted
transport preserves observed turn completion but never reports complete=true.
Unknown event types are counted and prevent complete=true, without silently
ignoring future semantics. Snapshots are detached copies.

Resume uses a fresh reader with an expected thread ID from the previous stream.
Only matching `thread.started` is accepted. No prior completion is inherited.
This checks stream continuity only: a transcript is untrusted and cannot grant
HUD managed authority, launch proof or MCP capability. No automatic retry occurs.

## Tested and deliberately not claimed

Focused simulations cover 1-byte/7-byte/full chunks, split Unicode, partial lines,
EOF without LF, truncated JSON, successful completion, failure/error, signal and
nonzero exit, unknown events, app-server-shaped input, resume mismatch, malformed
ordering, input bounds and latched termination. All inputs are invented.

This adds a reusable observation boundary and executable fixture to HUD's Codex
harness directory. Live stream ownership, a user-facing exec command, panel wiring,
managed launch/resume, real client compatibility and broad Phase M2 completion are
not claimed. No existing collector, Claude visibility or capability gates change.
