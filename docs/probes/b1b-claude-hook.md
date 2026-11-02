# B1b: synchronous Claude call-source hook

The joint p95 <50 ms gate is **not met**. The source mechanism works within the measured Claude Code 2.1.305 direct-stdio profile; this does not grant a verified authorization capability. B5 transactions, claims and durable tool acceptance are not implemented here. No compiled helper or resident service was built.

## Mechanism and integration

`packages/hud-mcp/bin/hud-claude-hook.mjs` loads only Node builtins, three small hook modules and the standalone read-only scope adapter. It accepts a run-owned private JSON config path and bounded stdin (256 KiB). The helper verifies its real `/proc` launch chain, executable, source root, PID namespace, boot and process start. It reads only the exact harness registry file for this invocation, not a transcript. Config/environment select the record space; they never prove the source by themselves.

The supported launch profile pins a launcher-checked Claude executable/version, excludes custom root `--agent`, teammate, daemon, bare and safe-mode launches, and requires the 2.1.305 agent-field convention. Only under those premises do absent agent fields classify root. Paired nonempty `agent_id`/`agent_type` classify a native child; partial, null or empty agent fields refuse. `transcript_path` is ignored.

`makeHookSettings(config, command, existingSettings)` returns additive CLI settings. Its anchored, escaped matcher includes only the seven named HUD tools on the exact server. Existing settings and hooks are preserved; no global installation occurs. Inject its JSON with `claude --settings '<json>' --mcp-config <private-file> --strict-mcp-config`. B4/B11 must select the explicit `callSource:{kind:'claude_pre_tool_use_v1'}` profile, check the executable version, create the private hook config, and supply the same `ClaudeHookSourceOptions` as the fifth `SessionRefResolver` constructor argument. This package does not modify the existing MCP bootstrap or config validator: O4APPLY owns the additive shared profile field and B11 owns launcher wiring.

The profile fingerprint matches core `launchProfileDigest`: it binds nonsecret environment values and excludes per-run HUD_CLAIM/HUD_RUN/HUD_LINK values; callers must supply nonsecret profile configuration. The helper emits only format/implementation/version, nonsecret profile fingerprint, full ProcessKey/source/boot, exact server/toolUseId/tool, session/agent classification, scope premise, monotonic evidence clocks and a content fingerprint. It never persists stdin, tool_input, claim, prompt or transcript text, including into temporary files. Each record is at most 8192 bytes. A private namespace hashes ledgerId + ProcessKey + exact server; missing ledger uses an explicit path namespace. Exact call IDs are hashed within it. Publication writes a private 0600 temporary file, closes it completely, and hard-links it to the final name without overwriting. An existing final record creates a conflict marker; no last-wins path exists.

The final helper deliberately does **not fsync ephemeral evidence**. Complete publication visibility, rather than crash durability, is required: disappearance after a crash refuses independently, incomplete/corrupt contents fail validation, and a reboot changes ProcessKey. An earlier fsync candidate was measured separately and rejected for unnecessary latency/tail cost.

`src/core/ledger-scope-read.ts` was explicitly added to ownership by the orchestrator. It imports only Node builtins and pure types. Before touching the requested path, it enforces Node 22.x >=22.13 or >=24 (23 unsupported) and probes native readOnly capability on an in-memory database. It opens an existing private regular ledger read-only, checks schema v1, and obtains ledgerId, current generation/ref/evidence ID and the process's generation high-water in one short SQLite snapshot. It never creates or migrates a ledger, retries a lock, or writes binding state. Missing ledger and no-current are distinct comparison premises. A no-current premise retains the closed-generation high-water, preventing no-current ABA as well as A→B→A replay.

MCP checks genuine `params._meta["claudecode/toolUseId"]`, the real process/source, exact tool/server, pinned executable/profile, complete record fingerprint, agent source, current registry session and **the original scope premise**. It returns that captured premise for B5 to recheck in the writer transaction. No generation is substituted. A native child only refuses its own call; it never changes root generation. This path bypasses the old instance-local invalidation cache so a qualified root after `/clear` remains observable.

A `.seen` tombstone is created before consuming the record or reading the registry, including on missing/half-written evidence. A late record/registry cannot revive the same attempted call, even through another MCP instance. The source record is unlinked on both acceptance and refusal. Small seen/conflict markers remain until the owning harness exits. B11 must call `cleanupHookNamespace` on its own namespaces after hook/MCP children finish; each call removes at most 4096 exact recognized files and reports whether more work remains. This is an exit path, with no directory poller or daemon. Unconsumed/orphan records never trigger work.

