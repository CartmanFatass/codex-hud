# RUNZ1 ruling: scope-proof README correction

## Decision

Authorize and require the narrow correction in RUNZ1 itself. Do not defer it to another documentation package.

`src/core/run/README.md` contains two stale descriptions: the general scope-proof paragraph at lines 79–82 and the visible-mode paragraph at lines 192–198. Correcting only line 197 would leave the general description contradicting RUNZ1.

This is an explicit exception to RUNZ1’s file ownership, limited to those two paragraphs. No wider README cleanup or unrelated documentation changes are authorized.

## Reason

Contract 04, line 73, already permits trusted, complete zombie-only scope proof. RUNZ1 adds corroboration for own-session scopes while preserving conservative handling of shared-session visible scopes. Documentation should describe that distinction without suggesting either that `proveGroupGone` is unchanged or that every completion path requires ESRCH.

The working implementation has the relevant distinction:

- `process.ts` retains the kernel-group-absence path.
- `process-census.ts:145–154` limits the additional path to SID = PGID = recorded leader PID.
- `process-census.ts:157–181` requires visibility, complete censuses, full process-identity corroboration and terminal task checks.
- The visible real-process test retains `uncertain` and the slot while the zombie-held PGID exists, then accepts ESRCH without requiring the shared terminal session to end.

This consultation is not an acceptance review of that implementation.

## Exact permitted replacement

Replace the general paragraph beginning “A /proc enumeration is partial evidence” with:

> A single /proc enumeration is partial evidence. R/Q still requires the original harness to have terminated, all launchers to be terminated or sealed against further submission, and the submission channel to be permanently sealed. `proveGroupGone` retains the kernel-group-absence path. For a headless scope that owns its session (SID = PGID = recorded leader PID), RUNZ1 also permits zombie-only completion through two complete, same-domain procfs censuses with full-stamp corroboration and no live tasks in the recorded session. The second census must introduce no new or reused process identities; remaining session members must match first-census terminal stamps. Missing visibility or inconclusive corroboration stays unknown. Helpers cannot be excluded from an active scope to fabricate completion. No periodic group enumeration is added.

In the visible-mode paragraph, replace the text beginning “Z-only groups remain conservative” through “ahead of the original writer’s R” with:

> Visible scopes share the terminal’s session, so their zombie-only groups remain unknown and keep the slot until kernel group absence is proved. RUNZ1’s corroborated zombie-only path applies only to scopes that own their session. The existing ESRCH path does not require the shared terminal session itself to end. The startup observation cannot release the slot as Q ahead of the original writer’s R.

Normal local line wrapping is permitted; preserve surrounding content.

## Impact and acceptance

- **Ownership:** Adds only these two README corrections to RUNZ1.
- **Contract:** No change to Contract 04 or the R/Q requirements.
- **Gates:** No relaxation or new gate. Existing RUNZ1 tests, full checks and performance evidence remain required.
- **Supported profiles:** No change or capability promotion.
- **Other behavior:** No visible-control changes, polling, new timer, schema change or expanded managed scope.
- **Review:** Include the README in the changed-file report. Final review must verify both paragraphs match the accepted implementation and the recorded visible-scope ruling.
- **Workflow:** Record this ownership exception with the package ruling. Existing no-main, no-force-push and no-local-only restrictions remain.

No edits or tests were performed in this read-only consultation. No blocker remains for the narrow documentation correction.