# p10k footer reference captures

`goldens.json` contains exact ANSI rows produced once from the authorised original
p10k-footer extension (source SHA-256 is recorded in the JSON). The capture script
lives in the PI-FOOTER-PORT task directory, not in this public repository.

Inputs are synthetic: a fixed clock, OpenAI provider mark, synthetic model/session,
`~/projects/example`, synthetic git porcelain, one usage record and one TPS record.
The reference used pi-tui's original width helpers and a synthetic stock editor
frame; the actual BandEditor override paints the top rule, spinner, bottom rule
and identity. No provider, git process, personal session or settings file is read.

The owning `pi-footer.test.ts` table exercises the port with the same input, owner
segment switches, defaults, ASCII mark, Nord palette, all distinct narrow fitting
steps, switches off, and complete/partial/unavailable delegation. Delegation text
is passed to the original through its ordinary extension-status seam; the port's
test generates that text through the real passive summary reader/segment. These
are new parity fixtures, not changes to WP0 or existing visual baselines.
