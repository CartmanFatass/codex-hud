# claude-hud 0.8.0 parity goldens

These eight text files are **captured stdout**, with SGR ANSI removed, from the
installed MIT claude-hud **0.8.0** build. They are not outputs of the HUD renderer.
The reference source was audited at its `v0.8.0` tag. No real transcript or account
configuration was copied: `fixture.ts` constructs synthetic stdin/transcripts,
user/project settings, skills, todos, agents and (for dirty-git) a diverged local
repository with no remote or network access. `OWNER_CONFIG` is the brief's listed
compact configuration; the rest use upstream defaults.

After `npm run build:test`, the capture command was:

```sh
node tests/fixtures/claude-hud-parity/generate.mjs --installed /absolute/claude-hud/0.8.0/dist/index.js
```

Each scenario ran the installed entrypoint once. The generator creates and removes
a separate temporary HOME/HUD_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR per scenario, passes
only an isolated environment (no HERDR variables or credentials), copies the synthetic
owner configuration into that temporary plugin config path, and preloads a fixed
`Date` (`2026-01-02T12:00:00Z`). Widths are effective widths, 120 except narrow=36.
No plugin discovery, install script, real config mutation, API or credentials were used.

`wrapper.txt` is the audited owner width/newest-plugin/tee grammar, with the Node
executable replaced by `/synthetic/bin/node`; `$HOME` is literal and only expanded
into a synthetic absolute forward argv during explicit import. It is **never run**.

The B16 table compares ANSI-stripped text exactly for idle, running agents/todos,
dirty-ahead-behind Git, counts/skills, narrow, sparse, quota-critical and completed.
There are no intended text differences in those rows. Other documented differences:
HUD delegation/Work lines are additive; bounded head/tail catch-up can temporarily
omit historical activity; hostile control characters and oversized/unsafe sources
are sanitized or refused. See `docs/statusline/feature-coverage.md` for bounds and
explicit import/activation, and `THIRD_PARTY_NOTICES.md` for MIT attribution.
