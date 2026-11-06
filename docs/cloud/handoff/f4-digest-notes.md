# F4 digest notes source handoff

Base commit: `a1250f07995465b40e29a284a732978894c3e7ee`; base tree: `708eb6a30002ca749ba27d00aadb7d10dcd2265d`.

Implemented the explicit save/show flow described in [the product document](../f4-digest-notes.md). Seven owned paths only: CLI and delegated-digest service additions, the new dedicated note store, two new unit suites and these two documents. No ledger, report reader, source configuration, SmallModel, panel, contracts, build, package or workflow edits. Ordinary run and its delivery callback remain compatible; panel work does not depend on retention.

Round 1 addresses DN-01–DN-05: save guards survive delivery/settlement; publication uncertainty survives failed authorization/cleanup without exposing text; opened descriptors are validated before payload reads; note and source-parent directory entries are fsynced; and the unreleased store is now a source sibling outside the runtime walker. No older layout is migrated or modified. The original reviewed source and evidence remain preserved separately.

Bounded fix round 2 addresses DN-01R1 only: invalidation cleanup now uses the same exclusive writer lock across leaf comparison, unlink and fsync. In-save cleanup reuses its owned lock; post-delivery cleanup reacquires once or preserves uncertainty without deleting. New authored service/CLI interleaving and contention tests target that exact protocol, with no execution claim. Both originally permitted fixes were consumed. The subsequent review found DN-01R2, and the owner explicitly approved exactly one additional bounded round.

The private store preserves complete target metadata and original one-report provenance without storing report text. Show reauthorizes before generated-text reads and never creates model/runtime/telemetry work. Explicit save uses bounded private descriptors, an exclusive non-stealable lock, 200-note capacity and atomic same-directory replacement with readback. Generation and retention are separate results; uncertain output instructs exact show, not run retry. See the product document for interruption, same-UID and cross-restart limitations.

Verification status: source-only implementation. New behavioral suites, existing F4/material/SmallModel regressions, build and formatting are NOT_RUN because compatible authorized local dependencies are absent. Static inventory, hashes, changed-path checks and portable patch verification are independent evidence only, not substitute compilation or tests. Full executable local checklist is in the product document. The base CI result does not certify these new tests.

Round 3 addresses DN-01R2 only: retain the validated original publication descriptor through awaited delivery and bounded settlement, use its non-reusable live inode ownership inside the existing writer-lock cleanup boundary, and close it on every terminal service path. The allocator-model and repeated-disposal regressions are authored, NOT_RUN. Round0, round1 and round2 snapshots and failed reviews are preserved. No lifetime seam or other package is composed here. No round 4 is authorized.

Coordinator owns fresh Oracle source review, recovery archival, exact-tree readback and any newly authorized independent test-branch publication. No refs or commits were created here. Package completion is not integration, release or production acceptance.