## Measurement method

Environment: Linux x64/WSL, Node v24.22.1, Claude Code 2.1.305, `CLK_TCK=100`. The workstation was shared with other work; these are wall-clock measurements, not isolated CPU microbenchmarks. Each real invocation used a fresh temporary project and HUD_HOME, CLI MCP/settings, synthetic prompts, `--model haiku --effort low`, and the user's ordinary login with explicit orchestrator approval. No credential files were inspected/copied by the probe code and no live settings/config were edited. The ignored report enumerates the Claude project directories left by Claude itself; nothing under the Claude home was deleted.

Offline `hook-bench.mjs` runs actual cold Node subprocesses under an explicitly synthetic argv0=claude harness with a real production-created ledger. It checks scope reading, ancestry, record publication, privacy, consumption and cleanup. This is **not real Claude evidence**. Each candidate has 200 measured samples after one seed sample. Compile-cache samples retain compiled modules on disk but each uses a cold process.

Real `hook-bench-real.mjs` measures each same call from the oldest hook-command process's kernel start tick to the MCP stdout.write completion callback. It includes shell/Node cold initialization, scope read, complete publication, helper exit and harness scheduling, exact MCP verification and read-side SQLite waits. The kernel tick is rounded down and converted to hrtime using a bracketed uptime read; final joint upper estimates carry the fingerprinted per-call uncertainty, and lower estimates subtract that uncertainty. Earlier zero-offset records used only the kernel tick, with <10 ms rounding excess; those sets are separately labelled below. An optional observer copies only timing/source primitives after record validation, avoiding a second file/SQL read merely to obtain timestamps.

Success below means **source resolution succeeded and the existing server returned not_implemented**. Refusal means native-child source refusal. These are not successful B5 authorization/claim/intent transactions. B5 write-lock waits/busy and the other six tools' complete bodies remain unmeasured. Missing-record diagnostic attempts without a trustworthy hook start are separately counted, never presented as cheap joint refusal samples. `/clear` uses one real PTY-launched Claude, an actual `/clear` command, and another root call on the same MCP.

`hook-bench-timed.mjs` records a separate profiling set: first JavaScript statement, module-load completion, config/input, launch and registry verification, SQLite scope read, record construction/recheck, and completed publication. The only sidecar contents are exact toolUseId and clocks. These profiling samples include sidecar write/exit cost in the subsequent harness gap. Component percentiles are descriptive; they are **not summed to fabricate a joint percentile**.

## Measurements

The second review found a clock-domain defect in implementation `claude-hook-1`: Linux kernel process start uses BOOTTIME (includes suspend), whereas Node hrtime uses MONOTONIC. A synthetic 60s suspend offset reproduced refusal of a fresh record. Final implementation `claude-hook-2` maps the cold-start-inclusive kernel tick using an hrtime-bracketed bounded `/proc/uptime` read. The recorded monotonic start is a conservative lower bound; fingerprinted uncertainty is 20 ms plus the read-bracket duration, covering both 10 ms quantizations. Consumers validate it, and probes propagate a per-call joint lower estimate. An integrated post-suspend test covers conversion, record construction, publication and consumption. The host had approximately zero BOOTTIME−MONOTONIC offset during all earlier measurements, so those remain evidence of the failed cost gate, but are explicitly prior-revision observations.

### Final corrected candidate (`claude-hook-2`)

Offline 200 samples/candidate: minimal Node p95/max **71.997/76.296 ms**; compile cache **70.709/77.354 ms** (the cheapest observed final p95, with little separation from minimal Node); unqualified shell publication-only **4.820/6.101 ms**. Each helper remains a cold process. Snapshot still aborts as described below.

| Corrected real cohort | Root source-success n / upper p95 / max ms | Native refusal n / upper p95 / max ms |
| --- | --- | --- |
| Minimal Node, timing wrapper, 2 real Claude runs | 7 / 90.240 / 90.240 | 1 / 100.146 / 100.146 |
| Compile cache, timing wrapper, 2 real Claude runs | **8 / 90.169 / 90.169** | **1 / 76.170 / 76.170** |

For the cheapest final candidate, per-call lower estimates subtract the fingerprinted uncertainty (20.028–20.035 ms in this cohort): root lower p95 **70.137 ms**, native refusal lower p95 **56.135 ms**. Both still exceed 50 ms. Refusal sample counts are explicitly small. No full B5 success/busy result is claimed.

Final compiled-cache profiling breakdown, **9 same real calls / 2 Claude launches**, p50/p95/max ms:

