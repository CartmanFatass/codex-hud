# P065-on-C3 combined-02: fresh source-only Oracle recheck

Date: 2026-11-04 UTC.

## Decision

**STATIC ACCEPTED for the exact combined-02 packet, subject to the unchanged local admission conditions.** Both P1 findings in the preceding review are closed. No new blocking source defect or scope regression was found in this narrow successor. The four retained originals are not edited, reconstructed or replaced by this acceptance.

**Execution is not presently admitted on the reported desktop route.** The latest parent-supplied local result is `Wsl/EnumerateDistros/Service/E_ACCESSDENIED` from read-only WSL enumeration. This review neither repeated that operation nor established that it is resolved. Preserve the denial and do not retry, elevate, change WSL/security settings, guess an alternate entry point, or change transport to get around it. A general testing grant and static acceptance are not materially new evidence that resolves this access denial.

Current state:

- Source-only correction review: **ACCEPTED**.
- Exact live environment, retained originals and quiet window: **NOT VERIFIED; desktop route BLOCKED**.
- Local verifier/materialization: **NOT RUN by this review**.
- Native wrapper and compiler stage 1: **NOT RUN**.
- P065 package acceptance, tests, readiness, performance, integration and NEXT: **NOT RELEASED**.

The next execution stage, once a genuinely supported authorized local route to the same retained preparation is established without bypassing the denial, is the single combined original-byte verification and conditional Node 24 stage-1 attempt described in section 7. There is no further source-fix round or generic testing-approval round required by these two corrected findings. This does not grant permission for a new Codex delegation or external-agent communication.

## 1. Exact reviewed identity and preservation

Reviewed ZIP: `p065-c3-owner-combined-02.zip`.

- ZIP size: **89,265 bytes**.
- ZIP SHA-256: `6df4fd80daeff90d2582085516e672629ac6f3b7dd5a08f378ddef71120d5966`.
- ZIP contains exactly **15 regular file entries**, totaling 298,092 uncompressed bytes. All decompressed member bytes equal the corresponding supplied directory files. No symlink entry or supplied-directory symlink was present.
- All **14 entries in SHA256SUMS** match. The checksum file itself is `b374c6c832ee979c96c4d253e27f9283fcd63d52b82898856857f0ac576bfd89`.
- All **13 artifact-manifest file sizes and hashes** match. The manifest excludes itself and the outer checksum file; both are covered coherently by the outer identity. Manifest SHA-256: `3cda8de178936fb5bd6782d95126820653465b9e103af6417954d0746e10a0b1`.
- Corrected verifier: **16,496 bytes**, SHA-256 `43b33b027d213b0018bafdb0779255ce0962674172d664dae414bdbe6471968c`.
- Correction report: SHA-256 `0321cdea5306ff12fb1a2b63021eff1db0b19c7add4ef83f85f7cc3ed462bc4e`.
- Submitted verifier delta: SHA-256 `c45055a219308fdc6b10272bced6a19f324e5bc12256c762221fa8ceab762fb7`.
- Predecessor ZIP independently matches `120db519aa886f443116cb7a18eca51c51b3f3f9baa5b058b577011610e31baa`.
- The preceding review independently matches its stated governing hash, `3654f46d2ca1c078d572fae3ff2413719ff9e22846a5d90eed56681667b3d5a7`.

An independent full directory diff confirms that the only changed program is `verify-originals.py`. Its source changes are exactly the new streaming helper, default-hook guard, their call sites, and the corresponding sanitized receipt fields. The supplied delta expresses the same edits; its different placement of surrounding blank lines does not change the resulting helper block. The additional correction report, replacement delta, updated manifest and outer seals are expected packaging changes.

These **10 files are byte-identical to combined-01**: the dispatch contract, owner prompt, preparation report, allowed-span map, leaf inventory, controlling decision, and all four public templates. In particular:

