# herdr fork: original brainstorm (Fable)

2026-11-25 · Status: **archive of an open brainstorm, not a plan.** The owner asked for ideas on what a fully
owned herdr fork could do, without regard for rigour. This is that answer as given in chat, translated, with nothing
removed.

It was written **before** checking the ideas against `docs/spec.md` and before reading the Astra and Carbon proposals.
The [final plan](01-herdr-fork-final-plan.md) keeps a few of these, defers some and rules others out under the spec
as it stood on 2026-11-26. If the spec changes, come back here: an idea rejected there may fit later. The last section
records which ideas the spec ruled out and by which clause.

Context read at the time: spec §1, `.scratch/herdr-fork/plan.md`, the fork's source tree at `0409f9fa`.

## Framing

The fork so far only supplies what HUD had to infer from outside (agent identity and exit, launch-scoped tab identity,
declared agent kind, closing a tab when its agent exits). With full freedom herdr can become three things for HUD at
once: its **source of facts**, its **renderer** and its **transport**, while the TypeScript side shrinks to policy
(roles, placement, tickets, objectives).

## The six I rated highest

1. **herdr draws the status row of every agent pane.** One row reserved at the bottom of the pane, rendered by the
   fork, identical across all four harnesses. The Claude statusline command, the pi footer and the Codex tmux bar all
   retire, and no Node process starts per refresh.
2. **The panel rendered natively by herdr.** HUD pushes a declarative view-model over the socket (rows, badges,
   clickable items); herdr draws it and returns clicks and keys. No Node process for display, instant open, display
   fully decoupled from execution.
3. **`wait`, `send` and `read` as native semantics.**
   - `wait`: server-side predicate subscriptions (blocked, exited, output matches); one blocking call, no polling.
   - `send`: herdr knows whether the input box is ready; it queues, pastes in bracketed mode and confirms delivery,
     replacing readiness polling and `retryBusyPane`.
   - `read`: one cursor per reader, returning only what is new since the last read, which saves orchestrator tokens.
4. **A native attention queue with overlay answers.** One key jumps to the next thing that needs the owner, in an
   order HUD supplies. An owner request appears as an overlay on the current pane; pressing 1/2/3 answers through
   `hud_respond` without opening the panel.
5. **Lineage and cgroups.** `agent.start` records `parent_launch_id`, so herdr knows who dispatched whom; each launch
   gets its own cgroup. Result: a team tree, cascade close, CPU and memory attributed per worker, a clean kill of the
   whole descendant tree (replacing `worker-tree.ts`) and memory caps per role.
6. **Full PTY recording.** Compressed to disk per `launch_id`, replayable after the tab closes. "A crash keeps its
   scrollback" stops being needed; trace-review and toktrack both read it.

## Facts (stop inferring)

- **Private OSC channel.** A harness hook or extension writes a private escape sequence to the terminal (job id,
  model, context percentage, state); herdr strips it from the PTY stream. No files, no watcher, no extra IPC.
- **Semantic screen parsing.** Per declared kind, a parser in the fork emits
  `agent.blocked{reason: permission|question|quota}` instead of only working/blocked/idle.
- **PTY metering.** Last output and input time and output rate give a "stalled" verdict (marked working, no output
  for N minutes); busy and idle durations are recorded as facts for toktrack.
- **Read receipts.** herdr knows when the orchestrator last read a worker, which allows a "done but unread" state and
  badge.
- **Owner presence.** Whether a client is attached and when the last key arrived. Present: show overlays. Away: batch
  and push, and schedule heavy work for the away period.
- **herdr as the single event bus.** Panel, status rows and MCP all subscribe to it; file watchers go, and with them
  the concern about Node watcher behaviour across versions.

## Display and attention

- **Back room.** Worker tabs live in a hidden workspace and surface only when blocked; otherwise peek in an overlay.
  This matches "the owner manages objectives, not workers".
- **Borders and tabs carry state.** Border colour for state, border text for ticket and objective, a workspace badge
  for the number of open requests.
- **Fold on completion.** A finished worker's tab collapses to one line with its report summary; expand for the rest.
- **Filter by objective.** Selecting an objective in the panel leaves only its sessions in the tab bar.
- **Kitty graphics.** Quota sparklines in the panel; frontend-imp screenshot evidence inline in a pane.
- **Clickable entities.** `file:line`, ticket ids and job ids in any pane are clickable: open the editor, the ticket,
  a peek.
- **Hand over a selection.** Select any text and send it to main as a quote with its source, or dispatch a Sonic about
  it, with one key.
- **Delegation lines.** Draw the main → imp → reviewer chain on the tab bar and mark which worker the orchestrator is
  reading now.

## Lifecycle

- **Warm pool.** Pre-start claude, codex and pi hidden; `agent.start` takes one, so delegation is near instant.
- **Seat and process apart.** A seat is a stable identity; the process in it can be swapped in place. A handoff
  successor takes the same tab and keeps its identifiers.