| Component | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| Process/shell/Node initialization → first JS, including conservative start uncertainty | 54.142 | 63.547 | 63.547 |
| Module loading/initialization | 2.424 | 3.565 | 3.565 |
| Config/input JSON | 1.903 | 3.412 | 3.412 |
| Launch/source/registry checks | 1.640 | 1.781 | 1.781 |
| node:sqlite require, readOnly probe, open, scope snapshot and close | 1.702 | 1.973 | 1.973 |
| Record build + launch recheck | 0.914 | 2.314 | 2.314 |
| Atomic publication | 0.550 | 1.141 | 1.141 |
| Complete publication → MCP entry (helper exit/profiling sidecar/harness gap) | 10.067 | 12.254 | 12.254 |
| MCP verification/read-side SQLite → stdout callback | 3.138 | 4.281 | 4.281 |
| Actual same-call joint upper estimate | 76.170 | 90.169 | 90.169 |

**Estimate only, final cohort:** replace each sample's startup-plus-module interval with a hypothetical nonresident runtime/loader cost of 5 ms: source-only estimated p50/p95 **24.659/28.990 ms**. A 10 ms replacement gives **29.659/33.990 ms**. Both use same-call subtraction, so the conservative start-bound uncertainty cancels; no independent p95s are summed. The unchanged remainder needs initialization below roughly **26 ms** for this source-only trace. Adding a hypothetical 20 ms B5 lock wait yields p95 **48.990 ms** (5 ms initialization, about 1 ms left for every other unmeasured B5 cost/jitter) or **53.990 ms** (10 ms initialization). This small-sample counterfactual is not an implementation or production pass. A compiled or other nonresident candidate would need safe JSON/SQLite/process verification and measured scheduling/filesystem/transaction budgets. No compiled binary or resident service was built; no claim is made that compilation alone suffices.

Final accounting: **25/40 real Claude launches** (23 headless, 2 PTY attempts). Across qualified observations from all explicitly labelled revisions: **78/78 roots verified, 10/10 native children refused, 10/10 root→child→root sequences preserved root verification**. This includes final corrected plain n8 and cache n9 calls, and the prior /clear proof. The initial 16 failed-closed diagnostic calls and zero-call trust-prompt attempt remain separately disclosed below. No qualified unexpected refusal/wrong root acceptance occurred. Final offline cleanup removed 402 markers including seeds; each final real call's marker was cleaned on owning-harness exit; zero observed live MCP instances remained. Normal Claude projects were retained: 24 existing own-run project directories; the failed trust-prompt path was absent.

Corrected evidence: ignored `tmp/tasks/B1b/offline-clock-v2.json`, `timed-clock-v2/summary.json`, `helper-timings-clock-v2.jsonl`, `analysis-clock-v2.json`, `timed-clock-v2-cache/summary.json`, `helper-timings-clock-v2-cache.jsonl`, and `analysis-clock-v2-cache.json`. `HUD_B1B_USE_COMPILE_CACHE=1` selects the real probe's private per-run compile-cache option. These are separate from the prior-revision evidence below.

### Prior zero-offset measurements (`claude-hook-1`)

Prior no-fsync minimal Node helper is the cheapest qualified candidate measured in the last round. Its 200-sample offline p95 is **79.665 ms**, max **93.949 ms**; compile cache is **119.019 ms**, max **181.570 ms**. The unqualified sh/coreutils publication-only lower bound is **5.812 ms**, max **6.728 ms** (200 samples). Both Node candidates miss 50 ms before adding real harness/MCP time.

| Real sample set | Root source-success n / p95 / max (ms) | Native refusal n / p95 / max (ms) |
| --- | --- | --- |
| Prior no-fsync helper, normal wrapper (2 Claude runs) | 7 / 88.262 / 88.262 | 1 / 88.061 / 88.061 |
| Prior no-fsync helper, timing wrapper (2 Claude runs) | 7 / 86.178 / 86.178 | 1 / 68.791 / 68.791 |
| Prior no-fsync helper combined (4 real Claude runs) | **14 / 88.262 / 88.262** | **2 / 88.061 / 88.061** |
| Prior fsync candidate, standard observer (4 runs) | 16 / 140.546 / 140.546 | 2 / 89.539 / 89.539 |
| Prior fsync candidate, additional SQL/file observer (6 runs) | 23 / 98.843 / 144.166 | 3 / 92.731 / 92.731 |
| Prior fsync candidate, detailed timing (2 runs) | 8 / 486.510 / 486.510 | 1 / 118.129 / 118.129 |