- `allowed-spans.json`: `df3eab4cf106df5699a5081e17e2237c92637321cb2cf88ffac807bb723ea985`.
- `leaf-inventory.json`: `72bee14a3f066537ccbcc9616ba42c27054e868bcbd764bf4dd29ef7afc0be65`.
- `oracle-decision.md`: `ff3607b3d5c50425ca65feaef4bb276f283e56f62d1ff09c26318102385dc21b`.
- Public launcher: `37897595cb779431a6905653a50d1cef109b11f3d5c1817fa3149ea11f7bfa2d`.
- Public checker: `00f1860f515240d729ee36bb88e85a296eb5072dbf5577dceff14299ee37d8d0`.
- Public wrapper: `40563ed09a68d1dd7d70f6b06ab0aeaeac119dda4c7907e50ef4da2ba2dd2e94`.
- Manifest/original manifest: `e7a883d1abee980bb320c88a8c26eb2dba1268d31bd7d3763098a883b981c150`.

This is artifact integrity, not current remote-branch or live-owner-filesystem verification.

## 2. F1 closed: bounded streaming accepts the exact Node pin

Relevant successor source: `verify-originals.py:71-95,247-255,317-319`.

The small-document reader retains the original 64 MiB cap. Tool hashing now uses a separate descriptor-based streaming reader:

- Read-only `O_NOFOLLOW | O_NONBLOCK` open and regular-file check.
- Explicit initial size bound and optional exact size.
- At most 1 MiB read per chunk, with the cooperative deadline checked before and after each read.
- Cumulative byte count cannot exceed the initial size or declared bound.
- EOF requires exactly the initial size, plus identical device, inode, mode, size, mtime-nanoseconds and ctime-nanoseconds before/after.
- Descriptor closure is in `finally`; failures stop admission.

The six non-Node tool entries use a 64 MiB bound. Node uses a **128 MiB bound (134,217,728 bytes)**, the exact size **126,879,696 bytes**, and the unchanged pin `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`. Thus the previously proven valid Node binary is no longer excluded by the universal 64 MiB cap. The resolved/canonical Node-path condition is unchanged.

I independently reread the previously retained official archive as data. The archive is 32,026,916 bytes and hashes to `6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6`; its `node-v24.22.1-linux-x64/bin/node` member is 126,879,696 bytes and streams to the exact admitted Node hash above. The member was neither installed nor executed.

The reader remains cooperative: `O_NONBLOCK` does not promise a hard deadline on regular-file kernel I/O. A native timeout, signal, incomplete capture, pending session or uncertain verifier result still blocks the wrapper regardless of any receipt file. No new supervisor or capability probe is introduced.

## 3. F2 closed: effective default post-index-change hook must be absent

Relevant successor source: `verify-originals.py:98-126,153-195,270-290`.

The verifier obtains the common directory from the validated linked-worktree relationship, checks it is an existing canonical directory, and retains the conservative config whitelist. The whitelist still rejects `core.hooksPath`, includes, worktree config, fsmonitor, filters/helpers and unrecognized keys.

The new guard runs before materialization and therefore before any original Git-bearing custody call:

1. Open the canonical common directory with `O_DIRECTORY | O_NOFOLLOW`.
2. Inspect the single relative `hooks` entry without following symlinks. Only genuine absence passes this branch.
3. If present, require a directory, open it relative to the common descriptor with `O_DIRECTORY | O_NOFOLLOW`, and compare the observed/opened device and inode.
4. Inspect the single relative `post-index-change` entry with `follow_symlinks=False`. Any entry, including a dangling symlink, non-executable file or directory, stops. Only `FileNotFoundError` is accepted as absence.
5. Permission errors, redirections, unsupported operations and other inspection failures are not converted to absence. Descriptors close in `finally`.

