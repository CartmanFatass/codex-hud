# P065 rejection-audit affected-regression review

Date: 2026-11-04 UTC. Fresh read-only Oracle review. Repository: CartmanFatass/codex-hud.

## Decision

**Group 1 is usable passing behavioral evidence, with its original checker FAIL and separately corrected PASS both preserved. Group 2 remains FAIL: 61/62, direct and outer exit 1. No retry, test-only workaround, new P065 implementation repair, or unaccepted dependency import is released. P065 package acceptance and merge remain HOLD.**

The second result is an actual production MCP startup failure caused by an OS access denial, exposed by a correct startup assertion. It is not an optional-audit assertion failure, a JSON-warning/parser failure, or a README-listed flake. The startup reader and registration code are inherited unchanged. The four-file rejection-audit repair did not introduce this read path.

The known optional-ancestor availability defect already has an implementation and qualification route in MCP-ANCESTOR and the three-lineage compatibility composite. **The present log does not establish that PID 5200 was an optional ancestor.** Its exact startup read site and process role remain unobserved because the executable emits only the caught error message and the recorded evidence has no corresponding ancestry identity. Do not claim that the existing ancestor fix is proven to fix this particular execution.

This is a classification and continuation disposition, not a new complete review of the audit repair or an accept verdict for any package.

## 1. Reviewed identities and evidence

- P065 candidate: `3435589ef253159948c94eaae111606191bd4e3d`, tree `27d8c69594fefe83332cec00c346cc8fcf664159`.
- Sole parent: `0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f`.
- Governing audit ruling: `d17a8aff`, `docs/cloud/rulings/p065-rejection-audit-repair-20261104.md`.
- Execution task: `01a1a3c0-8454-762a-a04c-d71a10b710c9`.
- Group 1/checker continuation and group 2: turn `01a1a4cf-5876-77f9-bb71-e3c6b5407c0b`.
- Existing-evidence-only follow-up: turn `01a1a4d2-0ba8-71e3-afba-e8059b18907a`, especially message `msg_03ddedf43bedf0a8016aeab4cf550087d18d84e354a1b44401`.
- Exact remote comparison of parent to candidate has precisely the four authorized paths: `src/ledger/intents.ts`, `tests/ledger/process.mjs`, `tests/unit/ledger-processes.test.ts`, and new `tests/unit/p065-rejection-audit.test.ts`.
- MCP-ANCESTOR source: `b2897a4f9769bca6305ff0e3ae3dc694a9320ffe`; prior R1 re-check is pinned at documentary commit `dc4b96b8b3e224736cf0aeee4062184a433a023e`.
- Compatibility composite source: `36d3fd584bd403ed7ada95d1d863a8f63e96588b`, tree `0c8c67ede1f13122987802d9a0346cd6e6ecf73b`.

I read the completed execution reports, the literal failing output and lifecycle excerpts, source and remote commit metadata, the governing audit ruling, MCP brief/ruling/R1 re-check, compatibility integration ruling, and applicable workflow/README/P065 boundaries. I did not download and independently rehash the complete regression evidence directories. The whole-file SHA-256 values below are the executor's recorded custody values, not a claim of independent local rehashing. Prior accepted negative controls are not reopened or repeated.

## 2. Group 1: pass plus preserved checker defect

Behavioral result: reported **57/57 passed**, direct and outer exit 0. The recorded supervisor reached `ECHILD` at monotonic ns `17447372796428`.

The original independent postcheck failed because its adapted evidence path selected nonexistent `p065-regression-group-5-evidence-01` instead of the recorded group-1 directory. Therefore its `temporary fixture residue` diagnostic did not establish actual residue. This was a **verification-script target error, not a product/test behavior failure**.

The previously authorized, separately named correction changes only:

```diff
- path=E+str(stage)+'-evidence-01/'+name;x=inv(path);emit('stage_local_inventory',{'root':path,'entries':x})
+ path=E+str(stage-4)+'-evidence-01/'+name;x=inv(path);emit('stage_local_inventory',{'root':path,'entries':x})
```

The corrected check reports PASS/exit 0 against the original pre-run baseline: all 1,315 tracked files, identity and three output manifests match; the correct HOME, HUD_HOME and TMPDIR are empty. The original FAIL remains an immutable separate result. No rerun of group 1 is needed on this evidence; no historical record should be relabeled PASS.

