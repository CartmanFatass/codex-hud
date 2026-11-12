# claude-hud parity fixtures

`fixture.ts` constructs synthetic stdin, transcripts, user/project settings, skills, todos, agents and (for dirty-git)
a diverged local repository with no remote or network access, for the statusline collector tests. `OWNER_CONFIG` is the
compact configuration the statusline reads from `config.json`. No real transcript or account configuration was copied.

The text goldens of the installed claude-hud 0.8.0 layout are gone: since BAR-UNIFY the statusline draws one line in
the Codex bar's grammar (`src/render/layout/bar-fields.ts`), and its render test builds synthetic evidence directly.

`wrapper.txt` is the audited owner width/newest-plugin/tee grammar, with the Node executable replaced by
`/synthetic/bin/node`; `$HOME` is literal and only expanded into a synthetic absolute forward argv during explicit
import. It is **never run**. See `docs/statusline/feature-coverage.md` for bounds and explicit import/activation, and
`THIRD_PARTY_NOTICES.md` for MIT attribution.
