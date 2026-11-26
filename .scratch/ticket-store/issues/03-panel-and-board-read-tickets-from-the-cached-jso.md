# 03: Panel and board read tickets from the cached JSON store

**Status:** ready-for-human
**Owner try:** yes
**Live try:** Open the panel on MyHUD: Project/Feature pages show all features (no partial marker), Execution's workflow diagram shows ticket titles and blocker waves, and `o` on a ticket row opens its feature JSON.
**Blocked by:** 01, nav-redesign/07, nav-redesign/09
**Objective:** ticket-store

**What to build:** Design: docs/design/ticket-store/README.md §4. One stat-signature-cached reader in the collector layer (≤ 256 `.hud/tickets/*.json`, 64 KiB each, re-parse only changed files, nothing on the paint path, `.scratch` fallback per unmigrated feature). Switch `project-board.ts` ticket scan, `ticket-rollup.ts`, `ticket-evidence.ts`, `ticket-title.ts`, `execution-runs.ts` and `hud board` to it. Use `landing.at` instead of the `git log --patch` mining; give Execution titles and `blocked_by` edges for the waves in docs/design/tab-roles/README.md §3. `o` opens `.hud/tickets/<feature>.json` in `$EDITOR`. Add `hud tickets show <feature>[/<NN>]` printing Markdown via `renderTicketBrief()`.

- [x] A project with more than 64 features shows all of them without partial (up to 256)
- [x] A warm collector pass does no ticket file reads (test counts reads)
- [x] Recently landed uses `landing.at` with no git subprocess
- [x] Execution's workflow diagram gets titles and blocker waves for queued tickets
- [x] `o` opens the feature JSON; `hud tickets show` prints a ticket and a feature as Markdown

## Comments

- Landed in this commit (replay base 3d330f8880fb5061881edaaaded961a3f64338a0); gate 5/5 passed.
