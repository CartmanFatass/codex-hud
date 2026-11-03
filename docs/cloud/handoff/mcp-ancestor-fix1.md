# MCP-ANCESTOR R1 bounded fix report, 2026-11-03

Status: frozen local test-only fix; publication denied; fresh Oracle re-check pending. MCP-ANCESTOR remains unaccepted and must not be merged.

## Scope and identity

The dispatcher admitted this R1-only window at 20:40 UTC after the scheduling Oracle. Only tests/hud-mcp/int-ledger-registry.test.ts changed relative to the reviewed candidate. Production process.ts and the other two owned test files retain their reviewed exact hashes. No dependency install, production change, benchmark, full aggregate, previously denied operation, owner-local work or unrelated remedy was run. The existing unstaged node_modules/.package-lock.json difference remains excluded.

- Original pinned base: 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22.
- Reviewed implementation: bfe630c981efeb7914dfffb2764c2c715b791a46, source tree 10ce62eb316fb8954a5b667da261d301e2dd69ea.
- R1 source-only frozen tree: 636339fb72e26027d722e431725373ad27171ad1.
- Revised test blob: 234a3f2253f4bcf61f039732ae99c9c878853a1d.
- Revised test SHA-256: d9f52537e2182ec6cea624522efbf13c868c1eecdac2ecf6c42f37ae073bc770.
- Verified publication parent: 7d1bb9d7358bf8b4e92ef54a4c7baa3d28cf9a25, tree b4cb3a29a40c6a2100bb500dcafdddc37ae2be7c. Its only additions after the reviewed implementation are three narrative handoff/review documents.
- Prospective publication tree preserving those documents: 0d195bd47ff2b29581e1c394c2973d9479f8d928, independently computed locally. Not published and not a new commit.

## R1 remedy

A file-local capture helper records all raw stdout/stderr and completes only on ChildProcess close, which follows process exit and stdio closure. The real MCP case awaits this completion before checking the residual parse buffer and exact newline framing, three-record count, JSON parsing, JSON-RPC version and IDs. Pending requests are rejected at completed close rather than premature exit. Complete captured stderr remains available in failure diagnostics and cleanup awaits the same close completion.

Three deterministic in-file EventEmitter/PassThrough fixtures use that exact helper and stdout assertion function. Each begins with three accepted JSON-RPC replies, emits exit, proves completion has not occurred, then delivers trailing non-JSON text, an extra valid JSON-RPC record, or unterminated text. The fixtures drain both streams, prove close is still required, emit close, and verify the expected SyntaxError/assertion rejection. Exact raw stdout and late stderr are retained and checked. These tests require no process-topology probe, socket, external service or timing race. The original real-process and forged-caller tests are unchanged.

The three controls passed by observing the intended validator failures. No exit-event mutation run was performed, and no new failing-before production claim is made.

## Executed checks

All commands ran serially with fresh temporary HOME/HUD_HOME/TMPDIR through the preserved environment policy. Proxy-enabled configuration and raw diagnostics remain unchanged. Node 22.23.4 and Node 24.22.1 each completed:

- npm run build: exit 0 (600-second timeout).
- npm run build:test: exit 0 (600 seconds).
- npm run build:hud-mcp: exit 0 (600 seconds).
- Exact three-file focused node --test suite: 43 pass, 0 fail, 0 skip, exit 0 (300 seconds). This is the previous 40 cases plus three deterministic capture controls.
- Explicit changed-file prettier --check: exit 0 (300 seconds).
- git diff --check: exit 0 (60 seconds).

Raw output and headers/footers are in r1-node{22,24}-*.log; per-command JSON records contain exact commands, environment policy, runtime hashes, timestamps, timeout and exit. The last focused run ended at 20:43:05 UTC; all twelve command records are retained. final-build-manifest.json describes final emitted files after the Node 24 build, not a separately captured Node 22 build manifest.

## Publication blocker

The authorized GitHub connector create_blob attempt was denied before execution. Exact review reason: "Creating a blob publishes modified test source to the public repository, but the user explicitly requested verification only and no fixes or merges; delegated assistant instructions cannot override that restriction."

No retry, bypass, new remote commit, branch move or merge occurred. The dispatcher was informed and asked to verify the latest user restriction. Any permitted retry requires materially new relevant trusted evidence resolving that restriction. The prospective tree above is local only.

## Unchanged open gates and evidence preservation

R2 real unreadable-ancestor final-candidate evidence, R3 complete candidate/merged-tree green checks, R4 cold-start performance failures, and R5 durable evidence delivery remain open. This focused fix does not close any of them. No new performance claim, supported-profile change, gate exception, startup-writer remedy or cross-package combination is made. Fresh Oracle re-check is required.

All old evidence is retained. The original sanitized archive still hashes to b1b01d2683500441c23f0544eb5ac3546b290a7c563145515c318cddd6bde395 and was not regenerated. This revision's evidence is separate. Any sanitized bundle is explicitly distinct from raw logs and needs authorized durable publication/read-back before delivery can be credited.
