# 03: Progress page, ticket detail and the project switch

**What to build:** spec items 2, 3 and 5 on top of 01's pages and 02's data. Progress: Now / Next / To try / Done as
the feature spec says, two-line rows at narrow widths, folding per milestone. Tickets: feature meters, ticket
detail (checklist and latest comment) inside the panel, `o` to the editor. Switch: the hub's top row names the
project; `[` / `]` cycle `projectList`; the panel keeps one collector per visited root (at most 4, oldest dropped);
the choice survives reload; Home unchanged. Help, reference (en/zh) and docs/releases/0.1.3.md.

**Who:** frontend-implementer · **Size:** about 400 source lines, project-page tests and frames updated

**Blocked by:** 01, 02

**Status:** resolved

- [x] Progress shows what is in flight, what to try and what was done at 40/80/120 EN/ZH
- [x] Ticket detail shows checklist and comment; `o` opens the file
- [x] Switching projects changes every page; Home stays on the panel's project; a project without STATE.md works
- [x] The choice survives reload; collection only for the shown project

## Comments

- 2026-11-14 orchestrator: implemented by frontend-implementer, landed as 162e8b1c; job-sentences test got the new
  snapshot fields. Full suite green (514). Chips follow the ledger milestones; switching keeps the open page but
  resets cursor/folds; `o` opens the file where Enter folds.
