# Explicit retained delegation digests

This source-only package adds explicit retention to the existing exact-target F4 digest command. It does not certify a provider, change report eligibility or enable background generation. Base: `a1250f07995465b40e29a284a732978894c3e7ee`.

## Use

Use the existing plan to inspect the current report and recipient:

```sh
hud digest plan --run synthetic-run --report synthetic-report --json
hud digest run --run synthetic-run --report synthetic-report --expected-ledger LEDGER_ID --expected-recipient RECIPIENT_ID --save --json
hud digest show --run synthetic-run --report synthetic-report --expected-ledger LEDGER_ID --expected-recipient RECIPIENT_ID --json
```

Replace the expected identifiers with those from the plan. `--save` is valid only on run. It does not grant material or outbound permission. The user must already have a valid private per-source model configuration, exact delegated/result/digest scope, matching recipient grant and any required credential. No command edits those permissions.

Without `--save`, run returns the existing `hud-delegated-digest` JSON and never touches the note store. With `--save`, the closed `hud-delegated-digest-save` version-1 wrapper contains `document` (the unchanged ordinary digest) and `retention`:

- `{state:"saved",noteId:"…"}` means this invocation observed a durable, exact readback under its current authority.
- `{state:"not_saved",reason:"…"}` means generation succeeded but retention did not. Fixed reasons are `digest_note_busy`, `digest_note_capacity`, `digest_note_unsafe`, `digest_note_write_failed`, `digest_note_publish_uncertain` and `digest_note_authorization_changed`.

Successful generation with `not_saved` exits zero and still returns the digest. Do not automatically run again: that could make another billable call. For `digest_note_publish_uncertain`, use the exact `show` command to determine what is readable. An older previously saved note can remain after an interrupted replacement; compare its original `generatedAt` and content rather than assuming it is the attempted replacement.

If publication may have occurred but authority is lost and durable removal cannot be established, the CLI withholds the digest, exits 6 and prints `digest_note_publish_uncertain_use_show`. This preserves uncertainty even when no saved receipt or output callback was reached. Check the exact target with show only under current valid permissions; never automatically repeat run.

If output fails after save while authority remains valid, the CLI exits 1 with `digest_note_delivery_uncertain_use_show`. It does not rerun. A broken output sink may have received part or all of the JSON. Readback is the supported recovery, not a new generation request. Other generation errors retain the existing F4 fixed-code/exit behavior and write no note.

Show returns `hud-delegated-digest-note` version 1, explicitly labelled `model_generated`, with `noteId`, `storedAt`, the ordinary `document` and `provenance:{runSeq,generation,acceptedSeq,acceptedAt}`. The ordinary document keeps its original generation time, original cache flag and exact ref/ledger/link/run/report/recipient/model/language identifiers. Stored time is the save time, not a new generation or read time. Neither JSON contains raw material, prompts, the private envelope, account paths or credentials. Model interpretation never proves task correctness, identity, lifecycle state or permission to execute a command.

## Read and retention boundaries

Show opens current report metadata through the existing read-only adapter. The existing latest/current/report eligibility predicates remain unchanged. Closed, historical or superseded targets that adapter refuses remain refused. It then captures current source permissions and recipient, checks feature/scope/grant/credential gates, and builds the current single-report envelope through `buildMaterials` before opening generated note bytes. Stored provenance must exactly match the current envelope's original refs, origins, fields, record/content fingerprints, scope/policy revisions, coverage, recipient and cache domain. Full source configuration and complete original report metadata are retained as private provenance. Only hashes of material text are retained here; the separate existing generic model cache is unchanged.

Show reads only the deterministic exact note path. It does not enumerate notes, initialize directories, instantiate SmallModel, call fetch or a CLI backend, reserve budget, enqueue telemetry, modify policies or write files. Missing/malformed/unsafe notes return `digest_note_unavailable`. Denied current authority keeps the existing F4 refusal codes. A changed source, report content, run/report selection, recipient/account/model/language, scope/policy revision or missing credential prevents reuse. Nothing regenerates automatically.

