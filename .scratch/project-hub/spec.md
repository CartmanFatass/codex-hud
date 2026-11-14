# Project hub (0.1.3)

Owner 2026-11-14. Elaborates docs/spec.md §2 "Project hub"; the spec wins on any conflict.

## Why

At 40 columns the Project tab shows the ledger only as counts, so the owner cannot see what was done or what is
being done, and has to open STATE.md and the ticket files. One long page mixes six sections and repeats Home.

## What the owner sees

1. **Hub.** `2` (or Tab) opens the hub: an optional "Waiting for you" row (count of STATE's waiting items), then one
   row per page with a one-line summary: Progress (current milestone, try/working counts, the stacked bar),
   Tickets (working · blocked · done/total), Working tree (branch · changed · worktrees), Docs (spec milestone ·
   newest review), Control plane (roles · keys · browser). Enter opens the page; Esc or the `‹` crumb returns to
   the hub. Each page keeps its own cursor and scroll, also across a panel reload.
2. **Progress page.** Bar, legend and milestone chips on top, then four sections:
   - Now: ledger slices in `working`/`blocked` and the project's HUD jobs that have not settled (role, sentence or
     detail, age);
   - Next: STATE's `## Next`, each bullet at most two lines, Enter expands it;
   - To try: ledger `try` rows, newest milestone first, each `ID · milestone · date commit` and its text on a second
     line; milestones other than the newest folded;
   - Done: ledger `accepted` rows grouped by milestone, all groups folded.
   Milestones come from the ledger's second field (`M4`, `0.1.1`), in ledger order. Dates come from the ledger row's
   commit hash (the last 7–40 hex token in the row), read through the safe Git policy, not guessed when absent.
3. **Tickets page.** One row per feature with a done/total meter; Enter opens the feature's tickets (as today);
   Enter on a ticket shows its checklist and latest comment inside the panel; `o` opens the file in the editor.
4. **Working tree, Docs, Control plane** pages: today's sections moved as they are.
5. **Project switch.** The hub's top row names the project. `[` / `]` cycle through the panel's own project and the
   roots in `$HUD_HOME/projects.json` (existing directories only, deduplicated by realpath, at most 16). The choice
   is kept by the panel (reload-safe), not in Settings. Home stays on the panel's own project. A project without
   STATE.md shows "no STATE.md" in Progress; its other pages work.
6. **Home.** Enter on Home's progress block opens the Progress page; on a ticket row, the Tickets page.

7. **Projects list (owner 2026-11-14).** With one project nothing changes. With several, `2` opens the hub of the
   project shown last; its name row reads `name ▾ i/n`; Enter or a click on it opens the Projects list, `[` / `]`
   still cycle. The list has two rows per project: name, current milestone, waiting count (`?`), running HUD jobs
   (`◉`); then the bar, one key count and the last activity. Order: the panel's project first, then waiting, then
   running, then most recent activity. Enter opens that project's hub; Esc or `‹` returns to the list. The list reads
   each project lightly (STATE and tickets by file signature, active jobs from the shared job lookup; no Git, no
   roles); full collection stays for the shown project only. Switching starts at the project's hub. Home is unchanged;
   other projects' questions show only as `?` on the list.

## Out of scope

No model calls, no writes to STATE or tickets, no new settings, no new collectors outside the Project tab, no
change to Home cards, no list of every directory a job ever ran in.

## Rules kept

Full collection only while a Project page is visible (Home reads the cached STATE/ticket parse only); Git at most once
per five seconds per project; exact-width rows; EN/ZH; unicode and text icons; 40, 80 and 120 columns.

## Tickets

01 hub and sub-pages (frontend-implementer) · 02 project data (agy-imp, gemini-4-hydrogen-high), parallel with 01 ·
03 progress page, tickets page and project switch (frontend-implementer), after 01 and 02 · 04 projects list
(frontend-implementer), after 03.
