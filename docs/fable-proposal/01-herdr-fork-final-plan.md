# herdr fork: final plan

2026-11-26 · Status: **proposal, waiting for the owner's decisions in §6**. Nothing here is in `docs/spec.md` yet.

Converged from three independent proposals: [Fable](00-herdr-fork-brainstorm.md),
[Astra](../astra-proposal/01-herdr-workbench.md) and
[Carbon](../carbon-proposal/01-herdr-deep-customization-proposal.md). Baselines: MyHUD `432a0992`, herdr-hud
`0409f9fa` (branch `hud`). Every item was checked against the spec; code references the plan relies on were checked in
both repositories (§7 lists what was not).

## 1. What the owner gets

Three steps, in priority order. Each ends with something the owner can try.

1. **Workers leave the tab bar; the Codex bar loses tmux.** Worker tabs are hidden by default and one key in the
   Inspector brings a worker's live terminal to the front. herdr itself draws the Codex bar in a reserved row, so the
   nested tmux session goes.
2. **The panel stops resizing the main pane, requests are visible without it, typed notices cannot touch a draft.**
   `/hud` opens the panel as a docked surface instead of a split. Open owner requests show as a one-line band above
   any main session. Typed delivery to a main session only happens when its prompt is empty.
3. **Try a result in one keystroke; quote what you see to main.** An owner request that asks for a try opens the
   prepared scene. A selection in any pane can be sent to the responsible main session with its source.

Steps 1 and 2 need the fork; step 3 uses what the fork already has and can run in parallel.

## 2. Rules for the fork

