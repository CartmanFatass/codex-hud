Verdict: changes-required

Reviewed `26d8adcb..cc2c38cf` against the review brief, `docs/spec.md` §§2, 2.1, 2.2, 4 and the M3b/M4 roadmap, `docs/delegation.md` step 5, and `docs/ARCHITECTURE.md`. Two normal-use keyboard regressions block acceptance. The Optional items do not affect the verdict.

## Axis 1 — Spec / scope

### 1. Project has no Codex prefix shortcut despite the documented `Ctrl+\`, then `2`

**Severity: major** — `bin/codex-hud-keys:68–70`; `src/utils/panel-command.ts:22–24,55–57`.

With the embedded Codex panel open and the main pane retaining keyboard input, press `Ctrl+\`, then `2` to open Project, as documented in `docs/reference.md:308–311`. Nothing switches: the prefix table jumps from `1` to `3`, and the command vocabulary/mapping also lacks `pane-2`. The new raw `2 → project-tab` decoder mapping only helps when the panel owns ordinary keys; it does not repair the prefix path. The shortcut also cannot open a closed panel directly on Project.

**Smallest fix:** restore the prefix binding for `2` and the `pane-2` command, mapping it to `project-tab`, not the retired Work view.

Otherwise, the reviewed implementation follows the stated convergence: Home/Work are combined; the retired views and their main producers are removed; native Codex/Claude descendants use Home lanes and the shared sentence service; Project is passive and collected only while shown; Settings and the kept pages use the shared presentation; and the pi launch switches remain argv-based, recorded and observable. I found no actionable scope creep.

The Codex Stacked-to-Line fallback is **not** a finding. The orchestrator explicitly confirmed that retaining Codex's fixed-one-row pane policy was approved during BAR-THEMES-BUILD; `docs/reference.md` documents that exception.

## Axis 2 — Simplicity, quality and cost

### 2. Settings silently drops its advertised Save and Test API keys

**Severity: major** — `src/utils/workbench-input.ts:17–45` (consumers: `src/render/settings-page.ts:335–338`).

Open Settings, change Bar style, and press the displayed `s save`: the draft is not applied. Select a Models row and press `t test`: no API test starts. The cleanup removed `s: 'sort'` and `t: 'next-tab'` from the decoder, but Settings still recognizes only those semantic names for Save/Test. Neither workboard-profile override restores them. In standalone mode the decoder emits no input; in embedded mode it emits an unnamed key, which Settings ignores. Mouse actions and the Esc confirmation provide alternate saving paths, but the advertised keyboard controls are broken.

**Smallest fix:** restore the two decoder mappings while Settings still consumes those names, or introduce explicit Save/Test key names and update their Settings consumers together. Removing the retired sorting/timeline actions does not require removing these retained overlay shortcuts.

The static cost review found the intended lightweight `hud_read` polling path, removal of statusline admin/credential work, settled-job filtering, cached bounded Claude discovery/tails, Project's retained snapshots and five-second git gate, and positive-evidence-only idle backoff. I found no additional blocking cost violation. This is a source assessment, not a fresh performance qualification.

## Optional — Does not affect the verdict

### 3. Decision-title validation permits four marks rather than two

**Severity: minor, follow-up** — `src/utils/keyword-marks.ts:20–31`; applied at `src/collectors/decision-titles.ts:77`.

A model reply such as `«+Accept» «design» «today»` is accepted and persisted with three coloured spans. `markedTitle()` limits visible words but inherits the sentence parser's four-mark limit; only the prompt asks for two. Thus a slightly noncompliant response exceeds the CARD-DETAILS decision-title limit. This is display-only and does not block this re-check.

**Smallest fix:** preserve at most two marked spans when constructing a decision title, leaving additional words as plain text.

### 4. Removed native execution controls leave unused action-boundary helpers

**Severity: minor, follow-up** — `src/tree-page.ts:360–372`.

`panelActionAllowed()` and `dispatchPanelAction()` have no remaining source or test callers, although their comments still claim every keyboard/mouse switch or legacy action passes through them. With native session switching deliberately removed, these helpers provide no live protection or functionality and misleadingly describe the current dispatch path.

**Smallest fix:** delete the two unused exports and their obsolete comments; do not add replacement execution plumbing.

## Verified

- Read the scoped milestone diff, changed/untracked-file status, repository guidance, binding review documents, relevant implementation call paths, and synthetic test sources. The worktree is clean; there are no untracked files to review.
- Traced the previous review's ordinary-card expansion and per-settlement final-sentence fixes. Expanded cards now use the full sentence/factual detail path, and final-sentence freezing distinguishes settlements rather than permanently freezing a job id.
- Checked native projection, parent/depth presentation, retained done/failed/stopped visibility, master-switch application, transcript opening, Inspector facts, and Claude pane binding. Checked Project's STATE ledger/drift presentation, docs/control-plane inventory and read-only collection.
- Checked model-file material collection, keyword rendering/fallbacks, decision-title generation, pi argument validation/dispatch, MCP lightweight polling, panel lifecycle and focused editor-tab opening. The findings above come from tracing the live input paths, not from assuming the rendered hints are functional.
- Read the native-tree, Project, retained-pages, card-details and bar-theme tests without executing them. They exercise real collectors/renderers with synthetic boundaries. The retained-pages Settings test saves through `saveSettings()` or the mouse handler, and Project navigation tests use raw `2`; those paths do not cover the two broken keyboard routes above.
- Read-only commands included `git diff 26d8adcb..HEAD -- src bin integrations packages docs`, `git log`, `git show`, source/reference searches, and `git status --short`. Final `git diff --check 26d8adcb..HEAD -- src bin integrations packages docs` returned **exit=0**, with no diagnostics. Final `git status --short` produced no output; reviewed HEAD is **cc2c38cf**.
- No repository files were changed. No builds, tests, real provider calls, Herdr/tmux probes or owner runtime-data reads were performed. The brief's **48 unit + 124 mjs passed** result is supplied evidence, not independently rerun or verified from fresh check logs here.

Report: `the job report` — 2 major findings, 2 optional minor follow-ups.
