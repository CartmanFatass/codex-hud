# Local P065-on-C3 Node 24 stage-1 build proposal (source-only, not admitted)

Status: **PROPOSED ONLY. NOT ADMITTED. NOT EXECUTED.** Nothing in this directory was run: no launcher, checker, wrapper, compiler, test, probe or benchmark. The only things executed during preparation were tool version flags, SHA-256 hashing, `git` read operations, `diff`, and parse-only checks (`ast.parse` on the two Python files, `bash -n` on the wrapper, a stdlib import check under `python3 -I -S -B`, a `prctl` symbol lookup without calling it).

P065 stays untested on this combination, unaccepted, not performance-qualified and not eligible for integration.

## 1. What is proposed

One future workload, the first stage only:

    /bin/bash <DEPLOY>/run-one.sh 1        # DEPLOY = LV/<run>/p065-local-build-node24-01 (absent today)

Logical command `npm run build`. Actual workload: the fixed Node `v24.22.1` executes `./node_modules/typescript/bin/tsc` directly in the checkout, as the launcher's gated sole direct child. No npm, no syntax check, no tests, no aggregate. If it ever succeeds it is "direct compiler success", not a literal npm run. A success would establish only a first `dist` for this local checkout; it would not establish `dist-test`, MCP output, readiness, tests, performance or acceptance.

## 2. Exact deltas from the reviewed Node 24 stage-1 files

The base is the Oracle-accepted packet of 2026-11-04: `builds/node24/stage-1-launcher.py`, `check.py`, `run-one.sh`, `manifest.json`. Full diffs: `diffs/` (published rendering) and, privately, the original-form diffs. Every delta is a constant or a narrowing; **no algorithm, subprocess topology or cleanup method changes**.

| File | Delta |
|---|---|
| `stage-1-launcher.py` | docstring; `CHECKOUT`, `NODE`, `PYTHON`, `MANIFEST`, `EVIDENCE` constants; the `NODE` and `PYTHON` sha256 entries. Everything from `SET_SUBREAPER, GET_SUBREAPER = 36, 37` to the end is byte-identical to the reviewed file (verified). |
| `check.py` | path constants `R`, `B`, `E`; `launch` list reduced to the single stage-1 launcher hash; the `expected` map holds local Node/Python/env/timeout hashes and **adds** pins for `/usr/bin/git`, `/usr/bin/bash`, `/usr/bin/tail` (the cloud packet left them UNKNOWN; this only adds identity checks). Inventory, baseline, drift and temporary-root logic are unchanged. |
| `run-one.sh` | `base`, `py` and evidence paths; stage case narrowed from `1\|2\|3` to `1` (stages 2 and 3 are not prepared and exit 2). Timeouts, `env -i`, noclobber, receipts and the result assertions are unchanged. |
| `manifest.json` | unchanged, byte-identical (sha256 `e7a883d1…`): it lists only relative source paths and hashes; all 40 entries re-verified against the local checkout. |

Local pins: Node `e32e2d16…cfb` (official tarball member, byte-identical), Python `/usr/bin/python3` → 3.12.3, the rest in `runtime-tools.json` at run level. They differ from the historical cloud pins; that is expected and is the Oracle's to accept.

## 3. Limits (unchanged from the reviewed design)

Workload 180 s; TERM grace 10 s; closeout 210 s; outer `timeout --foreground --signal=TERM --kill-after=10s 230s` (230 s plus 10 s kill-after). These are separate scopes, not a 180 s bound for the whole wrapper: preflight, inventories and postchecks also consume time. An outer timeout never proves closure. Result labels stay `exec_state=no_error_reported` and `compiler_result=exit_status_observed_exec_unverified`; pipe EOF is not positive exec attestation.

## 4. Independent before/after custody: scope, limit, and the choice left to the Oracle

Scope of each check (`check.py N before|after`): the five/eight tool identities, launcher hash, exact HEAD/tree, `git status --porcelain --untracked-files=all` empty, no ignored inputs, all 1,425 tracked blobs and modes against `git ls-files --stage` (275 under `node_modules/`), output roots (all three absent before; only `dist` present after stage 1, the other two absent), evidence-root collision, and in the after phase the exclusive creation of `baseline-dist.json` plus the temporary-root residue checks.

