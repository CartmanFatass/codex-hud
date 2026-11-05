# Codex exec child transport: bounded simulation slice

`src/harness/codex/exec-transport.ts` is a one-shot, unmanaged transport around the existing Codex exec JSONL observer. It starts one direct executable with fixed `exec --json [resume THREAD_ID]` argv (resume accepts only a lowercase canonical UUID, never names or `--last`) and a stdin prompt. It takes explicit absolute executable, cwd and environment; inherited HUD authority variables are removed. It does not resolve a trusted executable, establish a managed run, prove launch identity, wire a panel, implement durable idempotency or authorize any provider access. The caller is responsible for authorization and trusted executable/config/environment selection.

The implementation is based on pinned upstream [SDK command construction and stdin](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/sdk/typescript/src/exec.ts) and [exec CLI flags and prompt](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/exec/src/cli.rs). This pin is source provenance, not a claim about an installed version. The JSONL schema and `complete` meaning are in [the existing observation slice](m2-codex-exec-simulation.md); this is not app-server or rollout format.

A single object permits only one attempt, including after validation, abort or uncertain completion. It makes **no global or persistent no-duplicate guarantee** across objects, processes or restarts; an uncertain external execution requires caller reconciliation, never automatic retry. This explicit-ID restriction avoids the pinned CLI's title lookup, which may start a new thread if no title matches; see [resume resolution](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/exec/src/lib.rs). A matching resume stream is observation only, not session ownership proof. A clean close and complete observation are called `observed_complete`, not task success or proof of all external effects. Any post-spawn nonzero exit, signal, timeout, transport/stream/limit failure or identity mismatch remains `uncertain`. Spawn failure or a pre-aborted signal is `not_started`. Direct-child close is not a process-group or external-task termination proof.

Stdout is consumed continuously into the existing bounded reader. Prompt stdin is capped at 1 MiB; Node's stream machinery handles backpressure while the single bounded input is written. Stderr is drained but never returned; only a capped byte count is exposed, with a 1 MiB limit. On a limit, timeout, abort or IO error, the transport requests SIGTERM then SIGKILL for the direct child only. A bounded close wait may return with `closeObserved: false`; it does not assert descendant exit. No output content or stderr diagnostics are retained in the result. These limits and timeouts are implementation defenses, not vendor guarantees or performance claims.

Run with Node 22 >= 22.13 or Node 24 and temporary HOME/HUD_HOME:

```sh
npm run build:test
node --test dist-test/tests/unit/codex-exec-transport.test.js dist-test/tests/unit/codex-exec-json.test.js
```

Tests start an explicitly synthetic fixture executable, with invented values, no provider account and no network. They exercise stdin backpressure-sized input, JSONL chunking, resume match/mismatch, exit, abort, timeout, missing binary, output limits and no same-instance retry. This slice is not full M2 or real-client compatibility testing.

## Prompt write receipt

`observed_complete` additionally requires `promptWriteFinished:true`, the local
Node writable-finish receipt. A clean child exit and complete stdout alone cannot
substitute for it; a missing receipt is `uncertain` (`stdin_incomplete` unless a
more specific earlier error exists). This receipt only means bytes were flushed
from the local writable, not that the child read or acted on them. Even a small
unread prompt may finish locally. No outcome grants managed authority or permits
automatic retries; reconcile uncertain effects before further action.

Regression coverage includes a real synthetic early-success child with a large
prompt, plus deterministic suppression of parent stdin end while a real child
emits completion and exits zero. The latter is injected transport scheduling, not
a claim that the natural OS race was observed. The observed real large partial
write already failed closed with stdin_error before the receipt guard.