Recorded hashes:

- Group-1 stdout: `da1af68a161f9ad35f3ca38d74d31da613006135500ee8756b0ab77da6950d7e`.
- Group-1 events: `213fe47a25306c824370f83c6f6b433370b9a178b6c9f50b52f29eb41e72d74b`.
- Original checker: `6d506e8d6dfa4a70d6c582853a86b42ea69ddfd5e2afe4ff8838a3114990c62a`.
- Corrected checker: `e08c29ca4233556f8a6ce9e3a54d55ed3bad9445c1a0adf3adf2de5bd08f3013`.
- Original FAIL log: `717a11dde0e050e22b7de0c1143e63a5cef986debcdfe597a5bf277722323a49`.
- Corrected PASS log: `bb26d63966c85f3bae07f628dadd63dc889d9eb5b5607daadce4d79868cc0b4c`.

## 3. Group 2: exact observed failure and closure

Runtime identified by the assignment as Node 24.22.1. Working directory: `/workspace/p065-audit-repair-verify`. Exact recorded inner argv:

```text
/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node --test packages/hud-mcp/dist/tests/hud-mcp/authorization.test.js packages/hud-mcp/dist/tests/hud-mcp/delegation.test.js packages/hud-mcp/dist/tests/hud-mcp/resume-expected-run.test.js packages/hud-mcp/dist/tests/hud-mcp/handshake.test.js packages/hud-mcp/dist/tests/hud-mcp/hook-source.test.js packages/hud-mcp/dist/tests/hud-mcp/b20-advice.test.js
```

Supervisor environment keys are only HOME, HUD_HOME, LANG, PATH, TMPDIR and TZ. This is the recorded focused-run environment, not evidence of a proxy-enabled compatibility profile. The restricted/enforced network label does not establish why procfs returned EACCES.

Raw summary:

```text
ℹ tests 62
ℹ suites 0
ℹ pass 61
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 952.006725

test at packages/hud-mcp/dist/tests/hud-mcp/b20-advice.test.js:556:1
✖ hud-mcp starts and answers initialize with a valid and with an invalid cache.json (122.150297ms)
  AssertionError [ERR_ASSERTION]: hud-mcp startup failed: EACCES: permission denied, open '/proc/5200/environ'
  1 !== 0
      at TestContext.<anonymous> (file:///workspace/p065-audit-repair-verify/packages/hud-mcp/dist/tests/hud-mcp/b20-advice.test.js:573:16)
```

The fixture at source `tests/hud-mcp/b20-advice.test.ts:655–676` launches the real binary with temporary HUD_HOME and no selected profile/fake registry, sends initialize, then asserts exit zero before parsing stdout. The failure is the child's real exit 1, not an assertion requiring an audit row. The valid and invalid configurations are sequential iterations within one test. The log does not identify which iteration failed; zero skipped tests is not proof that both internal iterations completed.

Authoritative recorded closeout:

- Supervisor PID 5205; released direct child PID 5206. **No recorded relationship for denied PID 5200.** Numeric ordering is not ancestry evidence.
- Initial `ECHILD`; subreaper read-back 1.
- Child created monotonic ns `17791174523248`; released `17791175084783`.
- Exec error pipe EOF with empty error: `17791225662571`.
- Direct `wait_status`: PID 5206, status 256, exit 1, `17792180142117`.
- Final `wait_echild`: `17792231047741`.
- `exec_final`: released true, EOF true, empty error, `17792231735962`.
- Result: closure true, lifecycle_valid true, postcheck_ok true, unexpected_descendant false; failure/interrupted/post_error null. Preserve the literal label `exit_status_observed_exec_unverified` and `exec_state=no_error_reported`; do not silently upgrade them to an independent executable-identity attestation.
- Outer start `2026-11-04T04:27:56.326368+00:00`; end `04:27:57.699989+00:00`; exit 1. This was not a timeout.
- Assigned caps: workload 600 s; TERM grace 10 s; closeout 630 s; outer foreground TERM 650 s and kill-after 10 s.
- Reported independent after-check PASS: source, 275 dependencies and three existing output manifests unchanged; clean checkout; dedicated HOME/HUD_HOME/TMPDIR empty.

Recorded hashes:

