# Brief B10B-S3F: finish B10B segment 3 (re-check and merge)

Tier S. No new implementation unless the re-check asks for it.

## Base

- Branch `cloud/b10b-s3-wip`. It contains `cloud/b10b-s2`, which is already merged into `universal-hud`.
- Create `dots/b10b-s3f` from it and merge `universal-hud` into that branch first. On conflicts, take
  `universal-hud`'s side for anything outside `src/render/**` and the `b10b-s3` tests.

## Binding inputs

- The segment-3 brief: `docs/cloud/B10B-s3.md` on `cloud/b10b-s3-wip`.
- Its rulings: `docs/cloud/rulings/b10b-s3.md`.
- Review 1, findings F1–F8: `docs/cloud/handoff/b10b-s3-review-1.md`.
- The handoff, "To finish this package": `docs/cloud/handoff/b10b-s3.md`.

## Steps

1. The main session runs the full README check set and `B10B_PERF=1` over three runs on the branch, and records the
   raw output. `run-control` is expected to stay red until RUNZ1 is merged; the `ledger_busy` flake family may
   appear.
2. A fresh re-check Oracle reviews F1–F8 against the tree, plus two specific questions:
   - Is the `c-switch` → `b-switch` frame rename right?
   - Is the overflow test gap for `l` on the fifth sub-row closed?
3. At most one fix round, done by an implementer (Astra high), then a fresh re-check.
4. On accept, merge into `universal-hud`. Then update the handoff file's status.

## Ownership

`src/render/**` and the `b10b-s3` tests, as in the segment-3 brief. The dispatcher is TPD1, not this package.
