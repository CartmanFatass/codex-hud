# Brief TPD1: tree-page dispatcher for the delegation actions

Tier M.

## Base

`universal-hud`, after B10B-S3F merges.

B10D (`b10d-worker`, not merged) also changes `src/tree-page.ts`, but only the collector wiring. Keep this package's
edits to the action dispatch and the reconcile calls, so a later merge with B10D stays mechanical.

## Goal

Segment 3 produces typed actions that nothing executes yet. Implement:
- the dispatcher for `delegation-open`, `delegation-log`, `delegation-copy` and `delegation-diagnostic`, and the Switch
  label;
- passing the delegation view model to the three `reconcileMonitor` calls;
- the activity hub's `target` action.

Behaviour is as the segment-3 brief and design §3.7 describe. Resume and Reconcile only show and copy the
`ActionDescriptor.displayCommand` (contract 03; design A4); they never start a control process.

## Binding inputs

- `docs/cloud/B10B-s3.md` and `docs/cloud/rulings/b10b-s3.md`.
- Design §3.7 and §4.11 (the Inspector is B10B-s4, not this package).
- Contract 03, `ActionDescriptor`.

## Acceptance

- Tests drive each action from a key press to its effect, with no real Herdr: the Herdr calls go through the existing
  host interface with a fake.
- Opening a pane in a real Herdr session is local-only. List it in the report for local verification.
- The README check set is green.

## Ownership

`src/tree-page.ts` (dispatch and reconcile calls only), the action types from segment 3 (read-only unless the Oracle
rules otherwise), and the tests `tests/unit/tpd1-*`.
