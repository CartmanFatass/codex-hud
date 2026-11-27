# Ticket method

Adapted from mattpocock/skills `skills/engineering/to-tickets` @5863806 (MIT). Owned here; not tracked against upstream.

Break a plan, spec, or conversation into **tickets**: tracer-bullet vertical slices, each declaring its blocking edges. Create tickets only when the work needs several implementer sessions; work one implementer can finish in one session needs only a single brief, no tickets.

Publish as `docs/agents/issue-tracker.md` says. If it is missing, ask the owner where to publish (there is no tracker-setup skill). When the tracker is GitHub with a `.scratch/` mirror, use `gh` to write to GitHub only, never write `.scratch/`, and call `hud_tickets` with `op: sync` for the project to update the mirror.

## Process

### 1. Gather context and explore

Work from conversation context or a referenced spec/issue. Respect `GLOSSARY.md` and `docs/adr/` if present. Look up small codebase facts yourself; for larger investigations, dispatch a HUD role via `hud-delegate` (`hud_roster`)—never use native or background subagents.

### 2. Draft vertical slices

Break the work into **tracer-bullet** slices:
- Each cuts a narrow, complete path through every layer (schema, API, UI, tests) and is verifiable on its own.
- Each fits a single implementer session. Do any prefactoring first.
- Declare **Blocked by** edges: tickets that must finish before this one starts.

### 3. Check granularity and dependencies

The main session chooses slices and their order within the approved scope. Check that blocking edges genuinely gate work and that each slice can be verified; don't ask the owner to approve the routine slice list.

A ticket whose acceptance cannot be written, or whose boundary depends on something the spec leaves open, is a spec gap: write it as an owner question in `docs/handoff/questions/` and keep that ticket out of `ready-for-agent`. Do not settle the spec yourself.

### 4. Publish tickets

Publish blockers first in dependency order. Do not close or rewrite a parent issue. Open items in the spec keep derived tickets from `ready-for-agent`; otherwise label `ready-for-agent`.

- **Local tickets:** call `hud_tickets` with `op: add`, the `feature` slug, and a `tickets` list. Give each draft a `title`, `blocked_by` (local ticket numbers or `feature/NN` references, or `[]`), `what`, `acceptance` (a list of items), `live_try` (a concrete instruction or `none`), optional `status` (default `ready-for-agent`), and optional `owner_try` (default `false`; set `true` only when the owner must try the result). The tool numbers the drafts in list order and returns the numbers and paths. New features use `.hud/tickets/<feature>.json`; edits do not wait for a land or make a Git commit on their own. The next `hud_land` folds HUD-written ticket files into the landed commit; when nothing lands, call `hud_tickets` with `op: commit` (or `hud tickets commit`).
- **GitHub with `.scratch/` mirror:** publish the spec as the parent issue (if not already published), then create each ticket as a GitHub sub-issue of that parent (`gh issue create --parent N` or `gh issue edit N --add-sub-issue M`). Express blocking as native blocked-by edges or a single body line `Blocked by: #N, #M`. Never write `.scratch/`. After publishing, call `hud_tickets` with `op: sync`; sync reports the `<slug>` derived from the parent title and writes each mirrored ticket file to `.scratch/<slug>/issues/<N>-<slug>.md` (where `N` is the GitHub issue number).

For a local ticket tied to an Objective, pass `objective` to `add` (once for every draft, or per draft) or to `update`. The tool checks the ID against the project's `.hud/objectives.md`. The panel groups work by each Objective's `Features`, so `add` also appends the feature there (uncommitted, like `hud_objective`); `update` writes only the ticket field. An `add` without `objective` for a feature no Objective lists still writes the tickets and returns a `warning`.

### 5. Ownership and HUD dispatch

- **Single writer:** the main session ticks acceptance after checking results; workers never edit ticket files or issues. For local tickets, call `hud_tickets` with `op: update`, `feature`, `ticket` (number), and `status`, `owner_try`, `blocked_by` (replacement blockers), and/or `tick` (1-based acceptance IDs). On JSON tickets, `update` can also append a `comment` or edit spec fields like `what` and `live_try`. Use `op: get` with the `feature` (and optionally `ticket`) to read the typed record. For GitHub with a `.scratch/` mirror, tick acceptance on the GitHub issue, then call `hud_tickets` with `op: sync` again—never edit mirror files.
- **Dispatching:**
  - **Local tickets:** use `hud_tickets` with `op: ready` for dispatchable tickets. Pass the returned `ticket` (`<feature>/<NN>`) to `hud_create`; it supplies the brief without a `brief_file`. The live job claims the ticket without a file edit or commit.
  - **GitHub with `.scratch/` mirror:** pass `package: "<slug>"` (the slug that sync reports from the parent title) to `hud_create` and name `.scratch/<slug>/issues/<N>-<slug>.md` or `#N` in the brief.

<local-ticket-template>

# NN: Ticket title

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** end-to-end behavior this ticket delivers, from the user's perspective.

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

## Comments

</local-ticket-template>

<issue-template>

## What to build

End-to-end behavior this ticket delivers, from the user's perspective.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

Blocked by: #N, #M

</issue-template>

Omit the `Blocked by: #N, #M` line if there are no blockers or if using native blocked-by edges.
