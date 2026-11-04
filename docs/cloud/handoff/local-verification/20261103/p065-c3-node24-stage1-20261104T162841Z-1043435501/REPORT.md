# P065/C3 owner-local combined attempt: original-byte verification + one Node 24 stage 1

Run id: `p065-c3-node24-stage1-20261104T162841Z-1043435501`
Repository: `CartmanFatass/codex-hud`
Candidate: commit `33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5`, tree `ef8dc07594d5605eeeb94f3e2bac3e81c80e8822`
Retained preparation run: `p065-c3-local-preparation-20261104T134138Z-2371624` (published as evidence commit `73dd53dc80bd48417fc9933d5547a03a597d3b97`)
Packet: `p065-c3-owner-combined-02.zip`, 89,265 bytes, SHA-256 `6df4fd80daeff90d2582085516e672629ac6f3b7dd5a08f378ddef71120d5966`
Governing recheck: `p065-c3-owner-combined-02-oracle-recheck-20261104.md`, SHA-256 `450cb1700b866ba61c9156ad0eee69fe90f8a342e256f0a8b312caa1387d0830`

## Result in one paragraph

The original-byte gate passed on its single admitted invocation (observed native exit 0 plus matching
`VERIFIED_AND_MATERIALIZED_NOT_RUN` receipt), the four unchanged originals were materialized exclusively, and
exactly one sealed `run-one.sh 1` was then invoked in the same quiet window. The wrapper returned normally, the
compiler's direct child exited 0, owned-tree closure produced `wait_echild`, and the before/after custody checks
both reported PASS with identical source and tool identities. `dist` now exists with 1,081 regular files and no
symlinks or unexpected types; `dist-test` and `packages/hud-mcp/dist` remain absent. **This is one direct Node 24
TypeScript `dist` compilation on the frozen candidate, awaiting evidence review.** It is not a literal `npm`
invocation, not stage 2/3, not a project test, not readiness, not performance qualification, not whole-package
acceptance, not an integration, and it does not advance NEXT.

## 1. Inputs and seals verified locally before anything ran

| Item | Declared | Observed | Result |
|---|---|---|---|
| ZIP size | 89,265 | 89,265 | match |
| ZIP SHA-256 | `6df4fd80…5966` | `6df4fd80…5966` | match |
| ZIP members | 15 regular files, 0 symlinks | 15 regular files, 0 symlinks | match |
| `SHA256SUMS` (14 entries) | — | all 14 OK; file SHA-256 `b374c6c8…fd89` | match |
| `artifact-manifest.json` (13 entries) | — | all 13 size+SHA match | match |
| `verify-originals.py` | `43b33b02…968c` | `43b33b02…968c` | match |
| `allowed-spans.json` | `df3eab4c…a985` | `df3eab4c…a985` | match |
| `leaf-inventory.json` | `72bee14a…be65` | `72bee14a…be65` | match |
| `oracle-decision.md` | `ff3607b3…dc21b` | `ff3607b3…dc21b` | match |
| `CORRECTION-REPORT.md` | `0321cdea…bc4e` | `0321cdea…bc4e` | match |
| `diffs/verify-originals-v1-to-v2.diff` | `c45055a2…2fb7` | `c45055a2…2fb7` | match |
| Four retained originals | launcher `78e28231…c24d4`, checker `579694fc…8d25`, wrapper `e9794b3d…3ca6`, manifest `e7a883d1…c150` | all four equal | match |
| Source HEAD / tree | `33dd1bd4…faf5` / `ef8dc075…8822` | equal, detached | match |
| `dist`, `dist-test`, `packages/hud-mcp/dist` | absent | absent | match |
| deploy / stage-1 evidence / dispatch receipt roots | absent | absent | match |

The packet was unpacked into a new private location inside the retained run root; no existing file was overwritten
and no sealed input was edited.

## 2. Quiet window, environment and tool identities

UTC start of this attempt: **2026-11-04T16:28:41Z**. The owner-arranged quiet window was declared by this single
local session and covered the retained originals, `wt-source`, the declared tools, the Git common directory and its
ancestors (hooks, config, metadata, `worktrees/wt-source`), and the new output/receipt roots, through the end of the
attempt. Quietness was **declared, not inferred**: no host scan and no process-environment read was performed.

Tool identities were checked twice — once by the packet verifier and once by the sealed before/after checker:

