# HUD product spec (draft for the owner)

Status: **draft, 2026-11-10.** Only the owner changes this page. It is the boundary for every brief, answer and
review. When anything here conflicts with the concept document or older decisions, this page wins.

## 1. What it is

One HUD for Claude Code, Codex and pi, used by one person (the owner) on one Linux/WSL machine, inside herdr.

## 2. What it must do

1. **Delegate through one MCP.** From any of the three main sessions, start and use roles with six tools: `hud_roster`, `hud_create`, `hud_read`, `hud_send`, `hud_respond`,
   `hud_close`. CLI roles run through herdr and pi-roles, or on an interactive coding CLI herdr knows (Grok Build, Antigravity, Claude Code, Codex): a role names a job's work (its instructions and whether it can continue) and an ordered list of places to run (harness, model, thinking): the first available one is used, a place that hit its quota is skipped for an hour, the owner switches places on the control plane, and `hud_create` may still pick a harness for one job (owner, 2026-11-14: the MCP shows logical roles such as imp, reviewer, sonic, oracle; no per-harness or per-site role names; browser work runs on the `bro` harness, not called Jev); the HUD starts the CLI in the job's herdr tab with only its model, effort and permission-bypass flags, drives the job like a pi job from herdr's status (report, idle grace, continuation, questions, stop, reap), never changes the CLI's own config or session store, and refuses a directory the CLI does not trust (owner, 2026-11-13); `hud trust <dir>` is the one exception: it adds an owner-chosen project directory to the trust lists of Grok Build, Antigravity and Claude Code by writing their files directly, after a backup under `$HUD_HOME` (owner, 2026-11-13); browser tasks (ChatGPT, Gemini, AI Studio, Flow) run through the shared browser. **Jev** and the **Decision API** name the structured-output decision model (choice/predicate answers with probabilities), not the browser (owner, 2026-11-11). Roles are defined by files; the HUD ships defaults. A project the owner set up with `hud setup` adds its own role files under `.hud/roles` (committed) and may hide the others; its pi role files may name skills (linked under `.hud/skills`) and a worker prompt (`.hud/agents`) (owner, 2026-11-13). `hud_create` may override a role's model and thinking for one job (owner, 2026-11-11), and, for pi roles, the common launch options as named switches (pi-lens, MCP adapter, tokens/s, UI extensions, the helper pane, personal skills) plus a free list of pi arguments passed through as given (owner, 2026-11-11). The MCP knows no particular role and no workflow. The main session decides every next step; the HUD never chains roles itself. Workers are neutral: each does only its own job and never
   starts another role unless the brief asks. The HUD ships a short default dispatch convention; a project's or the owner's own file replaces it whole. `hud_roster` returns the roles and the convention in effect. The six
   tools are a thin layer over the locally installed pi-roles and herdr (pi-roles' pi package, `STATUS.json`, `qN.answer.md`,
   `pi-role-reap`); the MCP opens each job's herdr tab itself; jobs are plain JSON under `$HUD_HOME/jobs`. pi-roles
   is not bundled (owner, 2026-11-10). The main session never manages workers: `hud_create` starts them, the job
   watcher closes them; `hud_close` only closes one early (owner, 2026-11-11).
2. **Show what is happening.** A side panel (Home, Project) shows the main session's jobs and their state; Home is one page: what needs the owner, then the package lanes with their job cards, then the decisions (Home and Work merged, owner, 2026-11-11). Finished jobs and older decisions hide after a short time; `a` shows them again in place (owner, 2026-11-11). The bottom
   status lines are always on (Claude's statusline, pi's footer; Codex's tmux bar comes with `codexH`); only the side panel is opt-in: it opens only with
   `/hud` (in Codex with F12, as before) (owner, 2026-11-11). The delegation tools stay registered either way (owner,
   2026-11-11). Each client keeps one status line: Claude's statusline (replacing claude-hud, same fields as the owner uses), pi's footer
   (taking in p10k-footer; its ribbon stays at the right end of the editor's top border and other extensions' statuses
   stay visible, owner, 2026-11-12), Codex's existing tmux bar. Bar themes (owner, 2026-11-12): Gauge Plates, Tide, Micro
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
   the open tickets in its spare rows; cards always win the space (owner, 2026-11-12). The control
   plane shows each role's assignment (role, harness, model and thinking, source file) and lists its files: HUD role files, pi-roles role definitions (model, thinking), the clients' native custom
   agents (`~/.claude/agents`, a project's `.claude/agents`, `~/.codex/agents`), the convention in effect and the
   instruction files (CLAUDE.md, AGENTS.md). Enter opens the item's file in `$EDITOR` (default `vim`) in a herdr pane
   beside the panel. Project hub (owner, 2026-11-14): Project is a hub with one summary row per page (progress,
   tickets, working tree, docs, control plane) and each of those is its own page. The progress page shows what is in
   flight now (ledger slices and the project's running HUD jobs), Next, the slices landed to try and the accepted
   ones grouped by milestone (older milestones folded); the tickets page shows each ticket's checklist and latest
   comment in the panel. Project switches between the panel's own project and the projects set up with `hud setup`;
   Home stays on the panel's project.
3. **Set up a project's workers in one conversation** (owner, 2026-11-13). `hud setup --detect | --apply PLAN | --remove` writes a project's `.hud/` and is driven by a `hud-setup` skill that asks the owner, as claude-hud's setup does. Customisation is on pi workers only: main sessions and the official harnesses (Claude Code, Codex, Grok Build, Antigravity) keep their behaviour, and their roles are only shown or hidden. A project's `.hud/` loads only once the owner has set that project up (`$HUD_HOME/projects.json`); a cloned repo's `.hud/` does nothing on its own.
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
