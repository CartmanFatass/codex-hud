# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

For implementation tickets, call `hud_tickets` with no arguments for the method and template. The main session
publishes with `op: add` and changes status or ticks acceptance items with `op: update`. Specs and wayfinding
notes are separate markdown files under `.scratch/<feature-slug>/`. The main session chooses ordinary slices,
order and dependencies within the approved scope. `hud_land` records local tickets as `done` by default; set
`owner_try: true` (`**Owner try:** yes`) only when the owner must try the result. That lands as `ready-for-human`.

If a project tracks tickets on GitHub and mirrors them into `.scratch/`, edit the issues with `gh` and then call
`hud_tickets` with `op: sync`; never edit the mirror directly.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## In this repo (owner, 2026-11-12)

- `docs/spec.md` stays the product boundary; a `.scratch/<feature>/spec.md` only elaborates one feature inside it and
  never contradicts it.
- `.scratch/` is committed: tickets are project records like `docs/handoff/STATE.md`, and imps in worktrees read them.
  The repo is public: no keys, no owner data, synthetic examples only.
- The feature slug is the work package id in lower case (e.g. `tickets` for TICKETS). STATE.md's `## Slices` ledger
  keeps one line per work package; its tickets live in `.scratch/<slug>/issues/`. A HUD job dispatched for a ticket
  uses `package: <slug>` and names the ticket file in its task, so the Project tab links the two.
