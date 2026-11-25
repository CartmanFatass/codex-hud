# 01: Work outside any Objective stays visible on Home and Project, and new tickets get linked

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Observed 2026-11-25 (owner): Home and Project kept showing finished Objectives while current work (features workflow, pi-worker, batch, council, advisor) was invisible, because none of those features was linked to an Objective in `.hud/objectives.md`; the panel only shows tickets through Objectives. Spec §2.2 Project/§4: never invent a clean state; the owner must see what each project is doing. Two parts, one slice. (1) Display: when a project has an Objective record, features with unfinished tickets (not done/wontfix) or live jobs that no Objective lists appear as one compact row under the Objectives on Home (e.g. `未归入目标: workflow 1/7 · pi-worker 1/5`, EN/ZH via t()) and as a short section in Project; the row folds first when space is short, after optional fields. Observed facts only: no generated titles. (2) Protocol (MCP owns protocol): `hud_tickets` op add without `objective`, in a project whose `.hud/objectives.md` exists and whose feature is in no Objective's Features, still adds the tickets but returns a `warning` naming the feature and the existing Objective IDs, and the convention line for new tickets says to pass `objective`. Out of scope: auto-linking, changing Objective file syntax, ticket format. Size: ~120 source lines, 3-4 tests.

- [x] Home shows one unlinked-work row with feature slugs and done/total counts for a project whose Objectives list none of its open features; the row is absent when all open features are linked
- [x] Project shows the same features in a short unlinked section
- [x] The row folds before Objective rows on short heights and keeps exact width in EN and ZH
- [x] hud_tickets add without objective returns a warning naming the unlinked feature and the existing Objective IDs when .hud/objectives.md exists; no warning when objective is passed or no Objective file exists
- [x] Live try: open the panel on MyHUD after unlinking a feature in a HUD home copy and see the row
- [x] Land gate passes

## Comments


- 2026-11-25 main (addendum before land): one call must link. (a) A top-level `objective` on `hud_tickets` op add
  applies to every draft that has none (today it is silently ignored). (b) When a ticket is added with an `objective`,
  the feature slug is appended to that Objective's `Features` in `.hud/objectives.md` (same writer as `hud_objective`;
  unknown Objective ID → error, nothing written), so the panel and the ticket agree and the warning stays only for the
  no-objective case. Explicit link, not inference.

- Landed in this commit (replay base 825b98b57bfc9b27bb06383d212a0ab11f16b9ee); gate 5/5 passed.