Prior no-fsync combined same-call lower estimates (subtracting the full 10 ms tick uncertainty) have root p95 **78.262 ms**, refusal p95 **78.061 ms**. Thus tick rounding cannot explain the failure. Full authorized-tool success/busy latency is **not measured**, not zero.

Earlier offline fsync rounds demonstrate variation: minimal Node p95/max 98.960/124.700 then 129.806/354.596 ms; cache 109.544/129.274 then 93.770/105.396 ms, each 200 samples. The prior no-fsync round is separate; no samples were merged across helper revisions for a performance pass.

The real `/clear` proof (prior publication revision, unchanged source algorithm) has two root calls, joint estimates **91.608** and **82.197 ms**. Harness PID and MCP PID remain identical, root session changes, and both roots verify. Across all valid publication revisions: **63/63 observed root calls verified, 8/8 native-child calls refused, 8/8 root→native-child→root sequences preserved root verification** before the clock correction. No wrong root acceptance occurred. The earlier 16 registry-permission diagnostic calls all failed closed; their missing trustworthy hook timestamps are not mixed into joint samples. One initial PTY trust-prompt attempt had zero calls. Real Claude launches before the clock correction: **21/40**, comprising 19 headless launches and 2 PTY attempts; none used a larger model. After each completed run, zero recorded live MCP instances remained. Prior no-fsync offline cleanup removed 402 markers (including two seed calls); prior no-fsync real cleanup removed one marker per observed call.

Detailed prior no-fsync helper breakdown, **8 same real calls / 2 Claude launches**, rounded to 0.001 ms:

| Component | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: |
| Hook command process/shell/Node initialization → first JS statement | 52.247 | 58.050 | 58.050 |
| Dynamic module loading/initialization | 2.806 | 3.412 | 3.412 |
| Config read + bounded stdin/JSON | 2.002 | 2.260 | 2.260 |
| Actual ancestry/source and current registry checks | 1.599 | 2.076 | 2.076 |
| node:sqlite require, readOnly probe, open, indexed scope snapshot, close | 1.724 | 2.217 | 2.217 |
| Record construction + launch-chain recheck | 0.885 | 1.078 | 1.078 |
| Complete private write/close/link/unlink publication | 0.616 | 1.316 | 1.316 |
| Publication complete → MCP call entry (helper exit, timing sidecar, harness scheduling) | 11.786 | 14.860 | 14.860 |
| MCP verification → stdout flush (includes read-side SQLite) | 4.032 | 5.183 | 5.183 |
| Actual same-call joint total | 77.608 | 86.178 | 86.178 |

This prior-revision initialization component includes OS scheduling and <10 ms start-tick uncertainty; it is not a precise kernel-only fork/exec duration. The prior fsync timing sample had publication p50 **4.751 ms**, p95/max **412.229 ms**; dropping unnecessary durability removed that observed tail. The initial 16 missing-record refusals have no legitimate hook start and therefore no reported joint percentile.

Reproduce (real commands spend model quota; both run counters together must stay within the authorized 40 launches):

```sh
npm run build:hud-mcp
node tests/hud-mcp/hook-bench.mjs /absolute/run-owned/offline.json
node tests/hud-mcp/hook-bench-real.mjs /absolute/run-owned/real 2
HUD_B1B_HOOK_WRAPPER="$PWD/tests/hud-mcp/hook-bench-timed.mjs" \
HUD_B1B_HOOK_TIMINGS=/absolute/run-owned/timing.jsonl \
node tests/hud-mcp/hook-bench-real.mjs /absolute/run-owned/timed-real 2
node tests/hud-mcp/hook-bench-clear.mjs /absolute/run-owned/clear
```

Scratch evidence is under the main checkout's ignored `tmp/tasks/B1b/`: `offline-nofsync.json`, `nofsync-real/summary.json`, `timed-nofsync/summary.json`, `helper-timings-nofsync.jsonl`, `analysis-nofsync.json`, and `clear-final/summary.json`. Prior revision/diagnostic evidence remains separately named. These are local evidence artifacts, not public fixture data.

The unchanged default/unconfigured MCP skeleton was also remeasured with `node tests/hud-mcp/benchmark.mjs`: 30 cold starts, p95/max **65.926/71.142 ms**; 200 calls each, tools/list p95 **0.337 ms**, fail-closed whoami p95 **0.303 ms**. These exclude the hook and B5 and cannot replace the failed joint result.

## Candidate limits and estimate