Python documents the descriptor-relative and no-follow semantics used here. The two accepted receipt states accurately distinguish an absent hooks directory from an existing canonical hooks directory with an absent target hook. [Python 3.12 file/directory interfaces](https://docs.python.org/3.12/library/os.html#files-and-directories)

This guards the correct path: Git 2.43.0 puts default hooks in the common directory for linked worktrees, with a separate hooksPath override. Its hook lookup checks the named default hook for executable access. [Git common-path handling](https://github.com/git/git/blob/v2.43.0/path.c#L108-L133), [Git hook lookup](https://github.com/git/git/blob/v2.43.0/hook.c#L10-L39)

The change is intentionally more conservative than testing only the executable bit. It does not inspect hook code, execute a mock or real hook, disable/delete/rename a hook, or alter config. It closes the admitted-default-hook gap without changing the sealed checker.

The guard is not an atomic filesystem snapshot. The required quiet window must cover the common directory and ancestors, hooks/config/metadata, source, tools, originals, and new output/receipt roots through the whole attempt. Concurrent mutation remains outside the accepted contract.

## 4. Preserved byte, source and privacy boundaries

The four original SHA-256 pins are unchanged, including launcher `78e282318d9cc0d6f4772229e55b013dbee20c9cf4a2bee4a6616c0a176c24d4`, checker `579694fcb3b194e8664d91b641fa04aa079a7ee9b90324fad6fac80858988d25`, and wrapper `e9794b3d3f1082effb6883fe726bd7e9786c8a150e82e47c3fb771bf94593ca6`. The actual retained originals were not available to this review and remain locally unverified.

All 11 public byte spans were directly reread at the stated offsets: four launcher, four checker, three wrapper; the manifest has none. They still contain exactly their declared prefix tokens. Escaped unchanged intervals, full byte matching, within-file backreferences and cross-file role agreement remain intact. Absolute ASCII path restrictions, fixed suffixes/basenames, nonoverlapping run/NVM roots, canonical-directory checks and source containment are unchanged. Public templates remain reference data, never deployable originals.

The leaf inventory still contains exactly 1,425 unique blob paths, 275 under `node_modules/`, with only modes 100644/100755. The verifier checks their live bytes, Git blob identities, executable-mode correspondence and non-symlink paths; actual Git HEAD/tree/status/ignored-input/index custody is still deferred to the original before-check. This review did not read a live candidate checkout or claim that an inventory alone excludes extra input files.

Collision-preserving materialization is unchanged. All named absence checks precede creation. Only new 0700 directories and exclusively created 0600 files are written, using unchanged original bytes and hash readback. Partial outputs are preserved; no overwrite, cleanup, alternate suffix or retry is introduced.

The added success fields are public pin/size/method and hook-absence classifications, not private paths. Mapping and exact argv stay in `PRIVATE-binding.json`. Error handling still suppresses ordinary exception text that might contain private paths. A bounded literal scan found no private home/user-path, email, private-key or common-token match; two broad token-prefix hits were merely `task-text` source filenames. This scan is supplementary, not a secret-free guarantee.

**Publication restriction remains mandatory.** The byte-identical preparation report contains a verbatim private-chat authorization with personal context. The new correction report and manifest explicitly exclude its unchanged publication and forbid uploading the packet wholesale. Retain it privately; publish only independently sanitized selected evidence with distinct original/public hashes. Do not publish private originals, private binding, raw native/compiler/custody streams or actual private mappings. Do not modify a sealed input in place to make it publishable.

## 5. Process ownership, custody option A and evidence remain unchanged

The compiler launcher and wrapper are byte-identical to the prior accepted templates. No new process topology is introduced by either fix; the verifier remains data-only and creates no child process.

The compiler launcher still enables and reads back subreaper status, requires initial ECHILD, forks a gate-held direct child, obtains its pidfd before release, and waits its owned children. Signals are confined to that direct child's pidfd. Unexpected adopted descendants invalidate the lifecycle. Successful closure requires observed direct native status and ECHILD; an error-pipe EOF is not promoted to proof of successful exec. The result remains explicitly `exit_status_observed_exec_unverified`.

These are source properties, not runtime observations in this review. The native execution facility must own and wait the outer wrapper. Its complete native completion and stdout/stderr must be retained without truncation. Compiler ECHILD does not prove closure of the separate before/after custody/Git processes or of the wrapper itself.

Keep the existing evidence distinctions:

- Before-check zero may be inferred only from subsequent sealed compiler control flow, not from a JSON PASS line alone.
- After-check zero is inherited by the sealed normal zero wrapper return, not separately observed native wait evidence.
- The compiler outer-status file, launcher's direct-child status/ECHILD and native wrapper result are distinct.
- Abnormal custody closure is UNKNOWN under option A and stops dependent work. No all-descendant abnormal-path guarantee is added.

The whole-wrapper argv/environment whitelist is unchanged; arbitrary shell functions/startup hooks, loader settings, Node settings and inherited Git overrides cannot be added. The separate checker helper still constructs its own environment and does not inherit dispatcher `GIT_OPTIONAL_LOCKS=0`; the new absence guard covers the default-hook risk rather than pretending that variable reaches it.

Limits remain custody 60/60 seconds, compiler 180 seconds, TERM grace 10 seconds, closeout 210 seconds, and compiler outer 230 seconds plus 10-second kill-after. The 400-second caller threshold is observation/escalation only. Keep the same authoritative native session; it does not authorize a replacement attempt, process-group cleanup or new supervisor.

## 6. Nonblocking documentation precision

`CORRECTION-REPORT.md` says seven ordinary tools, and the preserved dispatch contract says Node and seven declared tools. The actual sealed set is **six non-Node tools plus Node, seven total**. No pin or check is missing: Python, env, timeout, Git, Bash, tail and Node are all represented as before. Treat the source and explicit list as authoritative. This wording discrepancy is not an admission blocker and does not require changing or resealing the otherwise accepted packet.

The embedded older controlling decision also retains its historical authorization wording. The current dispatch/preparation documents and latest parent-supplied authorization supersede only that historical local-testing withdrawal. None of them supersedes an actual access denial or separately required delegation permission.

## 7. Exact next stage and hard stops

**Immediate next step:** retain this sealed accepted successor and report the exact WSL access blocker. Do not dispatch the verifier or wrapper through the denied route. The next dependent action waits for materially relevant evidence of supported access to the intended retained WSL preparation, or an already authorized owner-arranged route that is demonstrably independent of, and does not circumvent, the denied operation. This review does not establish either route and authorizes no access-repair operation.

Once that access prerequisite is actually satisfied, the accepted combined stage is exactly:

1. Confirm the same retained run `p065-c3-local-preparation-20261104T134138Z-2371624`, the actual original directory and `wt-source`; establish the named quiet window and UTC start. Confirm the existing native facility's full capture, wait and timeout contract without a standalone capability probe or replacement supervisor.
2. Verify all combined-02 seals locally. Run the exact admitted verifier once, using the retained real paths and `/usr/bin/python3 -I -S -B`. It must pass original/template/span, source/tool/config/hook, canonical-path and collision gates, then exclusively materialize the four unchanged originals.
3. Require both an observed native zero verifier completion and matching `VERIFIED_AND_MATERIALIZED_NOT_RUN` receipt. A receipt alone, pending result or uncertain termination is insufficient.
4. In the same quiet window, invoke exactly one sealed `run-one.sh 1` with the private binding's argv and the clean whole-wrapper environment. No npm or alternative wrapper is substituted.
5. Retain all native/compiler/custody evidence. After normal completion, review outputs as data: require the specified direct exit 0, lifecycle/closure/postcheck conditions, no failure, `exec_state=no_error_reported`, `compiler_result=exit_status_observed_exec_unverified` and ECHILD. Require complete before/after custody and exact source/tool matches. Reject output symlinks/unexpected types and keep `dist-test` and `packages/hud-mcp/dist` absent. `baseline-dist.json` is provisional.
6. Preserve failed/partial output. Use only the existing authorized private additive evidence-publication route, with independent sanitization, guarded nonforce publication and remote readback. Then stop for evidence review.

Any mismatch, collision, denied operation, nonzero status, signal, timeout, missing/truncated native evidence or uncertain outcome stops the dependent sequence. Do not treat this source acceptance as new retry authority. No stage 2/3, Node 22, broad tests, readiness, performance series, package acceptance, merge or NEXT advancement is admitted. PTRACE, AF_UNIX, physical B20/process-environment restrictions and the cloud Library transport hold remain intact; no GitHub/reconstruction/alternate-executor workaround is released.

A later successful attempt could establish only direct Node 24 TypeScript `dist` compilation on candidate `33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5`, tree `ef8dc07594d5605eeeb94f3e2bac3e81c80e8822`, subject to its actual evidence review.

## 8. Method and limits

This review used read-only archive listings, byte comparisons, text inspection, ordinary checksums, JSON-data inspection, direct span readback, public primary-source reading, and streaming of the already retained Node archive member to a checksum utility. No supplied verifier/program was run, imported, syntax-parsed or tested. No Git command, compiler, project test, mock hook, live facility probe, WSL command or privileged action was run. No source, repository, retained input, environment setting or branch was changed. Only this new standalone review artifact was written.

The WSL denial is parent-supplied current context, not independently replayed evidence. The live originals, hook state, runtime bytes, current source checkout, quiet window and native facility behavior remain unobserved here. Static acceptance is deliberately narrower than execution admission or a successful build claim.
