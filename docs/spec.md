# HUD product spec (draft for the owner)

Status: **draft, 2026-11-10.** Only the owner decides what this page says: an agent may edit it only after telling the owner the change and the reason for it (owner, 2026-11-17). It is the boundary for every brief, answer and
review. When anything here conflicts with the concept document or older decisions, this page wins.

## 1. What it is

One HUD for Claude Code, Codex and pi, used by one person (the owner) on one Linux/WSL machine, inside herdr.

## 2. What it must do

1. **Delegate through one MCP.** From any of the three main sessions, start and use roles with its tools, today `hud_roster`, `hud_create`, `hud_read`, `hud_send`, `hud_respond`,
   `hud_close`, `hud_wait`, `hud_peek`; the count is not a limit, and a tool is added when it is the clearer interface (owner, 2026-11-17). CLI roles run through herdr and pi-roles, or on an interactive coding CLI herdr knows (Grok Build, Antigravity, Claude Code, Codex): a role names a job's work (its instructions and whether it can continue) and an ordered list of places to run (harness, model, thinking): the first available one is used, a place that hit its quota is skipped until its parsed reset time (or for an hour when no reset window is named), the owner switches places on the control plane, and `hud_create` may still pick a harness or a named `preset` for one job (owner, 2026-11-14; preset override and parsed quota reset, owner 2026-11-18: the MCP shows logical roles such as imp, reviewer, sonic, oracle; no per-harness or per-site role names; browser work runs on the `bro` harness, not called Jev; `oracle` is a local read-only advisor role on a model harness, the strongest-model seat for any judgement the brief sets, not only design (owner, 2026-11-17), and the strong web model (ChatGPT 6 Pro, then Gemini, then AI Studio) is its own browser role `pro`, owner 2026-11-14); the HUD checks local CLI trust files before opening a tab and starts the CLI in the job's herdr tab with only its model, effort and permission-bypass flags, drives the job like a pi job from herdr's status (report, idle grace, continuation, questions, stop, reap), never changes the CLI's own config or session store, and refuses a directory the CLI does not trust (owner, 2026-11-13; pre-flight trust check and per-job concurrency so slow launches never block other jobs or answers, owner 2026-11-18); `hud trust <dir>` is the one exception: it adds an owner-chosen project directory to the trust lists of Grok Build, Antigravity and Claude Code by writing their files directly, after a backup under `$HUD_HOME` (owner, 2026-11-13); browser tasks (ChatGPT, Gemini, AI Studio, Flow) run through the shared browser. **Jev** and the **Decision API** name the structured-output decision model (choice/predicate answers with probabilities), not the browser (owner, 2026-11-11). Roles are defined by files; the HUD ships defaults. Role presets (owner, 2026-11-17): a role file may carry named presets, each a whole ordered list of places; on the control plane the owner applies a preset to a role in one step instead of editing place by place, the row shows which preset is in force, and `hud_create` may pass `preset` to select one for a single job without editing the role file (owner, 2026-11-18). The HUD ships presets for the owner's current combinations; imp also ships Grok 4.7 (high) and Antigravity Hydrogen (high). `architect` and `oracle` are one role, `oracle`, whose former setups are its presets; `architect` is also accepted as another name for `oracle` when a job is created, unless a role file defines its own `architect` (owner, 2026-11-17). The HUD also ships `general` (owner, 2026-11-16): a global role with no fixed specialty for ad-hoc dispatch, whose brief defines the work; the main session points it at any model for one job with `hud_create`'s `model`/`thinking` (for example a pi provider's model). A project the owner set up with `hud setup` adds its own role files under `.hud/roles` (committed) and may hide the others; its pi role files may name skills (linked under `.hud/skills`) and a worker prompt (`.hud/agents`) (owner, 2026-11-13). `hud_create` may override a role's model and thinking for one job (owner, 2026-11-11), pass `context_files` and `from_jobs` (writing a reference index into local worker briefs and splicing bounded file contents directly into browser briefs without round-tripping through the main session's context, owner 2026-11-18), request `isolation: "worktree"` (creating a clean git worktree with `node_modules` linked, reporting `git_summary` in `hud_read`, and letting the watcher reap clean merged/unmodified worktrees after closure while preserving dirty or unmerged ones, owner 2026-11-18), and, for pi roles, the common launch options as named switches (pi-lens, MCP adapter, tokens/s, UI extensions, the helper pane, personal skills) plus a free list of pi arguments passed through as given (owner, 2026-11-11). `hud_wait` waits on multiple jobs (or all open session jobs) for `any` or `all` settlements or open questions over one event-driven watch; `hud_peek` reads bounded recent pane output and optional `progress.jsonl` entries written by `hud-progress` without altering job state (owner, 2026-11-18). The MCP knows no particular role and no workflow. The main session decides every next step; the HUD never chains roles itself. One exception (owner, 2026-11-14): a CLI job that stays quiet without a report past its idle grace gets one Decision API choice among fixed actions (keep waiting; send one fixed prompt to write the report; fail it and mark its place exhausted; hand it to the main session); below a confidence threshold, without a key or on any error it goes to the main session. The "fail" choice stands only when the quoted screen line is a quota or rate-limit message; any other reading goes to the main session (owner, 2026-11-14). Only facts end a CLI job (owner, 2026-11-14): it fails only when its process is gone, its tab was closed or dispatch was rejected before any input; a worker that exits after writing its report is closed, not failed; herdr's screen status, a missing report and a dead supervisor never fail or quit a live worker, they hand it to the main session. A live child process the worker started in its current turn is a fact that it is still working (owner, 2026-11-17, after two live agy runs: agy's background and daemon commands are its own descendants while herdr may show idle; session-long helpers such as MCP servers do not count, or no Claude or Codex worker would ever close; an MCP server a known launcher (`npm exec`, `npx`, `uvx`) brought up for the worker does not count even when it finishes starting after the first turn was sent, owner 2026-11-18): such a job is not settled, gets no quiet-job decision and is not closed until the worker declares the turn finished. For a CLI worker, the declaration is an explicit done receipt for the current turn, with the signature of a fresh report that still matches the report on disk. A new turn or a rewritten report invalidates that receipt; terminal output and herdr idle do not declare or invalidate completion. Pi's native turn settlement with a changed report is its equivalent. Leftover shells, test runners and daemons then do not prevent settlement: a continuable worker with an unread report enters idle grace, and a settled worker closes when its report is read or the deadline passes. Close terminates the worker and its proven descendants, including leftovers; processes without captured ancestry are left alone. Without a valid declaration the original live-child rule still applies (owner, 2026-11-19). A stop on purpose is recorded as stopped whichever writer sees it first, even when the tab closes at the same moment; a closed worker whose process or tab cleanup failed is retried until it is gone; a continuation that was refused before any input does not open a new working turn (owner, 2026-11-18). A settled job's worker is closed as soon as the main session has read its report (owner, 2026-11-17); an unread report keeps it until its idle deadline as before; a repair after that is a new job. Whatever the panel shows about a job also reaches the session that dispatched it (owner, 2026-11-14): `hud_create` returns a dispatch failure as a failure, every MCP response carries the changes to that session's jobs since its last call (plus `watcher_alive` when a pane watcher is registered), `hud watch` prints one line per job event for a session that can watch a command (Claude Code's Monitor), Codex queues events silently, and pi's HUD extension delivers events natively through session message queuing without typing into the editor (owner, 2026-11-18); nothing is typed into the main session's pane when native or watched delivery is active; the panel and the MCP derive a job's state through one shared reader. Workers are neutral: each does only its own job (owner, 2026-11-17, WORKER-UNIFY): a worker
   on any harness may start sonic on its own for a simple, fully specified sub-task whenever it judges that useful,
   choosing sonic's thinking for that sub-task, and waits for its report; it starts no other role, and the HUD refuses
   any other role a worker tries to start. A worker's role has one instruction text whatever harness runs it. The HUD ships a short default dispatch convention; a project's or the owner's own file replaces it whole. The convention
   carries only HUD's dispatch mechanics; method (grilling, specs, tickets, design vocabulary, build recipes) lives in
   skills that load on demand and may stay uninstalled, never in the convention every session receives (owner,
   2026-11-17). `hud_roster` returns the roles and the convention in effect. The
   tools are a thin layer over the locally installed pi-roles and herdr (pi-roles' pi package, `STATUS.json`, `qN.answer.md`,
   `pi-role-reap`); the MCP opens each job's herdr tab itself; jobs are plain JSON under `$HUD_HOME/jobs`. pi-roles
   is not bundled (owner, 2026-11-10). The main session never manages workers: `hud_create` starts them, the job
   watcher closes them; `hud_close` only closes one early (owner, 2026-11-11).
2. **Show what is happening.** A side panel (Home, Project) shows the main session's jobs and their state; Home is one page: what needs the owner, then the package lanes with their job cards, then the decisions (Home and Work merged, owner, 2026-11-11). Finished jobs and older decisions hide after a short time; `a` shows them again in place (owner, 2026-11-11). The bottom
   status lines are always on (Claude's statusline, pi's footer; Codex's tmux bar comes with `codexH`); only the side panel is opt-in: it opens only with
   `/hud` (owner, 2026-11-11). One sidebar for every client (owner, 2026-11-17): Codex opens the same standalone herdr
   sidebar with `/hud` as Claude and pi do; Codex's tmux panel (F12/Shift-F12, the prefix keys, the gutter focus lock and
   the prefix setting) is retired, and Codex's tmux bar stays. The sidebar takes the mouse in every client: a click
   selects a tab, row or button, a second click acts as Enter, the wheel scrolls. The delegation tools stay registered either way (owner,
   2026-11-11). Each client keeps one status line: Claude's statusline (replacing claude-hud, same fields as the owner uses), pi's footer
   (taking in p10k-footer; its ribbon stays at the right end of the editor's top border and other extensions' statuses
   stay visible, owner, 2026-11-12), Codex's existing tmux bar. Every status line shows output tokens/s (owner, 2026-11-17): the pi footer already does; Claude's statusline and Codex's bar show it too. Bar themes (owner, 2026-11-12): Gauge Plates, Tide, Micro
   Glyphs, Stacked (two rows, the one opt-in exception), Headline and Triptych from the BAR-THEMES concepts join as
   choices on all three bars, the pi ribbon included; the default stays today's look. The panel and status lines can use external models with the
   owner's own keys (`$HUD_HOME/credentials.env`, through the Decisions API) for job summaries, recaps and sentences.
   These features only read job files and write display text; they never prompt, brief or steer a worker.
   Decision-API labels (owner, 2026-11-12): a settled job's outcome, a job's kind, a quiet running card that repeats
   the same failure, a worker question's category and a review's findings by severity, through the Decision API chosen in Settings
   (default OpenAI). Display only, like the rest. No consent
   or authority layer. Home mode (owner, 2026-11-12): Default or Recommended; Recommended orders and folds Home's cards by a Decision-API ranking and shows a short progress brief; cards that need the owner are never hidden. A job may carry an optional package label (given to `hud_create`, else taken from the brief's
   title); the panel groups jobs by it into lanes. The label is display only: the MCP does not interpret it.
   The panel also shows the main session's native subagents (Claude Code's Agent subagents incl. custom ones, Codex
   subagents, pi's), read from the client's own transcripts, each with an external-model summary of what it is doing.
   On Home each main session gets one lane beside the package lanes, one card per subagent with the same hide rules;
   a subagent's own subagents indent one level, deeper ones are flat with `↳ parent`. Their model text follows the one
   master switch; the agent log, card label and card summary settings go (owner, 2026-11-12).
   A Project tab shows the project at a glance: the control plane (roles in effect with their models,
   the convention and its source, which keys and the browser are available), the working tree (branch, changes,
   which job is editing it, last commit), docs (spec milestone, STATE's items waiting for the owner, the newest
   review; STATE.md carries a `## Waiting for the owner` list and a `Milestone:` line, owner, 2026-11-12), a progress board so the owner need not ask (owner, 2026-11-12: read straight from the project files, no model: STATE's `## Now` line as a summary, one stacked bar and legend counting STATE's `## Slices` ledger by state (working, blocked, landed to try, accepted, todo, dropped), milestone chips from §5 with the current one from `Milestone:`, a block per slice in flight with what its job is doing now, and STATE's `## Next` list) and the tickets from Matt's `to-tickets` (status, blocked-by, linked to the package lanes). Home shows a compact copy of the progress board and
   the open tickets in its spare rows; cards always win the space (owner, 2026-11-12). Home's top line counts STATE's waiting items with the job questions, and an idle Home also lists the waiting items and the newest landed slices above the progress block (owner, 2026-11-17). The control
   plane shows each role's assignment (role, harness, model and thinking, source file) and lists its files: HUD role files, pi-roles role definitions (model, thinking), the clients' native custom
   agents (`~/.claude/agents`, a project's `.claude/agents`, `~/.codex/agents`), the convention in effect and the
   instruction files (CLAUDE.md, AGENTS.md). Enter opens the item's file in `$EDITOR` (default `vim`) in a herdr pane
   beside the panel. Project hub (owner, 2026-11-14): Project is a hub with one summary row per page (progress,
   tickets, working tree, docs, control plane) and each of those is its own page. The progress page shows what is in
   flight now (ledger slices and the project's running HUD jobs), Next, the slices landed to try and the accepted
   ones grouped by milestone (older milestones folded); the tickets page shows each ticket's checklist and latest
   comment in the panel. Project switches between the panel's own project and the projects set up with `hud setup`;
   Home stays on the panel's project. Timeline layout (owner, 2026-11-14, PROJECT-UX direction A): the hub also shows
   Now (who is on which slice, for how long) and Latest (the last landed slices, their age and whether they wait for a
   try) above the page rows, and when the panel is short Latest folds first; the hub's bar is the current milestone's;
   Progress is a dated feed of the last 7 days with older work one row per milestone; Tickets are lanes by state with
   a For-you lane; try records (owner, 2026-11-17): on the Progress page's to-try view `y` accepts and `n` flags the
   selected row, a milestone row meaning all its slices still to try and a slice row that slice; the panel writes only a
   record under `$HUD_HOME` (never a project file) and shows the mark at once, the main session hears it through
   `hud watch` and MCP `changes` and updates STATE (accepted slices become `accepted`; a flagged one goes under
   Waiting for the owner and the main session asks the owner what is wrong); the owner can mark several rows first and
   `y`/`n` then records them as one record, so the main session hears one line (owner, 2026-11-18). What the owner
   tries is never cut to a name (owner, 2026-11-18): a waiting item shows its whole text, wrapped, wherever the panel
   has the rows. With the model on, a to-try slice gets a short brief (what changed, in plain words) and acceptance
   steps (how to try it), made from its ledger line, ticket and commits; its list row then shows its ID and the
   brief's first sentence, and its preview (or expanded row) shows the whole brief, the steps and, folded below them,
   the original ledger text (owner, 2026-11-19: the ledger text is written for agents). With the model off, or before
   its brief exists, the row shows the whole original text, wrapped. This is the one place the progress board uses the model; the control plane opens with what needs attention and the place the next job will use, healthy
   roles folded. Skills list (owner, 2026-11-17; moved from a third main tab into Help, owner, 2026-11-17 second decision: Home and Project are the only main tabs): a section of Help (`?`) lists the backup skills, Matt Pocock
   skills that are not installed (adapted copies in `integrations/skills-optional/` and the upstream text) and that
   the main session reads when the owner asks for one; each skill's name and its whole one-line description in the panel's language, read from a catalog file
   the HUD ships; the description wraps under the name rather than being cut, so the list reads at the owner's 40-column
   panel (owner, 2026-11-17). Display only: no action on a row, no install state, no adopted or dropped skills.
   Project layouts (owner, 2026-11-20): Settings → Panel → Project layout offers Timeline (the Project tab described
   above, the default), Board and Inbox (PROJECT-UX directions B and C, `docs/design/project-ux/`, detailed in
   `.scratch/project-layouts/spec.md`), in Split and Classic. A Project layout arranges the Project tab's pages only:
   counts, keys, to-try rows, cuts and words are the same in every layout, Home and Tickets do not change.
   Panel layouts (owner, 2026-11-17, PANEL-REDESIGN): Settings → Panel → Layout offers Classic (Home and Project as
   described above, the default) and Split (option 2 of `docs/design/panel-v8/`: a list over a preview of the selected
   row). Split departs from this section's Home and Project layout sentences only where `docs/design/panel-v8/notes.md` says so;
   in every layout what needs the owner is never hidden. The owner tried both and kept Split (2026-11-18): Inbox is
   deleted; Classic stays the default.
   Panel micro-actions and V2 visual upgrades (owner, 2026-11-18): while the panel never briefs workers or chains workflows, it offers three direct owner controls equivalent to local commands—`g` focuses the selected HUD job's herdr tab, `1`–`4` or `d` on an expanded question slab writes `qa/qN.answer.md` once (reported to the main session via `changes` / `hud watch`); number keys do not switch tabs (←→, Tab and a click do; owner, 2026-11-19), and `X` with confirmation reaps a runaway job via `pi-role-reap`. Split shows compact keyword/progress cues on non-selected working list rows, supports `=` / `-` (keys only, no divider drag; owner, 2026-11-19) to adjust list/preview split ratio while auto-compacting the list when focus enters the preview, and paints a zero-width scrollbar indicator on the right edge of scrollable previews. `/` filters rows live across Home, Progress slices and Tickets. Cards and the Inspector show a 10-bucket activity sparkline (`▁`–`█`), worker `hud-progress` milestones, and nested `sonic` child trees under parent jobs. Inspector, Working tree and To-try previews render a bounded safe Git `--numstat` diff bar (top 12 files) for the job's worktree or slice commits. The Control plane surfaces client quota watermarks, today's pi spend and today's per-role dispatch health alongside presets. `hud board [--html] [--open]` (and `w` in the panel) exports a self-contained static HTML project and to-try review board with zero network fetches and no resident server.
3. **Set up a project's workers in one conversation** (owner, 2026-11-13). `hud setup --detect | --apply PLAN | --remove` writes a project's `.hud/` and is driven by a `hud-setup` skill that asks the owner, as claude-hud's setup does. Customisation is on pi workers only: main sessions and the official harnesses (Claude Code, Codex, Grok Build, Antigravity) keep their behaviour, and their roles are only shown or hidden. A project's `.hud/` loads only once the owner has set that project up (`$HUD_HOME/projects.json`); a cloned repo's `.hud/` does nothing on its own.
   Skills (owner, 2026-11-17, second decision; supersedes the same day's adapted-skills and MATT-PARADIGM
   decisions): the HUD's own flow is the one in `docs/delegation.md`, slicing with `to-tickets` and one review per
   milestone. Matt Pocock's skills are an inactive collection taken on demand: the upstream plugin is off
   everywhere (Claude, Codex, pi, other harnesses), and only `to-tickets` (adapted to the Project tab's ticket format
   and `hud tickets sync`) is installed, for Claude, Codex and pi main sessions (pi added 2026-11-20 so every harness starts alike; pi workers run with `-ns` and never load it). The other adapted copies
   (`grill-with-docs` with `grilling` and `domain-modeling`, `to-spec`, `hud-build`, `tdd`, `diagnosing-bugs`) and
   verbatim copies of the rest of the collection (`wayfinder`, `triage`, `improve-codebase-architecture`, `wizard`,
   `teach`, `wait-what`, `writing-for-agents`, `to-questionnaire`, `prototype`, `retro`, `pr`, `codebase-design`;
   owner, 2026-11-17) live in `integrations/skills-optional/`: not installed, not linked to workers, not offered by
   `hud setup`, and no role loads one by default, the oracle included; the main session reads one when the owner
   asks, or names one by path in a worker's brief. Each names the upstream commit it came from; we own the adapted
   text and do not track upstream. `hud-handoff` is installed for Claude, Codex and pi beside
   `hud-delegate` and `hud-setup`. The Skills tab lists the whole inactive collection. Ticket tracking: a project's tracker may be GitHub Issues, mirrored one way into `.scratch/` for the Project
   tab and workers; only the mirror tool writes the mirror. The mirror tool is `hud tickets sync` (owner, 2026-11-17):
   it reads the project's GitHub issues through `gh`, takes each parent issue with sub-issues as a feature (its slug
   from the parent's title) and its sub-issues as that feature's tickets, and writes them into `.scratch/` in the
   format the Project tab reads. The main session runs it after each tracker write; nothing polls, and the panel
   never touches the network.
4. **Install and uninstall in one command.** `./install` with core plus chosen extensions (Claude, pi, Codex, browser,
   herdr); `hud uninstall` removes them. Registration uses each client's official commands where they exist.

## 3. What it does not do

- No own execution platform: no ledger database, process supervisor, native host or bridge, no SDK-driven sessions.
  herdr, pi-roles and the browser runtime already do execution.
- No workflow engine and no automatic role chaining.
- No multi-user or adversarial security model; no identity proofs between local processes.
- No transactional installer: no plan IDs, receipts or byte-exact restore. A plain backup of each edited client file
  is enough.
- No vendor version pins.
- No tracking of upstream for ported parts (the claude-hud statusline, the p10k-style footer): they are ours and
  change only for our needs (owner, 2026-11-10). pi and its extensions are updated with `pi update` when useful.
- No Windows native, no npm publishing, no cross-machine use.

## 4. Threat model and quality bar

- Trusted: the owner, the owner's own configs and tools. Guard against only two things: **irreversible loss of the
  owner's data or config**, and **running commands from an untrusted repository** (for example git config in a
  cloned repo).
- Everything else takes the simplest implementation that works. A new guard, option or abstraction needs a concrete
  reason written in the brief.
- Lightweight: no resident service; a job watcher that `hud_create` starts on demand reacts to job-file and herdr
  events, reaps finished jobs and exits when none is open (owner, 2026-11-11); the statusline and panel stay at least as fast as what they replace.
- **Done means the owner can install it and use it**, not that the tests are green.

## 5. Milestones

- **M1, usable** (owner, 2026-11-10): `./install` run from the repo (core + Claude, pi, Codex extensions) and
  `hud uninstall`; MCP and skill registered in all three clients; `hud panel`; the six tools work for imp, reviewer
  and sonic through herdr; Claude statusline at claude-hud parity; pi footer replacing p10k-footer. The owner
  installs and uses it.
- **M2, clean** (right after M1): delete the retired execution stack (R6b slice L), the old role facade and its identity/release checks (replaced by the thin layer), the old hud-mcp surfaces (the default managed surface and role-main), and their tests.
- **M3, extend:** browser tasks and oracle jobs.
- **M3b, AI-THIN** (owner, 2026-11-11): the panel's words for HUD jobs come from an external small model with the
  owner's key; it only reads job files and only writes display text.
  - Where: the third line of a thin-job card (one sentence on what it is doing now); decision titles (≤ 8 words,
    what was decided, from question and answer); a finished job's one-line result. The model marks 1–3 keywords in
    its sentence and the panel colours them.
  - When: on a job's state change, at least 2 minutes apart per job, in the panel's language. Without a key, or
    with the switch off, the factual line shows as today.
  - Settings: one master switch (on when a key exists), the model, the call cap. No per-feature switches.
  - Deleted: the consent setting and authority layer (`src/core/materials`), "Job consent denied"; card progress
    used only by the removed facade jobs; model text seen only in hidden views (main recap, approval words, change
    summary, session title, the `S` overview).
  - Kept for NATIVE-TREE: model text on native agent cards (agent names, progress, result digest, failure cause),
    redone there the same way.
  - Old views (owner, 2026-11-11): keep the Inspector (`v`), Settings and Help; delete Timeline, the
    Activity hub, Summary and the diagnostics pages, keeping only the model-call count (in Settings → LLM). Changes
    keeps only the git and worktree summary (branch, ahead/behind, change counts, one row per worktree), no file lists,
    diffs or previews (owner, 2026-11-12). The old
    Agents pane goes after NATIVE-TREE redoes native agents on Home. A separate cleanup slice after ONE-PAGE. The kept
    pages are redrawn in Home's look; Settings drops the panel picture, Look presets, the Nerd Font and emoji icon sets,
    the motion switch, the stack/tabs layouts, the foot status card and the rows only they used (owner, 2026-11-11).
  - Done: the owner runs real jobs on the real panel; card, decision and result lines are one sentence each, not a
    wall of text, and the keywords scan at a glance.
- **M4, project view:** the Project tab, after the other open items. It does not wait for Matt's skills: the tickets
  section stays empty until a later slice adapts to-tickets (owner, 2026-11-12).
  - Frozen (owner, 2026-11-12): M4 closes with the whole-project review, its fixes, three last slices (the panel
    reloads itself after a new build; Settings shows model calls per feature; one command updates the test
    snapshots) and the release. New ideas go to the M5 candidates below, not into M4.
- **0.1.x** (owner, 2026-11-13): 0.1.1 CLI workers and `hud trust`; 0.1.2 `hud setup` (`.scratch/hud-setup/spec.md`); 0.1.3 the Project hub
  (`.scratch/project-hub/spec.md`, owner 2026-11-14); 0.1.4 roles apart from harnesses (`.scratch/role-bind/spec.md`,
  owner 2026-11-14).
- **M5 candidates (not scheduled; the owner picks):** job directories and model caches get a retention period
  (the owner sees the deletion list first); a transcript is read tail-first on open so status shows at once, with the
  nesting filled in behind; rarely changed Settings rows fold under "Advanced".

## 6. How work is done

See `docs/delegation.md`. In short: each brief names the spec line it serves, what is out of scope, a size budget
and a stop rule. Review happens at milestones and before the owner installs, not per package. The owner trying the
build is the main review.