- Group-2 stdout: `78c4dfd6cf83d956f8043bd804681206d765e109fc3d5d538abac83344b8998e`.
- Group-2 events: `82ef7c63342e0476881700c572385ddfd0af6332db2aca382661b0e87e2d208b`.
- Group-2 after-check: `361622e38c19194c9817df81c4726b7cfdd1d118a372beacab8ca79bf4247e0c`.

Lifecycle closure is established by these recorded supervisor results, while behavior remains failed. The lease can be returned; review waiting does not retain compute.

## 4. Product versus test and relation to MCP-ANCESTOR

### Proven inherited startup path

The following whole-file Git blob IDs agree between accepted source base `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22` and P065 candidate `3435589e`:

| File | Git blob |
| --- | --- |
| packages/hud-mcp/src/process.ts | d5407bbb9f819cc4f943f538b511d9f4a273f483 |
| packages/hud-mcp/src/registry.ts | d0d92ecc5c5efefb19edf2759d8f4eb7a106e8a9 |
| packages/hud-mcp/src/ledger-registry.ts | 6b77a03fb63ea67614858d9d2b3cc0ec01cf04a7 |
| packages/hud-mcp/src/main.ts | 4a3d0794464abcae18899bc47d371a3e8d15e260 |
| packages/hud-mcp/bin/hud-mcp.mjs | 0d087477a6d0046eb88af95638581d45c39a733e |

The B20 file has earlier P065 edits elsewhere, but its entire final startup test block is byte-identical to the accepted base. The present audit commit touches none of these startup files.

`LinuxProcessReader.get` reads environ at `process.ts:29`. Mandatory calls are present in `registry.ts:84–85,118–119` and `ledger-registry.ts:25–26`. The same reader is also used by optional `findHarness`, whose old `process.ts:62` has no access-denial boundary. `main.ts:50–58` performs registration before constructing/serving the MCP endpoint. The executable's `hud-mcp.mjs:9–14` catches import/startup failure and prints only error.message, explaining the missing internal stack.

Therefore:

- **No new P065 rejection-audit regression is demonstrated.** The failure is in inherited production startup access handling, before any demonstrated audit/intent behavior.
- The startup assertion is not incorrect merely because the host denies a read. Do not turn expected exit 0 into a permissive code check or skip the real process.
- If PID 5200 was reached only during optional discovery, this is the established **P2 MCP-ANCESTOR availability defect**.
- If it was a mandatory self/actual-parent or registration recheck, the existing rule requires fail-closed refusal. That would be a mandatory-evidence/environment blocker, not permission to swallow the error and not a proven defect covered by the ancestor patch.
- Existing evidence cannot distinguish those cases. No statement that it was a root-owned relay, supervisor ancestor, permission-policy change, or optional ancestor is supported.
- The B20 fixture awaits exit instead of close, but that separate capture detail does not explain or erase a recorded child exit 1. No capture refactor is released under this audit review.

### Existing remedy and composition boundaries

MCP-ANCESTOR `b2897a4f` and composite `36d3fd58` both contain `process.ts` blob `72954abd0b5a483ff1bab1aaaeab59add4ffab5b`: only optional `reader.get` in `findHarness` catches object errno EACCES/EPERM, returns null immediately, and does not traverse past denial. Strict mandatory reads stay unchanged.

That is the existing owned product remedy for the known optional-ancestor defect. P065 lacks it by design. MCP's R1 re-check fixes capture only and preserves its other acceptance obligations; the later compatibility ruling supplies the exact combined qualification route. Neither document permits copying this unaccepted source into P065. The composite is the declared HYG2/NODE22-PROXY + MCP-ANCESTOR + RUNZ1/RUNZ1-KILL set, not a P065-containing tree.

This failed old-tree run also cannot satisfy MCP's real-final-candidate unreadable-ancestor evidence: it has neither confirmed optional ancestry nor successful strict physical registration on the final composite with absent logical authority.

## 5. Shortest permissible continuation