POSIX sh plus coreutils can create a private, non-overwriting linked file cheaply, but supply no JSON parser or live SQLite/WAL snapshot reader. An ad hoc byte/grep interpretation of hook JSON or ledger storage cannot supply the required consistent scope generation/ref premise. `sqlite3` is absent on this host; `jq`, though installed, is not coreutils and still cannot read SQLite. Grepping ledger bytes or trusting an inherited generation would violate F06. The measured shell publication-only number is an **unqualified lower bound**, not a helper implementation. No dependency or executable was installed.

A bounded Node snapshot experiment using builtin fs/crypto and a deserialize-main loader aborts on this Node build with `CheckGlobalAndEternalHandles failed` (SIGABRT); no usable snapshot artifact was produced. This demonstrates a failed candidate for this build, not that all Node snapshot approaches are impossible. Compile-cache results are reported separately, including variation across rounds; they do not remove runtime initialization.

**Prior-revision estimate only:** replacing each prior no-fsync profiling sample's measured process initialization plus module-load interval with a hypothetical nonresident compiled runtime/loader cost of 5 ms gives an estimated source-only joint p50/p95 **28.461/32.692 ms**. Replacing it with 10 ms gives **33.461/37.692 ms**. This is a per-call counterfactual over just 8 real samples, leaving the measured JSON, source/registry, SQLite, atomic publication, harness gap and MCP verification unchanged; it does not add independent percentiles or claim a compiled implementation was tested.

To retain a 50 ms total with this trace's remaining source costs, runtime initialization/module loading would need to fit roughly **22 ms**, with substantially less available after adding B5 authorization and contention. Adding a hypothetical full 20 ms write-lock wait to those same counterfactuals produces p95 **52.692 ms** (5 ms runtime) or **57.692 ms** (10 ms runtime), already over budget. A compiled helper therefore is not sufficient evidence of a production pass. It would need its own safe JSON/SQLite implementation and measured initialization, preserved publication/launch correctness, bounded filesystem/scheduling tails, and a measured budget for B5. An existing faster standalone interpreter or a supported nonresident Node snapshot could be investigated under a new brief; no such alternative is demonstrated here. A resident service is not proposed. ORCH should take this failed cost result and its measured breakdown to Pro under F08; no product scope or budget change was made.

## Correctness evidence and scope limits

`npm run test:hud-mcp` covers missing then late records, half-written/oversized/symlink records, duplicate publication conflicts, wrong format/implementation/Claude version/profile/source/boot/process start/server/tool/call/session, future/stale clocks, privacy sentinel exclusion, partial agent fields, native-child refusal followed by verifiable root, missing then late registry, `/clear` source selection, stale A→B→A generations and no-current ABA. A schema drift test creates the ledger via `src/ledger`'s `openLedger`, inserts real scope/ref/evidence rows, reads current and closed/no-current snapshots, and proves missing reads never create a file. Unsupported runtime tests refuse before touching the path. Settings tests preserve existing hooks and test exact escaped matching for all seven tools. A fingerprint regression proves nonsecret HUD_HOME/launch-mode value changes invalidate evidence, parity with the existing core digest, and exclusion of per-run credentials.

The real root/child/root samples all use the same physical MCP and harness within each run. The `/clear` sample keeps harness and MCP PIDs while changing session ID; both roots verify. Real probes used no claim; inherited root-claim/native-child authorization, concurrent /clear vs spawn/report, dual-MCP binding, idempotency, CAS after DB write-lock wait and accepted-operation behavior remain B5/B14 integration work. Tests here establish source evidence and refusal behavior, not those transactions.

The first three headless invocations found a real integration defect: requiring 0600 on Claude's own registry caused all 16 calls to refuse without publishing hook evidence. That overly strict check was fixed; records/config remain private, while the exact owned regular registry can have Claude's chosen mode. One initial PTY invocation exited at the trust prompt without a model call; the driver was corrected to choose the explicit trusted temporary project. These diagnostic invocations count toward the <=40 launch budget and are not silently discarded as successful identification samples.

No resident helper is introduced. Probe cleanup verifies exact observed MCP process instances have exited, removes run-owned publication files through the bounded exit cleanup, and removes only temporary HUD_HOME/project directories. Private seen markers block replay until that exit. Normal live Claude project/transcript records are left for the user.

Reference boundaries: the [official hook reference](https://code.claude.com/docs/en/hooks#common-input-fields) documents agent fields, and its [MCP matcher section](https://code.claude.com/docs/en/hooks#match-mcp-tools) documents server/tool naming. The [CLI reference](https://code.claude.com/docs/en/cli-reference) documents per-invocation settings. Version-specific real observations and the frozen F06/F08 ruling, rather than documentation alone, bound this result.
