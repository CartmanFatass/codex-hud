# 04: What the owner tries is never cut; a model brief and acceptance steps

**Status:** done (39cce818)
**Blocked by:** none (in parallel with 03; see Comments)

**What to build:** `docs/spec.md` §2.2 (owner, 2026-11-18): opening the to-try slices and the waiting items, the owner
saw only short names, cut even when the panel had empty rows, and could not tell what they were accepting.

- [ ] Whole text: a to-try slice row (Classic's Progress to-try view, Split's hub To try and Progress page) and a
      waiting item show their whole text (ledger line after the ID; STATE's waiting item), wrapped, wherever the panel
      has the rows. Where rows are short, the cursor row keeps its whole text and the others give way first. Split's
      preview of the cursor slice shows its whole text.
- [ ] Model on (the existing master switch, model and call cap; pattern: `src/collectors/job-sentences.ts`,
      `src/collectors/small-model.ts`): per to-try slice, one call makes a short brief (what changed, in plain words,
      at most 2 sentences) and acceptance steps (how to try it, at most 4 short steps), in the panel's language, from
      its ledger line, the subjects and bodies of commits named in it (at most 5) and the ticket files under a
      `.scratch/<slug>/` it names (capped). Cached per slice by a hash of those inputs, so an unchanged slice costs no
      call. Shown in Split's preview of the cursor slice and in Classic when the to-try row is expanded (Enter), above
      the original text; a pending or failed call shows the original text only.
- [ ] Model off: the original text, whole, as above. No call.
- [ ] Tests: frame tests at 40 columns that a long to-try line and a long waiting item wrap instead of being cut
      (Classic and Split); one that a cached brief and steps render in Split's preview and Classic's expanded row; one
      that the model off makes no call. Synthetic data only.

## Comments

- Main session, 2026-11-18: runs in parallel with 03. Seam: 04 owns the row text, wrapping and preview content and a
  new collector module for the brief; 03 owns key handling, the marks state and glyph, and deletes Inbox (do not edit
  `src/render/inbox-*.ts`; they are going). The main session merges both.