- **Freeze and timed thaw.** SIGSTOP idle workers to lower load; a tab out of quota is held natively with a countdown
  and resumes at reset.
- **Fuses.** Wall-clock and idle timeouts per launch, plus a dead-man switch for "two hours of output nobody read".
- **Whole-team restore.** Connect herdr's `agent_resume` with `launch_id`, so after a WSL restart the team and its
  jobs re-attach.
- **Tabs bound to worktrees.** `worktree.rs` exists. A clean exit fires the land hook; the border changes colour when
  two workers edit the same file.

## One layer above the harnesses

- **One command palette.** A herdr-level Ctrl+K to delegate, land, respond and switch model; herdr translates to each
  harness's own command by declared kind and injects it.
- **Unified permission mediation.** herdr recognises all four clients' permission prompts and either answers by role
  rule or raises them into one owner request queue.
- **Keyboard ownership.** Worker panes are read-only to a human until a "take over" key, which also tells the
  orchestrator the owner stepped in; the log separates human input from HUD injection.
- **Sandbox at launch.** herdr starts an agent under landlock or bubblewrap with its role's file scope (reviewer
  read-only, imp writes only its worktree), independent of the harness.
- **Credentials injected only at exec**, with secrets redacted from the output stream and recordings.

## Layout

- **Declarative project layouts.** `.hud/` describes the workspace: main, panel, back room.
- **State-driven temporary layout.** A blocked worker docks beside main and returns when resolved.
- **Council and comparison views.** N workers tile into a grid with synchronised scroll; answers from several models
  to the same prompt sit side by side as a diff, which serves the even-placement model comparison.

## Testing and verification

- **Headless deterministic herdr.** Scripted fake agent screens and cell-grid snapshots, against the `test-flakes`
  class of failures.
- **`pane.snapshot --format png|ansi|json`.** Models verify TUI appearance themselves, reducing Hermes human tests.
- **Fault injection.** Kill, stall and slow PTY, to exercise the supervisor.

## More radical

- **The MCP inside herdr.** roster, create, read, send and wait are herdr operations at heart; implement them in Rust
  as one binary, on the "native hot spots" path.
- **A phone client that shows only requests.** On herdr's remote support, a minimal client for owner requests so they
  can be answered away from the desk; Windows toasts with answer buttons.
- **Graded sounds.** Different sounds for request, completion and failure, with quiet hours.

## One constraint stated at the time

Keep fork changes in separate modules with thin call sites in upstream files, so taking upstream selectively stays
cheap. herdr supplies facts and primitives, HUD supplies policy; otherwise the fork becomes a second HUD.

My first pick then was item 1, the unified status row: visible, all four clients at once, the most direct performance
gain.

## What happened to these ideas (as of 2026-11-26)

For a later reader deciding what to revisit. "Spec" means `docs/spec.md` at MyHUD `432a0992`.

| Idea | Outcome in the final plan | What would reopen it |
| --- | --- | --- |
| Status row for all clients | Kept for Codex only | Spec §2.2 no longer keeping native statuslines |
| Back room / hidden workers | Kept, as a flag on the tab (Carbon's form) | — |
| Overlay answers to requests | Became a navigating band | Requests gaining fixed choices (spec §2.2 says no request kinds) |
| Hand over a selection | Kept, to main only | Owner allowing direct owner-to-worker messages |
| Panel rendered by herdr; MCP inside herdr | Dropped | Fork upgrades becoming as cheap as an `npm run build`; spec §3 allowing a resident server |
| Owner presence; away-time scheduling | Dropped | Spec §3 "no human activity surveillance" changing |
| Phone client; anything across machines | Dropped | Spec §3 "no cross-machine control" changing |
| Delegation lines, fold on completion, borders as worker state, state-driven layout | Dropped | The display rule (spec §1) admitting execution detail again |
| Permission mediation, sandbox, keyboard ownership, credential injection | Dropped | The threat model (spec §4) no longer trusting local tools |
| Full recording | Deferred as a ring buffer written on failure | A failure that kept scrollback could not explain; spec §2.3 retention rules |
| Native `wait` predicates | Mostly exists already (the `PaneOutputMatched` and `PaneAgentStatusChanged` subscriptions) | — |
| Event bus, read cursor, read receipts | Deferred | A measured polling or token cost |
| OSC channel, semantic screen parsing, PTY metering | Deferred | A wrong state caused by scraping pane lines |
| Lineage, cgroups, fuses | Deferred | A descendant that escapes the reap |
| Warm pool, seat/process split, freeze and timed thaw | Deferred | Launch latency or WSL load measured as the bottleneck |
| Kitty graphics | Deferred | A try desk scene that needs an image, on a terminal that supports it |
| Whole-team restore, worktree-bound tabs, objective filter, clickable entities, layouts, council view, palette, sounds, test harness, snapshot, fault injection | Not assessed in the final plan | Raise when a real task wants one |
