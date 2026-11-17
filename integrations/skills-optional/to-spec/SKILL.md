---
name: to-spec
description: Synthesize the current conversation and codebase state into a spec and publish it to the project tracker.
disable-model-invocation: true
---

Adapted from mattpocock/skills `skills/engineering/to-spec` @5863806 (MIT). Owned here; not tracked against upstream.

Synthesize what has already been discussed into a spec in the main session. Do NOT re-interview the user.

Publish as `docs/agents/issue-tracker.md` says (using labels from `docs/agents/triage-labels.md` if present). If `docs/agents/issue-tracker.md` is missing, ask the owner where to publish (there is no tracker-setup skill).

When the tracker is GitHub with a `.scratch/` mirror:
- Publish the spec on GitHub as the parent issue and never write `.scratch/`.
- Create each ticket broken out from it as a GitHub sub-issue of that parent (`gh issue create --parent N` or `gh issue edit N --add-sub-issue M`), expressing blocking as native blocked-by edges or a single body line `Blocked by: #N, #M`.
- Run `hud tickets sync` in the repo root after publishing or updating issues; never edit mirror files.
- `hud tickets sync` prints `<slug>` from the parent title and writes each mirrored ticket file to `.scratch/<slug>/issues/<N>-<slug>.md` (where `N` is the GitHub issue number). Dispatches use that `<slug>` as `package` and name that file or `#N` in the brief; acceptance checkboxes are ticked on the GitHub issue, then `hud tickets sync` is run again.

## Process

1. **Gather facts.** Look up small codebase facts yourself (including `GLOSSARY.md` and `docs/adr/` if present; respect existing product specs). For larger investigations, dispatch a HUD role through `hud-delegate` (`hud_roster`); never use native or background subagents.
2. **Confirm testing seams.** Sketch the highest, fewest seams to test external behavior (prefer existing seams; ideally one) and confirm them with the owner.
3. **Write and publish.** Use the template below. Any unresolved item in `## Open` keeps the spec and any derived tickets from `ready-for-agent`; apply `ready-for-agent` when `## Open` is empty.

<spec-template>

## Problem Statement

The problem from the user's perspective.

## Solution

The solution from the user's perspective.

## User Stories

Only as many numbered stories as needed to cover the scope:

1. As an <actor>, I want <feature>, so that <benefit>

## Decided

Settled product, architectural, schema, API, and module decisions. Avoid brittle file paths or code snippets unless a short prototype shape (state machine, reducer, schema, type) encodes a decision more precisely than prose.

## Assumed

Working assumptions adopted without blocking; revisit if challenged.

## Open

Unresolved questions or gaps. Leave empty when ready; any open item blocks `ready-for-agent`.

## Testing Decisions

- What makes a good test (external behavior only, not implementation details)
- Which seams/modules will be tested
- Prior art in the codebase

## Out of Scope

What this spec explicitly excludes.

## Further Notes

Any additional context.

</spec-template>