The service revalidates current material content, target, source authority and note inode at output. Within each invocation, any observed invalidation remains latched even if permission bytes are restored. This is not cross-restart account attestation or anti-rollback: a fresh invocation cannot detect a permission change and restoration that B17 never observed. Hashes detect inconsistency; they are not signatures against a same-UID actor capable of rewriting the entire private store and its hashes.

## Private storage and interruption

Files live at `sources/<sourceId>/digest-notes-v1`, a sibling of `model-runtime-v1` under the selected private source directory. This new, unreleased layout is outside the inherited runtime walker: ordinary no-save runs never inspect or enumerate it, and explicit save reaches only the bounded note iterator. No old-layout data is migrated, imported, deleted or repaired. The new store requires same-UID real directories exactly 0700 and regular, single-linked files exactly 0600. Existing unsafe paths are refused, not chmod-repaired. Before any payload read, the opened descriptor itself must be a regular same-UID/eUID, exact-0600, single-linked bounded file; earlier path checks alone are insufficient. Files use bounded no-follow/nonblocking descriptors, inode/size/time identity checks and a maximum size of 256 KiB. The deterministic filename binds complete target metadata, recipient, model and language. It never uses a bare session ID, a panel row or a user-selected path.

Only explicit save creates the notes directory. A private exclusive `.write-lock` serializes saves. One bounded directory iteration admits at most 200 note files; exact identity replacement is allowed at capacity. A new identity at capacity is refused, with no older note eviction. Unknown entries fail closed. A write uses one exclusive 0600 same-directory temporary, file fsync, atomic rename, pinned-descriptor notes-directory fsync, pinned-descriptor source-parent fsync, exact readback and current-authority verification. Both directory barriers precede a saved receipt, including the first save. The note no longer depends on a newly created model-runtime directory entry. A failure after potential publication is uncertain, not durable success. Its synchronous admission checks include the original monotonic invocation deadline. There is no automatic retry, stale-lock stealing, timer-driven recovery, daemon or expiry-based resurrection.

The saved guard remains live through awaited delivery and bounded settlement, with the original target/source/deadline checks. Abort, timeout or observed source/target drift during that interval invalidates the guard; restoration after that observation cannot revive it. Pure output-sink loss does not revoke a valid note.

Normal completion removes only this invocation's temporary and lock by pinned inode. Crash leftovers remain private and may block future saves until the user inspects and removes their own interrupted lock/temp after proving no writer is active. Show ignores locks and does not clean anything. Before rename, interruption preserves the previous complete note; after rename, it may leave the exact new complete note. Failures around publish are uncertain rather than retry-safe. An observed invalidation after publish attempts to remove only the just-published inode in the original pinned directories, never another writer's replacement, and fsyncs its parent before treating removal as durable. The complete cleanup leaf-identity check, unlink and directory fsync are serialized by the same exclusive writer lock as publication. Cleanup inside the save critical section reuses only its still-owned live lock. After that lock is released, cleanup makes exactly one exclusive acquisition attempt, rechecks safe directories/lock ownership and the original leaf identity while holding the lock, and never waits, retries or steals a peer/stale lock. Contention or unverifiable ownership leaves the note untouched and preserves publication uncertainty. This prevents a cooperating save process from replacing the leaf between cleanup comparison and unlink. The exact validated temporary descriptor is retained across rename, delivery and bounded settlement, so its inode cannot be recycled by later compliant replacements. Cleanup compares only metadata from that still-owned descriptor, requiring its original regular-file identity, owner, mode, size and single link before touching the current leaf. If a peer already unlinked the original inode, cleanup refuses deletion and preserves uncertainty. It never reads payload after revocation. An idempotent internal disposal closes the publication descriptor after the final settlement check on every terminal service path, including output loss, cancellation and failed cleanup; pre-publication failures close their unused descriptor before returning. If deletion, identity or durability cannot be established, an independent publication-uncertainty status survives service failure to the CLI, without unauthorized text. Current authorization still blocks show. Publication and stdout delivery are not a single transaction.