Limit (Oracle ruling §2): each check runs as `timeout 60s python3 check.py …` with the wrapper-level `timeout`, **outside the compiler supervisor**. Its Git children are sequential `subprocess.check_output` calls. The compiler's ECHILD proves nothing about them, and neither does a nominal 60 s timeout. Without `--foreground`, GNU timeout runs the command in its own process group and signals the group, which covers the Python process and its Git children on expiry, but a TERM-ignoring child would survive since there is no `--kill-after`. Closure of a timed-out check is therefore **UNKNOWN by design**.

Forward supervision in this proposal (no code change):
1. Each check's exit status, stdout and stderr are kept as receipts (`stage-1-before.*`, `stage-1-after.*`); the wrapper stops on any non-zero status. Status 124, 125, 137 or any signal status is a hard stop for all dependent steps: no retry, no later stage, and no claim that the check closed.
2. A check that did not finish cleanly is never repeated automatically. The attempt is recorded as failed and the evidence kept.

Options for the Oracle (not applied, not chosen here):
- **A. Accept as is** for the bounded read-only Git path, with stop rule 1. Zero code delta.
- **B. Apply `optional-successor/custody-kill-after.diff`**: add `--kill-after=10s` to both custody `timeout 60s` invocations. This is a cleanup-behaviour change and needs its own review; the wrapper would then be re-sealed. Still does not give a pidfd/subreaper closure proof.
- **C. Run the checks under the compiler's subreaper supervisor.** That would change the subprocess topology and the reviewed algorithm; it is **not** drafted here. If the Oracle wants it, it is a new reviewed successor.

## 5. Outputs, baselines, evidence roots

All three output roots must genuinely be absent now and before the dispatch (empty directories or symlinks are collisions; nothing is to be deleted or renamed to fake a clean start). Future outputs of this stage: `dist` only. Every future output hash in `build-plan.json` is `null`; no baseline file exists or is faked. `baseline-dist.json` is written exclusively by the after-check *before* its later directory checks and final PASS, so it is **provisional** until the whole attempt (source/tool custody, compiler lifecycle, complete after-check, raw receipts) is reviewed and accepted. On any failure it is kept as evidence, not reset, overwritten or removed. The evidence root `p065-local-build-node24-stage-1-evidence-01` is created by the launcher and is never reused; a failed attempt's residue is not deleted and a new suffix is not tried automatically.

## 6. Materialization and everything that must hold before dispatch (all separate decisions)

1. The Oracle accepts the local tool pins and the custody option (A/B/C).
2. A named quiet window and a single exact dispatch. This host's only known activity is the owner's own sessions; **absence of other processes using the checkout is UNKNOWN** and no host scan is allowed.
3. Materialization: create the absent deployment root and copy the four original-form files verbatim (verify the original seals in `ORIGINAL-AND-PUBLISHED-SEALS.json`). This is a local file operation that requires its own admission; it is not performed.
4. Re-run the source identity check (commit/tree/parents, 1,425 leaves, tracked bytes, outputs absent) immediately before dispatch against the same checkout. Any difference stops.
5. No retry, loop, alternate suffix, second stage or favourable resampling follows from a result.

## 7. Stop rules (any one stops the affected step and preserves the scene)

Input or seal mismatch; fixed object missing; dirty tree or output-root collision; permission denial; unknown operation outcome; existing material affected; dependency or tool missing or different; installation or security change needed; any deviation beyond path/tool/seal porting; inability to show owned-only closeout; unclear publication target. Also stop on: custody status 124/125/137/signal; `exec_state` not `no_error_reported`; missing `wait_echild`; an unexpected adopted descendant; any evidence write error; a provisional baseline whose attempt was not accepted. No denied operation is repeated. No real harness, Herdr, tmux, Jev, live statusline, `B13_REAL`, B14 or real-Claude test, and no PTRACE/AF_UNIX/B20 physical startup aggregate, is started.

## 8. Unchanged requirements

H1's 15-second missing-signal rejection logic, the original driver and holder, and the 126-cell / 50-warmup / at-least-1,000-measured-calls requirement are untouched. This proposal creates no readiness manifest and no fake baseline.
