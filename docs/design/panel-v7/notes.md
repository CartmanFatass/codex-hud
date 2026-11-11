# PANEL-FREE: design notes

## The idea: stems and tracks

The panel is read top to bottom by someone who glances at it between other things, so the design spends its colour on
one question: how much does this need me? Everything is cool slate except what needs attention. There is exactly one
warm field per screen, the amber question slab, and it is always the first thing under the tab bar. Below it the
colour language is small and fixed: amber = needs you / worth a look, orange = stalled, red = failed, blue = running,
green = ready or accepted, lavender = an identifier or a file you can open. Nothing else is coloured.

Structure uses a 2-cell gutter instead of boxes. Column 0 carries the state of a card: a glyph on its title row
(`?` `◷` `✗` `✓` `●` `◆` `◇`), then a heavy stem running down its body. Column 1 is air, text starts at column 2 and
runs to column 54. A card is a lighter title band plus a darker body, joined by the stem, so cards separate by tone
and not by lines or blank rows, and every wrapped line is flush with the one above it (no hanging indent except the
option letters). The owner's "wasted indentation" is answered by the gutter doing real work: it is the state column.

A lane (package) is a name and a small line map: build, review, accept, done, with a lit track up to a white marker
that sits where the package is. On Home it is a 16-cell strip right-aligned on the lane's header row; on Work the same
map is drawn across the pane with the stage names above it. Jobs of that package hang under the header ranked
need, stalled, failed, ready, running. The earlier "cards with lanes" look survives; the lane is now the thing you read
progress from.

## What goes where

- **Home** answers three questions in order: the question that needs me (the whole question, why it is blocked, the
  options, the default as a filled letter chip plus its own line), the lanes with each job's current sentence (a failed
  job shows its whole reason on a red-tinted card), and "Decided for you" (headline, `asked`, and `instead of` only
  when the answer departed from the worker's own default; those rows carry the amber diamond and "worth a look", come
  first and are separated from the routine ones by a blank row). Home shows no model chip.
- **Work** repeats the lanes with the labelled line map and gives every job four things: role and title, vendor mark
  with model, thinking level, harness (and "native"), the phase chain (`build ✓ › review r1 2 major › ▸asking`) and
  the sentence it is on. Results take a tone: major amber, minor dim, accept green.
- **Project** is the same card grammar as a table: what waits for the owner, then roles grouped by file glob with one
  column grammar for all groups, setup (workflow file, instruction files, keys), working tree, docs, tickets. The
  selected row has a lighter band and its file path shows in the footer with the vim glyph; Enter opens it.
- **Expanded decision** is a drill-in from Home: the decision card, then the worker's own question and answer
  verbatim from `qa/q4.md` and `qa/q4.answer.md` in full. A second screen shows the same decision with no model
  (fallback): headline and sentences are the file's first sentences, only identifiers are coloured.
- **Calm** keeps every position the busy day uses and simply has less in it; "Nothing needs you" takes the ask slab's
  place in green. The lower half stays empty on purpose.

## Emphasis

Model-marked key phrases are bold and brighter than the body text (bold white on slate, bold light amber on the amber
slab). Identifiers are lavender and not bold, so they read as "a thing you could open" and never compete with key
phrases. That is the whole vocabulary: no background highlights, no underlines. A paragraph of dim-grey body text
with two or three bold phrases scans well; five would not.

## Checks

`gen/gen.py` asserts every screen row is exactly 56 cells wide (CJK counted as 2) and every screen exactly 64 rows,
and renders each character into its own fixed 10x22 px cell so CJK and glyph fallback cannot drift off the grid.
`gen/check.py` verifies that the question, blocked sentence, options, default, every decision's headline / asked /
instead, every job sentence and failure reason, all steps, and the Project texts are present and whole in the cells of
every screen in both languages (0 missing of 30/4/5/37/43 texts per EN screen and the same for ZH).

## Assumptions to confirm

- `TREE.editing = (PANEL-THIN, imp, 47)` is shown as "imp is editing PANEL-THIN, 47m".
- The ask slab shows `a b answer · ⏎ read` as a proposed interaction; the brief only fixes Enter-opens-in-vim.
- Tab badges: Home = things that need me (amber), Work = jobs alive, Project = things waiting (amber).
- Model names get their vendor prefix (`gpt-6.1-sol`, `deepseek-v4.1-flash`) so they read as the models the owner uses.
- Time reads `4m`, `1h12m` in English and `4分钟`, `1小时12分` in Chinese. Titles, file names, commit subjects and the
  worker's raw question/answer stay as written in both UIs.
- The renders use MesloLGS Nerd Font Mono; CJK falls back to Droid Sans Fallback here, a real terminal's CJK font
  will shape punctuation a little differently. The layout is cell-exact either way.

Regenerate: `python3 gen/gen.py` (writes `final.html`, `gen/pages/*.html`, `gen/screens.txt`), `gen/shoot.sh` (PNG at 2x
into `png/`, private Chrome profile deleted afterwards), `python3 gen/check.py`.
