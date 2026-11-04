# P065-on-C3 local owner preparation: `p065-c3-local-preparation-20261104T134138Z-2371624`

**This round is preparation, not testing.** No build, project test, readiness case, benchmark, launcher, checker or compiler was run. Nothing here is a pass. P065 remains untested on this combination, unaccepted, not performance-qualified and not eligible for integration. NEXT and the other queue limits are unchanged.

## Done

1. **Attachments checked by hash only, none executed.** Proposal ZIP `991c6650…5753`, `PROPOSAL.md` `0508daa6…2e71`, Oracle ruling `f46c6e8f…ecd80`: all equal the values in the task prompt. The prompt file itself carries no declared hash (`61c64540…d4db`).
2. **Fixed source obtained through the normal origin** (`git fetch origin <sha>`, no URL/proxy/permission change) and checked out as a new detached worktree in a fresh run root. Real identity: commit `33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5`, tree `ef8dc07594d5605eeeb94f3e2bac3e81c80e8822`, ordered parents `26096e82…` then `585d1421…`. Detached HEAD, `git status --porcelain --ignored` empty.
3. **Full leaf verification** (`source-identity.json`, `leaf-inventory.json`, `tracked-byte-verification.json`): 1,425 leaves (all blobs; 1,368 mode 100644, 57 mode 100755), equal to the supplied candidate-leaf inventory at every `(path, mode, type, object)`; the 275 supplied dependency leaves are a subset (275 under `node_modules/`); all 1,425 tracked worktree byte streams hash to their blob SHA with 0 mismatches and correct executable bits. `dist`, `dist-test`, `packages/hud-mcp/dist` are genuinely absent. No `npm ci`/install, no lockfile change, no copied generated output.
4. **Tools** (`runtime-tools.json`): Node v24.22.1 `e32e2d16…cfb` is byte-identical to the member of the official tarball (`6c172a9a…95e6`, equal to nodejs.org SHASUMS256); Python 3.12.3, bash 5.2.21, git 2.43.0, coreutils 9.4 identities recorded. They **differ from the historical cloud pins** (Node `61ab14cd…`, Python, env, timeout), as expected for a different host; left for the Oracle. Node 22.23.4 is not prepared.
5. **Facilities** (`facilities-evidence.md`): existing records only. Subreaper prctl and owned-child closure have indirect local evidence; pidfd, readback/ECHILD and custody-check closure are UNKNOWN. No self-test was run.
6. **One local stage-1 proposal** (`local-build-proposal-01/`): launcher, independent checker, wrapper, manifest, full diffs against the reviewed Node 24 stage-1 files, build plan with all future output hashes `null`, exact future command, stop rules, and the custody-check gap with options A/B/C (`optional-successor/custody-kill-after.diff` is **unapplied**). Deltas are paths, tools and seal bindings only; the launcher is byte-identical from `SET_SUBREAPER` onward. Added: pins for git/bash/tail in the checker, and the wrapper accepts stage 1 only.

## Gaps and open items for the Oracle

- Accept the local tool identities (they are not the cloud ones) and choose custody option A, B or C. C is not drafted.
- The custody checks' Git children are outside any closure proof; their closure is UNKNOWN.
- pidfd availability under this WSL2 is UNKNOWN until an admitted execution.
- A sealed executable original does not exist until the Oracle reviews it; the published files are path-redacted renderings, not the executable bytes. Original and published seals are listed separately in `local-build-proposal-01/ORIGINAL-AND-PUBLISHED-SEALS.json`. The private original-form files stay on the local machine.
- The deployment root and the stage-1 evidence root do not exist yet; materialization is a separate admission.

## Stop point

The proposal is complete and the round stops here. **Not run:** the build wrapper and any stage, stage 2/3, Node 22, C/R/I readiness, focused tests, aggregates, performance, PTRACE/AF_UNIX/B20 physical startup, real harness/Herdr/tmux/Jev/statusline/B13_REAL/B14.

## Preparation commands that did execute (for transparency)

`git` read operations and one `git fetch origin <sha>` plus a later `git fetch origin` (tracking refs only; no local branch updated), `git worktree add --detach`, `sha256sum`, `diff`, `unzip` of the attachment into a fresh temp directory (data only), version flags of node/python/git/bash/timeout/env, two Python data scripts (`scripts/source_identity.py`, `scripts/make_local_proposal.py`; the latter read the reviewed files as text), `ast.parse` on the generated Python files, `bash -n` on the wrapper, a stdlib-import check and a `prctl` symbol lookup under `python3 -I -S -B`, and a download of the official Node tarball into a fresh directory with an extract of the one member for hashing and `cmp`.

## Cloud progress observed (fetched at 13:48 UTC 2026-11-04)

The newest remote activity is `dots/p065-c3-prep-docs` `b894df6` (05:18 UTC), the archive of the P065 C3 validation proposal Oracle review (the ruling this round reads). `origin/universal-hud` is `26096e8` (04:23, C3 integration status). `dots/p065-c3-prep` is `33dd1bd`. Nothing newer, and no new authority evidence for the cloud Library delivery block. The owner's local `universal-hud` is 120 commits behind `origin/universal-hud`; it was not updated.

## Publication

See `PUBLISH-RECEIPT` (local, after push). Redaction: see `redaction-manifest.json`.