## Additive service interface

`DigestInput`, `DigestDocument`, plan and `runDelegatedDigest(input, options, deliver?)` are unchanged. `DigestOptions.save?: boolean` defaults false; `onRetention?: (receipt: DigestRetention) => void` reports only the separate retention result on explicit save. Existing third callbacks continue receiving only `DigestDocument`. `showDelegatedDigest(input with expectedLedger/expectedRecipient, {signal?,onQuery?}, deliver?)` returns `StoredDigestDocument`. The panel package consumes only the pre-existing plan/run API.

## User-local finite verification checklist

This environment has no compatible local TypeScript, Prettier or runtime dependencies. The two new suites and existing F4 suites were **NOT_RUN** here. Static/hash/patch checks do not establish compilation or behavior. The base's natural CI success did not execute its four F4 behavior suites and cannot certify these changes. No package installation retry, borrowed modules, replacement compiler, source transforms, remote compiled output or workflow changes were used.

With the normal repository dependencies on supported Node 22.13+ or Node 24:

```sh
npm run build
npm run build:test
npm run build:hud-mcp
node --test dist-test/tests/unit/digest-notes.test.js dist-test/tests/unit/digest-notes-cli.test.js dist-test/tests/unit/delegated-report-read.test.js dist-test/tests/unit/source-model-config.test.js dist-test/tests/unit/delegated-digest.test.js dist-test/tests/unit/digest-cli.test.js dist-test/tests/unit/materials.test.js dist-test/tests/unit/small-model.test.js
npm run format:check
npm run check:fixtures
git diff --check
```

Both new suites use private temporary synthetic SQLite/source fixtures and fake transport. Their installed-CLI case invokes the real `bin/hud` in separate save/show processes with a disposable synthetic HOME/HUD_HOME, checks exactly one fake send, then revokes and checks show refusal. Round-2 regressions place a real compiled peer CLI at the exact final-check/unlink boundary and require its save to observe the held writer lock. Separate service and CLI lock-contention cases require one cleanup acquisition attempt, surviving original/peer inode and bytes, exact uncertainty reporting and read-only reopening; the pre-check replacement case remains. These concurrency regressions are authored but NOT_RUN here. Round-1 regressions add deferred-delivery/settlement invalidation, failed post-publish cleanup and redacted CLI uncertainty, descriptor permission/link races with zero reads, first-save/replacement parent-fsync order and late failure, populated no-save isolation, and bounded oversized-store iteration. These are authored tests, not executed crash or behavior evidence. The storage suite also snapshots the complete runtime bytes around show, tests grants before note/summary reads, mutation/inode/path refusal, deferred cancellation, uncertain publish, lock and capacity. `mkfifo` is needed for the finite FIFO refusal case. Run these before making any acceptance claim. Real provider/backend and native-platform qualification are separate and not prerequisites to these synthetic checks.

## Owner-authorized round 3: publication generation ownership

The owner explicitly approved one additional bounded correction after the two original fix rounds. DN-01R2 identified reusable device/inode numbers after A released its descriptor and compliant B/C saves replaced its note. Round 3 keeps the original descriptor pinned instead of relying on a long-lived numeric identity alone. It does not change the save/show format or public CLI. Earlier failed reviews remain part of the history; this is not source acceptance or a budget reset.

New synthetic tests model identifier reuse only when A has neither a link nor an open descriptor, complete real service A/B/C saves with distinct stored bytes, and require late A cancellation to preserve C, report exit-6 uncertainty and reopen without generation. They also check no payload reads after revocation, an unlinked A inode pinned during deferred delivery, and descriptor release after repeated success, output loss, source revocation, cancellation, cleanup contention and pre-publication write failure. These tests are authored and NOT_RUN. In the local checklist above, run both notes suites after the normal build and include these named cases before making any acceptance claim. If the fresh independent review finds another required correction, stop for the owner rather than starting round 4.