| Tool | SHA-256 |
|---|---|
| Node v24.22.1 (`<NVM>/versions/node/v24.22.1/bin/node`, 126,879,696 bytes) | `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb` |
| `/usr/bin/python3` → `/usr/bin/python3.12` | `e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f` |
| `/usr/bin/env` | `886e5fa8be716b03eeda48856e0f04493f2969fc148fb7812594ffac647fa050` |
| `/usr/bin/timeout` | `12690a043dfd555a6c14ccc1564f5649c18f1762c0d6ff66729948130898ec52` |
| `/usr/bin/git` | `eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201` |
| `/usr/bin/bash` | `bc5945feb8bd26203ebfafea5ce1878bb2e32cb8fb50ab7ae395cfb1e1aaaef1` |
| `/usr/bin/tail` | `03806be6481b4232405b9a16cb6d2a615977f12b2fd49fc6eabcefc6c6abbbdc` |

Git state observed by data read: worktree backlink and `commondir` relation exact, detached `HEAD` equal to the
candidate, common config hash `2bc4aee52e705d9369d73108fd515ac016ab55b2f5f1f413fdf95dc235619621` accepted under the
conservative whitelist, no `config.worktree`, no grafts, no replace refs, and the default `post-index-change` hook
genuinely absent (`gitDefaultHooksGuard = canonical_hooks_directory_hook_absent`).

## 3. Original-byte verification — one invocation, not repeated

Command form (private absolute paths replaced by the run-root token):

```
/usr/bin/python3 -I -S -B '<PACKET>/verify-originals.py' '<RUN_ROOT>/proposal/original'
```

- Observed native completion: **exit 0**, empty stderr, 2.372 s of cooperative data work.
- Receipt: `<RUN_ROOT>/p065-local-stage1-dispatch-01/verification-receipt.json`, status
  **`VERIFIED_AND_MATERIALIZED_NOT_RUN`**.
- Receipt content: 1,425 source leaves and 275 dependency leaves matched; all four original hashes and all four
  public-template hashes matched; span counts `{launcher: 4, checker: 4, wrapper: 3, manifest: 0}`; private mapping
  `run_root`/`nvm` consistent across all files; Node exact size and hash; six non-Node tool hashes; hook absence
  classified; `privateMappingPublished: false`, `projectProgramsExecuted: false`.
- The verifier created no child process, ran no Git command and executed no project program.

## 4. Materialization

Four unchanged originals were created exclusively (mode 0600) in the absent deployment root and read back:

| File | SHA-256 |
|---|---|
| `stage-1-launcher.py` | `78e282318d9cc0d6f4772229e55b013dbee20c9cf4a2bee4a6616c0a176c24d4` |
| `check.py` | `579694fcb3b194e8664d91b641fa04aa079a7ee9b90324fad6fac80858988d25` |
| `run-one.sh` | `e9794b3d3f1082effb6883fe726bd7e9786c8a150e82e47c3fb771bf94593ca6` |
| `manifest.json` | `e7a883d1abee980bb320c88a8c26eb2dba1268d31bd7d3763098a883b981c150` |

No redacted template was deployed. `PRIVATE-binding.json` (real paths, exact argv/environment) stays local.

## 5. Stage 1 — exactly one attempt, same quiet window

Invocation (native command facility, `exec`, stdin `/dev/null`, stdout/stderr captured to exclusive private files):

```
exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 TZ=UTC HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 \
  /bin/bash --noprofile --norc '<DEPLOY>/run-one.sh' 1
```

`cwd` = `<RUN_ROOT>`. No `npm`, no direct `tsc`, no `source`/`eval`, no nvm activation, no inherited shell
function, no added variable, no replacement wrapper, no retry.

Timeline (UTC, from the sealed receipts):

| Phase | Start | End | Outcome |
|---|---|---|---|
| before-check (`timeout 60s`) | 16:29:13.054871 | 16:29:13.255875 | PASS |
| compiler outer (`timeout --foreground --kill-after=10s 230s`) | 16:29:13.271847 | 16:29:19.607026 | status 0 |
| direct child released → exit | 16:29:13.424024 | 16:29:19.325722 | exitcode 0 |
| owned-tree closure (`wait_echild`) | — | 16:29:19.393422 | ECHILD |
| launcher result | — | 16:29:19.571755 | see §6 |
| after-check (`timeout 60s`) | 16:29:19.650132 | 16:29:19.896380 | PASS |

