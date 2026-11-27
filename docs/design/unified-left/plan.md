# Unified left panel: converged plan

Synthesis by main of council j4b7197b895d0009c (members Fable jb5388758585628c0, Astra j2b11c8a6c6e575a3,
Carbon je8b4a20a335e29c7), 2026-11-27. Owner request: one unified panel on the left that combines herdr's
sidebar navigation with the HUD panel, building on `docs/design/sidebar-dock/` (owner liked its running-workflow
rail). Status: design; the owner asked for a clickable sample before any code.

## Shape

- One left panel. No separate right-side HUD surface. The separate layout (herdr sidebar + HUD dock on any side)
  stays as a setting.
- HUD draws the whole panel inside the existing herdr dock placed left (push). While the dock process is alive,
  herdr's own sidebar has width 0 and `prefix+b` folds the panel. If the panel process exits, herdr draws its
  native sidebar again (built-in fallback).
- Expanded (about 40 columns), Home tab, top to bottom:
  1. Needs you: owner requests as whole sentences (project, what waits, age). Absent when none.
  2. Projects active today, one block each: header (herdr workspace number, project, branch), its main sessions,
     each running workflow as a one-line graph strip, and below a strip only the steps that have a live terminal,
     failed, or ask the owner.
  3. Plain workspaces with no registered project, one line each.
  4. `+N other projects`, then Today and Schedule cards (fold first).
  Project, Execution and Control stay tabs of the same panel; opening one replaces the Home tree (rail one key away).
- Collapsed: fixed 12 columns (owner, 2026-11-27), whether or not a run is active, so panes never reflow at run
  start or end. Row 1 `?N` and the toggle; then per project: workspace number + name, main sessions, the vertical
  miniature graph from the sidebar-dock sample; workers outside a run keep the glued pair (`◐⚒`).
- Narrow (≤64 columns): no side column. herdr's two-row mobile header keeps its first row; row 2 shows a
  HUD-supplied summary (`?N`, one-line run strips). Opening the panel zooms it full width; choosing a target returns
  to the pane.
- Workspace management (new workspace, worktrees, rename, reorder) goes through herdr's existing navigator
  overlays (`prefix+w`, `prefix+o`), not rebuilt in HUD.

## Navigation

| Target | Click or Enter |
| --- | --- |
| Project header | focus its herdr workspace |
| Session or worker row | focus its pane; a hidden worker tab is peeked |
| Run strip, or a step without a terminal | Execution on that run/step |
| Request | Home at that request |
| `→` on a project | Project tab |

Keys: `prefix+b` folds/unfolds; `prefix+d` and `/hud` unfold and focus (again returns focus); `q` folds and returns
focus, never quits; `Esc` at a tab root returns focus without folding.

## Marks

One vocabulary, shape first, ink repeats it: `?` owner is asked (only explicit owner requests), `×` failed or
blocked, `◐` running, `✓` done, `○` queued or idle, `·` unknown. Role glyphs neutral. Current workspace: bold on a
filled row (luminance, not hue).

## Decisions in the synthesis

| Point | Fable | Astra | Carbon | Choice | Why |
| --- | --- | --- | --- | --- | --- |
| Who draws | HUD draws all in the dock | herdr keeps native lists; HUD fills a preview slot via a new protocol | HUD draws in a full-height left dock | HUD draws | ~200 fork lines, mostly fork-owned files; fallback built in |
| Workspace management | rebuild or drop | native lists stay below | herdr overlays | herdr overlays | nothing rebuilt |
| Cold start | first main session opens it folded | trusted launcher on demand | `[dock]` block in herdr config | first main session | no write to the owner's herdr config |
| Calm width | fixed 12 | 4 when calm | 4 when calm | fixed 12 (owner) | no pane reflow |

## Slices (after the owner settles the clickable sample)

1. `q` hides, `Esc` unfocuses, event-driven dock state (delete the 250 ms `dock.status` probe), push as the code
   default (settings.ts still says overlay).
2. Home becomes the project → sessions/terminals tree with jumps, in today's dock; measure click-to-focus and
   event-to-paint against the native sidebar.
3. 12-column rail form (fork: compact width below today's 16 minimum).
4. Unified-left switch (fork: dock stands for the sidebar; `prefix+b` → dock toggle); layout setting
   unified/separate. Owner tries here.
5. `prefix+d` focus toggle and cold start.
6. Narrow terminals (fork: no push width at ≤64, open zoomed; header summary).
7. After the owner's trial and approval: delete the fork's sidebar grouping and `hud_icon`.

## Visible changes for owner approval

In unified mode: herdr's own spaces/agents lists, sidebar drag-reorder, the agent sort toggle, per-client fold
state, "right by default", and the narrow header's status words while a run is active go away; spec §2.2 changes to
unified left by default.

## To check when building

- Whether writing an owner request bumps `jobs-revision.json` (Fable could not confirm).
