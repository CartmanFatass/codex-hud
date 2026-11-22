# Statusline workers: the worker zone (design sample)

Owner, 2026-11-22: drop job titles for every role; the bar's worker zone shows only the worker count, the provider mark, a short model name and the thinking-level mark, taking the pi footer as the reference. This is design only: open `sample.html` (static, no script, no network), pick a variant, and a later job builds it. Nothing under `src/`, `bin/`, `packages/` or `tests/` changed; every frame is synthetic (one invented project, invented job titles).

## What the page shows

At 120, 80 and 50 columns, in English and Chinese, a busy scenario (10 workers, 4 groups: 3 imp `gpt sol-fast high`, 2 general `gemini neon high`, 4 sonic `deepseek high`, 1 frontend `sonnet xhigh`; one asking, one failed, one done with an unread report) and a quiet one (one worker running), each as four rows in a dark terminal:

- **Current**: the real `renderBar` (line look, `terminal` theme) fed the same facts the pi footer has, with titles.
- **A**: one group per provider + model + effort: `◎ sol-fast◕ 3`, marks after the count.
- **B**: A with a one-letter role prefix: `i ◎ sol-fast◕ 3`.
- **C**: the narrow order as a layout of its own, never showing the model name: `◎◕3`.

A, B and C are a scratch copy of the bar builder with the notice zone swapped for the roster (not committed; the page is the artifact). A and B walk the ladder from their full form, C starts at its second rung. Every frame's width is asserted at generation: all 48 fit their columns.

## Recommendation: A, narrowing in C's order

A is what was asked for, and four groups take 55 columns, so 120 columns show it whole. B's letter costs 2 columns a group and repeats the model when each role runs one preset. C is A's way down, so keep it as the ladder rather than the only form. Price: at 120 columns A takes the branch marks and the 5h window from the vitals (see C's row); at 80 all three end at provider + count.

## The design in short

- **Group**: provider mark (`providerMark`, catalog colour), short model, effort glyph (`EFFORT_GLYPHS`, inked as `paintEffort`; none for off/none/unknown), count in bold. Groups are joined by two spaces, in the order their oldest worker started.
- **State**: today's glyphs and inks without the `[ ]` box. No mark means working; `!`/`!n` in the bar's alert badge means asking (pinned until answered); `✗` failed; `✓●` finished, report unread; `✓` finished and read, for three minutes. `◐` is not used for working: it would repeat on every group and collides with medium thinking.
- **Ladder** (owner's order): drop the model name, then the effort glyph, leaving provider mark and count; groups regroup at each rung so counts stay true; B drops its letter last; marks never go.
- **zh**: the bar stays English-only and the zone has no words, so zh rows differ only by the session's own text (a CJK project name); today's titles are what made zh wide.

## Short model names

Derived, not tabulated, from `src/models/models-catalog.json` through the existing label code: a catalog family (`classifyModelFamily`) is its id plus the variant `versionedModelLabel` keeps (`sol`, `sol-fast`, `astra`, `terra`, `luna`); else the entry's `shortLabel` or first alias (`opus`, `sonnet`, `fable`) or a digit-free id (`haiku`); else an agy/Gemini codename (`hydrogen`, `argon`, `flash`); else the vendor's catalog tag lower-cased (`ds`, `glm`, `mis`). The page lists the result for every catalog model next to what `shortModel()` returns today.

## For whoever builds it

- `neon`, `carbon` and `gpt-6.2-sol-fast` are not catalog entries yet (the codename and family rules already read them from the id). `ModelEntry.shortLabel` exists and is unused: it is the place for any exception.
- The zone needs a roster, not events: today `workSignals` gives recent starts and settlements (a start event lasts three minutes), so a worker running longer drops out. A census of live workers (role, model id, effort, state) is the input this design assumes; settled workers keep today's three-minute window.
- In `LADDER` (`bar-fields.ts`) the two `title` rungs become the zone's rungs, so the loaded counts, meters, quota reset and branch marks give way first and leftover room goes back to the zone. Moving them earlier favours the zone over those extras at 120 columns.
- B's letter is the role's first letter; roles can collide (`frontend` and `flow`), so B needs a rule if chosen.
- The ambiguous-width glyphs (`◎ ◕ ● ✻ ≋ ▲`) are one column as `visualLength` counts them, as the vitals' marks already are.
- Not designed here: native subagents and skill loads, the Codex native footer's `workReminder`, the other six bar looks, light themes. Frame tests to rework: `bar-layout`, `bar-themes` (with `tests/fixtures/bar-themes.json`), `bar-widths`, `pi-footer`, `thin-job-scan`; the notice rules in `docs/reference.md` and `docs/reference.zh.md`.
