# 02: The project collector supplies ledger history, live jobs, ticket detail and the project list

**What to build:** data only, in `src/collectors/project-board.ts` (and `src/roles/projects.ts` for the list); no
rendering. `ProjectSnapshot` gains:
- `ledger: { id, state, milestone, text, commit?, at? }[]` for every `## Slices` row in file order; `commit` is the
  last 7–40 hex token in the row; `at` (ms) from one batched `git log --no-walk --format=%h%x00%ct` through the
  existing safe Git path and five-second gate, only on full collection; unknown hashes get no `at`;
- `active: { jobId, role, state, package?, title?, at?, asking }[]`: HUD jobs from the existing newest-64 lookup whose
  cwd is inside the project root and whose state has not settled;
- per ticket `items: { done: boolean, text: string }[]` (its checklist) and `comment?: string` (the last bullet under
  `## Comments`, whitespace-joined, at most 600 characters);
- `projectList(hudHome, panelRoot): { root, name }[]`: panel root first, then `projects.json` roots that exist,
  realpath-deduplicated, at most 16; missing or bad file → only the panel root.
The collector already takes a cwd; keep it usable for any listed root. Today's fields stay as they are.

**Who:** agy-imp (gemini-4-hydrogen-high) · **Size:** about 200 source lines; tests in a new
`tests/unit/project-data.test.mjs` (do not edit project-page.test.mjs or the frames: 01 owns them)

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Ledger rows with milestone, commit and date on a synthetic git repo; a row without a hash has no date
- [ ] Active jobs: only unsettled jobs under the root; settled and other-root jobs excluded
- [ ] Ticket items and latest comment parsed; no comment section → no `comment`
- [ ] projectList: order, dedupe, missing dirs dropped, bad file tolerated
- [ ] Home-mode collection reads nothing new; Git still gated
