# Brief DOC2: write the B10B-s2/s3 rulings into the design doc

Tier S, docs only.

## Base

`universal-hud`. Do it after B10B-S3F merges, so the s3 rulings are on the base.

In remote phases the owner delegated frontend design to the Oracle, so these rulings are binding. This package only
records them in `docs/design/hud-information-design.md`, in the doc's own language and style. A ruling that changes a
gate or a contract is not recorded: it becomes an owner question instead.

## Inputs

- `docs/cloud/rulings/b10b-s2.md`:
  - Q3, the delegation line grammar;
  - Q4, the summary row's drop order and the `2▸ 1✗ 1✓` count;
  - Q10, always drawing a root card;
  - Q2, omitting lines the data cannot fill.
- `docs/cloud/rulings/b10b-s3.md`:
  - §3.7's Log row means headless, active or ended;
  - §2's "trouble" means §3.2's first bucket;
  - "⇢ 只有 Reconcile" in §3.3 and §4.8;
  - §4.13's bar sample.
- Run-2 summary items 7 and 8 (`docs/cloud/handoff/run-2.md`):
  - B10B-s2's `factsEqual` uses `new Function`;
  - the cold tick is not gated.

  The design Oracle rules on both first. Gating the cold tick changes design §6, so if the Oracle recommends it, it
  becomes an owner question.

## Acceptance

- Each amendment is marked like the existing ones, for example `（B10b-s2 裁决 2026-11-03）`.
- No other text changes.
- `npm run format:check` and `npm run check:fixtures` pass.
- The review Oracle checks each edit against its ruling.