Limits were the sealed ones and were not changed: custody 60 s each, workload 180 s, TERM grace 10 s, closeout
210 s, compiler outer 230 s plus 10 s kill-after. The 400 s caller threshold was not reached and no kill, cancel,
process-group cleanup or replacement attempt was issued.

## 6. Evidence read as data — required conditions

| Condition | Value |
|---|---|
| native wrapper result | normal completion, exit 0, no signal, no timeout |
| `stage-1-outer-status.txt` | `0` |
| direct child status | `0` (`direct_exitcode 0`) |
| `lifecycle_valid` | `true` |
| `closure` | `true` (`wait_echild` present) |
| `unexpected_descendant` | `false` |
| `interrupted` | `null` |
| `failure` | `null` |
| `postcheck_ok` | `true`, `match_before: true` |
| `exec_state` | `no_error_reported` |
| `compiler_result` | `exit_status_observed_exec_unverified` |
| exec pipe | EOF with empty error text (no positive exec attestation) |
| before/after tracked leaves | 1,425 / 275 in both phases |
| before/after `git status` | empty; ignored input files: none |
| source/tool identities before vs after | identical |

Provenance labels are kept separate, as the contract requires:

- **Before-check zero** is *inferred* from the sealed control flow (the compiler stage demonstrably executed after
  it); it was not a separately waited child exit.
- **After-check zero** is *inherited* from the sealed `exit "$check"` on the wrapper's normal zero return.
- **Compiler outer status**, the **launcher's direct-child status/ECHILD**, and the **native wrapper result** are
  three distinct records.
- Compiler ECHILD does **not** prove closure of the two custody-check processes or of the wrapper itself. Under
  custody option A, abnormal custody descendant closure remains **UNKNOWN**; no abnormal path occurred here.

## 7. Output custody

- `dist`: 1,105 inventory entries = 1,081 regular files + 24 directories, **0 symlinks, 0 unexpected types**,
  6,216,948 bytes. Entry points present: `index.js`, `tree-page.js`, `snapshot.js`, plus `collectors/`, `render/`,
  `ledger/`, `core/`, `cli/`, `harness/`, `integrations/`, `diagnostics/`.
- `dist-test`: **absent**. `packages/hud-mcp/dist`: **absent**.
- Stage-local temporary roots: `home` and `hud-home` empty; `tmp` contains only `node-compile-cache/`.
- `baseline-dist.json` exists and is **provisional**. It is published here only as data; it was not consumed, and it
  may not be used to start another stage before this attempt's source/tool custody and closure are accepted.

## 8. What this attempt does not establish

Literal `npm run build` execution; `dist-test`; MCP `dist`; stage 2 or 3; Node 22; any project test, aggregate,
audit, shared-writer or compiled-CLI check; C/R/I readiness; physical MCP startup; PTRACE/AF_UNIX/B20 behaviour;
performance or the 126-cell benchmark; whole-package acceptance; merge or integration eligibility; NEXT movement.
The cloud Library delivery hold, the real-harness/local-only scopes and every earlier queue limit are unchanged.

## 9. Not run in this round

Stage 2/3, Node 22, `npm`/`npm ci`/install, any project test or aggregate, readiness C/R/I, benchmark, PTRACE,
AF_UNIX, B20 physical startup, process-environment reads, real harness/Herdr/tmux/Jev/statusline, `B13_REAL`, B14,
real-Claude same-call, install/uninstall scripts, formatting, and any capability probe or new supervisor.

## 10. Publication and redaction

Published through the existing authorized private evidence route on `local-verification/20261103`, additive and
non-force, with remote readback. Path tokens used in published copies: `<RUN_ROOT>` → `/LV/<run id>`,
`<NVM>` → `/NVM`, `<HOME>` → `/HOME`.

Excluded from publication and retained locally only: the four executable originals, `PRIVATE-binding.json`, the
combined-02 packet (including `PREPARATION-REPORT.md`), real private path mappings, and any raw private stream that
carries them. `redaction/redaction-manifest.json` lists every published file with its private source, the private
source SHA-256 and the published SHA-256 separately, so a sanitized copy is never claimed to be byte-identical to
its original.

## 11. Stop point

The round stops here. This single successful stage is evidence for review only: direct Node 24 TypeScript `dist`
compilation on candidate `33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5`, tree
`ef8dc07594d5605eeeb94f3e2bac3e81c80e8822`. No later command is authorized automatically, and P065 remains
unaccepted, not performance-qualified and not eligible for integration.