- **Mechanism in the fork, content in HUD** (Carbon's rule, adopted). A HUD change is live seconds after
  `npm run build`. A fork change needs a Rust and Zig build plus a `live-handoff` that only the main session runs,
  with the owner's confirmation. So the fork gets small primitives that rarely change; HUD decides what they show
  and when. HUD renders every line it shows at the exact width; herdr only places it.
- **Two fork installs for this plan**, one per step, each carrying that step's primitives.
- **One capability flag per primitive.** HUD uses a primitive when the running herdr reports it. The path it replaces
  is deleted in the slice after the live check, not kept as a second implementation.
- **Fork changes live in their own modules** with thin call sites in upstream files, so selected upstream fixes still
  apply. New handoff fields default when absent.
- **Prerequisite:** herdr-fork/07 (pane identity across `live-handoff`) lands and is installed first.

## 3. The plan

### Step 1: workers off the tab bar, Codex bar without tmux (fork install A)

| Slice | Fork primitive | HUD side | Try |
| --- | --- | --- | --- |
| 1a Hidden tabs | A tab has a `hidden` flag, settable at `agent.start` / `tab.create` and later. Hidden tabs are left out of the tab bar and next/previous; the bar shows one count. Persistence, handoff, exit policy and events are unchanged because the tab is still an ordinary tab. | Worker tabs start hidden (a role-file setting can keep a role visible). The Inspector's focus action reveals and focuses the tab; a second action hides it again. A crashed worker's tab stays, hidden, until failure retention ends. Nothing reveals a tab automatically. | Start three workers: the tab bar shows only a count. From Inspector, bring one forward, type into it, send it back. |
| 1b Pane strip | A pane can reserve one row at its top or bottom, outside the PTY. A client pushes one pre-rendered line with a lease; when the lease expires the row returns to the PTY. herdr clips, never wraps. | `codexH` starts Codex directly in the pane and pushes its bar to the bottom strip. The tmux session, its resize and paste helpers and the bridge-health probe go (§5). | Open Codex: same bar as today, mouse selection and scrollback behave as in any herdr pane, a bar code change shows without restarting the session. |

### Step 2: panel as a dock, request band, draft-safe typing (fork install B)

| Slice | Fork primitive | HUD side | Try |
| --- | --- | --- | --- |
| 2a Docked panel | A non-modal surface docked to the right edge that hosts one command. Toggle is idempotent and single-instance, decided inside the server. Overlay (main pane keeps its width) and push modes. | `/hud` calls the toggle. The split bookkeeping (slot hash, saved intent, `split_reply_lost` reconciliation, ownership polling) goes; the checks on who may open the panel stay. | Toggle `/hud` ten times fast in each client: one panel, no orphan pane, the main pane's text does not reflow in overlay mode. |
| 2b Request band | None new: the top strip from 1b. | For a main session without the Claude mod's band, HUD pushes the same band there: the first open owner request, its project, and the count. A herdr key opens the panel on that request. Same request source and order as Home (spec §2.2); no band when there is none. | With a request open in another project, a Codex and a pi main session show it without the panel; resolving it clears both. |
| 2c Draft-safe typing | A guarded form of `agent.prompt`: it types and submits only when the agent is idle and ready, the prompt line is empty, the pane is not scrolled back and no key arrived in the last few seconds; otherwise it refuses with the reason. The guard's state is in memory only and is never recorded or exported. | Every typed delivery goes through it: Antigravity when idle, Claude Code without tasks or the mod, and the Codex queue-failure fallback. A refused line waits and is retried; nothing is shown to the owner. No new wake path, so no duplicate wakes. | Type half a sentence in an idle Antigravity main session while a worker finishes: the draft is untouched and the notice arrives after it is sent or cleared. |

### Step 3: try desk and quote to main (no fork install)

| Slice | What it uses | HUD side | Try |
| --- | --- | --- | --- |
| 3a Try desk | `layout.apply`, tab creation (both exist). | An owner request that asks for a try may carry a small descriptor: the question to judge, the commit, an existing artifact or a preview action, and where feedback goes. One key on the request opens the scene in a new tab; feedback typed there goes to the responsible main session. A project's descriptor may only name preview actions the owner has configured, so opening a result never runs a command the repository supplied. If the worktree is gone, show the evidence that remains and what is missing. | A statusline change arrives as a request: one key shows the same synthetic state at 40, 60 and 120 columns; a note on the 60-column one reaches the main session that owns the request. |
| 3b Quote to main | Plugin actions already receive the selection, and `stale_content` when it changed. | A key on a selection opens a small composer showing the excerpt as it will be sent. It goes, with its source (project, job, time), to the main session responsible for that pane's job, or the project's main session for other panes. The reply is that session's ordinary answer. | Select two lines of a failing test in a worker's revealed tab, ask "is this from your last change?": the main session receives the excerpt, the job it came from and the question. |

## 4. Where the proposals disagreed

| Question | Fable | Astra | Carbon | Decision and reason |
| --- | --- | --- | --- | --- |
| Who renders HUD content | herdr renders a view-model; MCP moves into herdr | not addressed | HUD renders, herdr places | **Carbon.** Anything that changes weekly must not sit behind a handoff. The spec also rules out a new resident server (§3). |
| What to build first | Status strip for all clients | Select-and-ask demo, then try desk | Duplex socket, hidden tabs, strip, exit-code shim | **Hidden tabs and strip first**: both small, both named by two proposals, and hidden tabs continue M1 ("take workers off the owner's desk"). Astra's two actions do not wait on the fork, so they run alongside as step 3. |
| Strip for every client | Yes, retire native statuslines | not addressed | Codex first, others optional | **Codex only.** Spec §2.2 keeps the native statuslines and they already draw the same line. |
| How to hide workers | A hidden workspace | not addressed | A flag on the tab | **Carbon.** A flagged tab inherits persistence, handoff, exit policy and events for free. |
| The panel | Drawn by herdr | Project-supplied plugin views | Docked surface hosting today's panel | **Carbon's dock**, without its picture-in-picture: a live view of a worker is execution detail the display rule drops. |
| What the band carries | Owner requests, answered in an overlay | not addressed | Worker questions answered with Alt+1..4 | **Owner requests only, and the key navigates.** Worker questions go to main, not the owner (M1); requests have no kinds, so there are no fixed choices to press. |
| Who a selection can be sent to | Main, or a new Sonic | Any working job, with answers tied back to the excerpt | not addressed | **Main only**, pending §6.5. The owner manages objectives, not workers, and the panel does not brief or dispatch (§2.2). This also removes the need for reply correlation. |
| Wake for clients without the mod | Native queued send | not addressed | New guarded wake as a wake path | **Guard only.** Every client already has a delivery path; the gap is that typed delivery can touch a draft (reference, "Universal CLI and MCP"). |
| Socket | herdr as the event bus | not addressed | Multiplexed duplex RPC | **Deferred.** First move HUD's 18 `runHerdr` subprocess calls to the existing socket client; build multiplexing only when a measured hot path needs it. |
| Exit code after a handoff | not addressed | not addressed | Exit pipe shim under every agent | **Not built.** Completion is judged by the report receipt (§2.1), handoffs happen only at fork upgrades, and a shim gives up the direct-exec property the fork was started for. |
| Recording | Record every worker fully | Ten-second ring for TUI bugs | Ring buffer written only on failure | **Carbon's form, deferred.** A crashed tab already keeps its scrollback. Trigger: the first failure that kept scrollback could not explain. |
| Other machines | Phone client for requests | not addressed | Remote worker pool | **Not built.** Spec §3: no cross-machine control. |

## 5. Not in this plan

Visible removals the plan needs (owner approval before the slice, §6.2): tmux inside Codex panes with its prefix keys,
copy mode, `codex-hud-paste` and `codex-hud-resize` and the tmux height and scrollback settings; worker tabs in the tab
bar by default; the panel as a pane that can be moved or resized like other panes.

| Idea | Outcome | Reason or trigger |
| --- | --- | --- |
| Worktree overlap radar (Carbon C-10) | Already decided | worktree-overlap/01 is done: `hud_read` lists overlaps, and the owner chose no notices. |
| Presence detection, "since I left" from activity | Not built | Spec §3: no human activity surveillance. Home already shows recent results and update times. |
| Worker thumbnails, workspace zoom, delegation lines, picture-in-picture | Not built | Display rule and the removed list: execution detail is not shown. |
| Talking to a worker directly: advisor side window, drag a pane to a worker, pane annotations for "next turn" | Not built unless §6.5 says otherwise | The orchestrator runs the workers. |
| Role sandbox, keyboard lock on worker panes, unified permission answers, command palette | Not built | Spec §4 trusts the owner and local tools; hidden tabs remove most stray typing; real permission prompts stay visible as they are. |
| Private OSC channel with a token; screen rules for trust and quota prompts (Carbon C-09) | Deferred | Workers already report through the MCP tools. Trigger: a fact HUD still scrapes from pane lines causes a wrong state. |
| Freeze low-priority workers (Carbon C-07) | Deferred | Role caps and the queue bound load today. Trigger: measured WSL overload with caps in place. |
| Per-launch cgroups, warm agent pool, seat/process split | Deferred | Trigger: a descendant escapes the reap; launch latency measured as the delegation bottleneck. |
| Inline images (Carbon C-04) | Deferred | Depends on the owner's terminal supporting the Kitty protocol. Trigger: a try desk scene that needs a screenshot. |
| Blind two-route comparison, model takeover card, recorded actions, split views of one pane (Astra) | Not in this plan | Each is a separate product idea; none depends on the fork. Raise them when a real task wants one. |

## 6. Decisions for the owner

1. **Scope.** Adopt steps 1–3 as the fork's next work? The spec has no milestone after M3, so this adds one objective
   (`herdr-fork`, continued) or a milestone, as the owner prefers. Recommendation: one objective, three steps.
2. **Removing tmux from Codex panes** (list in §5). Recommendation: yes; the bar stays identical.
3. **Worker tabs hidden by default.** Recommendation: yes, with a per-role setting to keep a role visible.
4. **Panel overlay or push** by default. Recommendation: overlay, push as a setting. The panel is opened to look and
   closed again, and overlay keeps the main pane's text from reflowing.
5. **Selection target.** Main only, or also a working job directly? Recommendation: main only.
6. **Draft-safe typing replaces today's typed delivery** for Antigravity and the fallbacks. Recommendation: yes, with a
   live check per client before the old path is deleted.

Spec lines that would change, for the owner to word: §1 (what the fork provides gains hidden tabs, the pane strip, the
docked surface and guarded typing); §2.1 ("interactive workers have tabs", which may now be hidden; typed delivery is
guarded); §2.2 (the `codexH` bar is drawn by herdr; the request band exists without the mod; the panel is a docked
surface); §5 if this becomes a milestone.

## 7. How it runs, and what is not verified

After the decisions: spec lines, then tickets under `.scratch/herdr-fork/issues/` (08 onward), fork slices on branches
from `hud` in the fork repository, never pushed, installed by the main session with the owner's confirmation. One
review at the end of each step. Every Try above is interactive, so each is an owner try.

Not verified, to check in the first slice that depends on it:

- Whether a non-modal docked surface fits herdr's popup code, which today is a session-wide modal singleton that
  refuses while Copy mode or Settings is open. If it does not fit, 2a becomes a larger fork change and should be
  re-estimated before it starts.
- How reliably herdr can tell that a client's prompt line is empty, per client. 2c ships per client only after its
  live check.
- Which event gives HUD a pane's exact width after a resize, for 1b.
- The reserved-row claim in `src/ui/panes.rs` was read (the inner rectangle already subtracts a scrollbar column);
  the row itself is new code.
