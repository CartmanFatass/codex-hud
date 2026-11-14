# 04: A projects list above the hub when there are several projects

**What to build:** feature spec item 7: the hub's name row `name ▾ i/n` opens a Projects list (two rows per project,
ordered panel project → waiting → running → recent), Enter opens that project's hub, Esc/`‹` returns; `2` opens the
last shown project's hub; one project shows no list. A light per-project overview in the collector (STATE, tickets,
active job count; signature-cached; no Git, no roles); full collection only for the shown project. EN/ZH, 40/80/120.

**Who:** frontend-implementer · **Size:** about 250 source lines, frames regenerated

**Blocked by:** 03

**Status:** resolved

- [x] Several projects: list rows with milestone, `?` waiting, `◉` running, bar, last activity; order as specified
- [x] One project: no list, nothing changes
- [x] Enter/Esc/`‹` and `2` behave as specified through real input; choice survives reload
- [x] The list collection reads no Git and re-reads only changed files

## Comments

- 2026-11-14 orchestrator: implemented by frontend-implementer, landed as a20019d4. Last activity is the newer of
  STATE.md and the newest ticket file (ledger dates need Git); Esc on a hub opens the list only when the hub was
  opened from it, so Esc still hands keys back in an embedded panel. Full suite green (527), release rehearsal passes.
