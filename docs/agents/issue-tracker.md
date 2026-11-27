# Issue tracker: HUD JSON Ticket Store

Implementation tickets for this repo live as typed JSON files in `.hud/tickets/`, owned by `hud_tickets` and HUD hooks. Feature prose (specs, design notes, maps) stays Markdown in `.scratch/`.

## Conventions

- One JSON file per feature: `.hud/tickets/<feature-slug>.json` (committed in Git, at most 64 KiB per feature)
- Feature prose stays Markdown under `.scratch/<feature-slug>/` (e.g. `.scratch/<feature-slug>/spec.md`, `map.md`, notes)
- Canonical ticket IDs are `<feature-slug>/<NN>` (e.g. `ticket-store/05`), numbered from `01`
- Never hand-edit or create Markdown ticket files under `.scratch/*/issues/`; use `hud_tickets`
- Status is stored in each ticket's `status` field (see `triage-labels.md` for the lifecycle values)
- Comments append to the ticket's `comments` array via `hud_tickets({op: "update", ..., comment: "..."})`

## When a skill says "publish to the issue tracker"

For implementation tickets, call `hud_tickets` with no arguments (or `op: "guide"`) for the method. The main session publishes with `op: "add"` and changes status, fields, comments, or ticks acceptance items with `op: "update"`. Specs and wayfinding notes remain separate Markdown files under `.scratch/<feature-slug>/`.

- The main session chooses ordinary slices, order and dependencies within the approved scope.
- `add` and `update` write `.hud/tickets/<feature-slug>.json` directly under the local `tickets` lock without taking the `main-checkout` lease or making a Git commit on their own. The next `hud_land` folds HUD-written ticket files into the landed commit; when nothing lands, call `hud_tickets({op: "commit"})` (or `hud tickets commit`).
- `hud_land` records local tickets as `done` by default; set `owner_try: true` only when the owner must try the result (lands as `ready-for-human`).
- Workers never edit `.hud/tickets/**`; `hud_land` rejects worker diffs that touch `.hud/tickets/**`.

If a project tracks tickets on GitHub and mirrors them with HUD, edit the issues with `gh` and then call `hud_tickets` with `op: "sync"` (which updates git-ignored `.hud/tickets/<slug>.json` and `.scratch/<slug>/spec.md`); never edit mirror files directly.

## When a skill says "fetch the relevant ticket"

Call `hud_tickets({op: "get", ticket: "<feature>/<NN>"})` (or `op: "get", feature: "<feature>"`) for the typed JSON record, or run `hud tickets show <feature>[/<NN>]` to render it as Markdown.

## Wayfinding operations

Used by `/wayfinder`. The **map** stays Markdown while child tickets live in the JSON store.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child tickets**: `.hud/tickets/<effort>.json`, added with `hud_tickets({op: "add", feature: "<effort>", tickets: [...]})`, setting `kind` (`research`/`prototype`/`grilling`/`task`) and `blocked_by`.
- **Blocking**: `blocked_by` lists canonical `<effort>/<NN>` IDs. A ticket is unblocked when every blocker is `done` (or `wontfix`).
- **Frontier**: call `hud_tickets({op: "ready"})` (or `op: "get", feature: "<effort>"`) for tickets that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: `hud_tickets({op: "update", feature: "<effort>", ticket: N, status: "claimed"})` before starting manual work (dispatched HUD jobs claim tickets live without editing the store).
- **Resolve**: call `hud_tickets({op: "update", feature: "<effort>", ticket: N, status: "done", comment: "<answer>"})`, then append a context pointer (gist + ticket ID) to Decisions-so-far in `.scratch/<effort>/map.md`.

## In this repo

- `docs/spec.md` stays the product boundary; a `.scratch/<feature>/spec.md` only elaborates one feature inside it and never contradicts it.
- `.hud/tickets/*.json` and `.scratch/` prose are committed in Git. The repo is public: no keys, no owner data, synthetic examples only.
- Dispatch ticketed work by passing `ticket: "<feature>/<NN>"` to `hud_create` without `brief_file`; HUD renders the worker brief from `.hud/tickets/<feature>.json` and links the job to the ticket and its Objective automatically.
