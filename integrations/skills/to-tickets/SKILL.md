---
name: to-tickets
description: Break a spec or plan into tracer-bullet tickets with blocking edges when the work spans several implementer sessions.
disable-model-invocation: true
---

Adapted from mattpocock/skills `skills/engineering/to-tickets` @5863806 (MIT). Owned here; not tracked against upstream.

Break a plan, spec, or conversation into **tickets**: tracer-bullet vertical slices, each declaring its blocking edges. Create tickets only when the work needs several implementer sessions; work one implementer can finish in one session needs only a single brief, no tickets.

Publish as `docs/agents/issue-tracker.md` says. If it is missing, ask the owner where to publish (there is no tracker-setup skill). When the tracker is GitHub with a `.scratch/` mirror, write to GitHub only, never write `.scratch/`, and run `hud tickets sync` in the repo root to update the mirror.

## Process

### 1. Gather context and explore

Work from conversation context or a referenced spec/issue. Respect `GLOSSARY.md` and `docs/adr/` if present. Look up small codebase facts yourself; for larger investigations, dispatch a HUD role via `hud-delegate` (`hud_roster`)—never use native or background subagents.

### 2. Draft vertical slices

Break the work into **tracer-bullet** slices:
- Each cuts a narrow, complete path through every layer (schema, API, UI, tests) and is verifiable on its own.
- Each fits a single implementer session. Do any prefactoring first.
- Declare **Blocked by** edges: tickets that must finish before this one starts.

### 3. Check granularity with the owner

Present a numbered list showing **Title**, **Blocked by**, and **What it delivers**. Ask whether granularity is right, blocking edges genuinely gate each ticket, and any tickets should merge or split. Iterate until approved.

A ticket whose acceptance cannot be written, or whose boundary depends on something the spec leaves open, is a spec gap: write it as an owner question in `docs/handoff/questions/` and keep that ticket out of `ready-for-agent`. Do not settle the spec yourself.

### 4. Publish tickets

Publish blockers first in dependency order. Do not close or rewrite a parent issue. Open items in the spec keep derived tickets from `ready-for-agent`; otherwise label `ready-for-agent`.

- **Local markdown:** write one file per ticket at `.scratch/<feature>/issues/NN-<slug>.md` from the local template below; the heading number equals the `NN` filename prefix, and `**Blocked by:**` is `none` or `NN, NN`.
- **GitHub with `.scratch/` mirror:** publish the spec as the parent issue (if not already published), then create each ticket as a GitHub sub-issue of that parent (`gh issue create --parent N` or `gh issue edit N --add-sub-issue M`). Express blocking as native blocked-by edges or a single body line `Blocked by: #N, #M`. Never write `.scratch/`. After publishing, run `hud tickets sync` in the repo root; sync prints the `<slug>` derived from the parent title and writes each mirrored ticket file to `.scratch/<slug>/issues/<N>-<slug>.md` (where `N` is the GitHub issue number).

### 5. Ownership and HUD dispatch

- **Single writer:** the main session is the only ticket writer and ticks acceptance checkboxes after checking results; workers never edit ticket files or issues. For GitHub with a `.scratch/` mirror, tick acceptance on the GitHub issue, then run `hud tickets sync` in the repo root again—never edit mirror files.
- **Dispatching:**
  - **Local markdown:** pass `package: "<feature>"` to `hud_create` and name the ticket file path in the brief so the Project tab links the job.
  - **GitHub with `.scratch/` mirror:** pass `package: "<slug>"` (the slug `hud tickets sync` prints from the parent title) to `hud_create` and name `.scratch/<slug>/issues/<N>-<slug>.md` or `#N` in the brief.

<local-ticket-template>

# NN: Ticket title

**Status:** ready-for-agent
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