1. **Record and stop the affected operation.** Retain group 1's behavioral pass, original FAIL, corrected PASS, group 2's 61 passes/one failure and closure separately. Do not rerun either group or the controls merely for another result.
2. **Keep the denial exact.** Record EACCES opening `/proc/5200/environ` during the real B20 startup, with caller role unobserved. Do not read that path again, probe current ancestry to reconstruct the dead run, retry with a different parent/launcher/privilege, change proc permissions, or move executors to evade it. PID reuse would not recover historical identity.
3. **Do not consume a P065 fix round for this inherited startup issue.** No P065 source change is required by the present regression result. No EACCES skip, profile-null bypass, mock registry, blanket catch, errno reclassification as a flake, or suppression of raw stderr is permitted. The 61 passes remain useful partial evidence; rerunning the five other files on the same source adds no missing evidence.
4. **Continue only independent already-authorized P065 checks in new bounded windows.** Inspect their dependency paths first. Any unchanged full hud-mcp or other command that invokes this startup operation is now blocked from deliberate retry here absent materially new relevant authorization/capability evidence. The earlier socket, ptrace, lifecycle, formatter and owner-local restrictions remain independently applicable. Do not merge failed, blocked and not-run stages into a green aggregate.
5. **Use the existing MCP/composite route, not a fourth speculative combination.** Complete its already authorized qualification and remaining evidence under its own rules. This review does not authorize a workload, reopen a denied read, or attest that its fix covers the unknown PID role here. If later admissible exact-tree evidence identifies a mandatory-read failure, return that precise case for separate design; do not enlarge the optional catch.
6. **Keep the dependency boundary.** After the compatibility set is accepted and passes its required actual merged-tree checks, a separately recorded P065 dependency update can be proposed/frozen under normal history-preserving integration and exact-tree verification. Until that is authorized, do not import MCP alone or append P065 to the current composite. A genuinely separately sanctioned owner/capable-host exact-P065 verification may be requested through the existing workflow, but it must not be a route around this denial or an assistant-run local restart. A later readable-topology pass would not close MCP's distinct natural-unreadable-ancestor requirement.
7. **Keep scoped and package conclusions separate.** The audit defect can receive its own scoped source/control verdict under the governing ruling. This group-2 failure does not undo accepted A–D controls, but neither those controls nor 61/62 establish full affected-regression, whole P065, real-clock qualification, NEXT dependency, or merge acceptance.

No contract, gate, supported profile, security predicate, source ownership or fix-round limit is changed. Existing failures and denials remain part of the history.

## Sources

- [Audit ruling](https://github.com/CartmanFatass/codex-hud/blob/d17a8aff/docs/cloud/rulings/p065-rejection-audit-repair-20261104.md), especially §§3–4 and 6–7.
- [Exact four-file repair comparison](https://github.com/CartmanFatass/codex-hud/compare/0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f...3435589ef253159948c94eaae111606191bd4e3d).
- [Failing test source](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/tests/hud-mcp/b20-advice.test.ts#L655-L676).
- [Strict reader and old optional search](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/packages/hud-mcp/src/process.ts#L20-L69), [registration](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/packages/hud-mcp/src/registry.ts#L84-L124), [ledger registration](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/packages/hud-mcp/src/ledger-registry.ts#L21-L53).
- [Startup and registration ordering](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/packages/hud-mcp/src/main.ts#L19-L58), [message-only startup catch](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/packages/hud-mcp/bin/hud-mcp.mjs#L9-L14).
- [MCP-ANCESTOR governing ruling](https://github.com/CartmanFatass/codex-hud/blob/d17a8aff/docs/cloud/rulings/mcp-ancestor-gate.md), [R1 re-check](https://github.com/CartmanFatass/codex-hud/blob/dc4b96b8b3e224736cf0aeee4062184a433a023e/docs/cloud/handoff/mcp-ancestor-review-2.md).
- [Composite integration ruling](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/wave1-compat-integration-20261103.md), [composite reader source](https://github.com/CartmanFatass/codex-hud/blob/36d3fd584bd403ed7ada95d1d863a8f63e96588b/packages/hud-mcp/src/process.ts).
- [P065 denial and complete-gate rules](https://github.com/CartmanFatass/codex-hud/blob/d17a8aff/docs/cloud/P065-BUDGET.md), [README check/flake policy](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/docs/cloud/README.md).

Method: read-only connector and recorded-evidence inspection; only this requested standalone report was written. No shell commands, builds, tests, benchmarks, process probes, denied-path reads, source edits, repository mutations, publications, environment changes, or subdelegation were performed.

