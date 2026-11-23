# HUD product decisions log

`docs/spec.md` states the current boundary. This log records provenance and superseded decisions.
Dates are the owner dates in the source spec unless marked *recorded*: a spec revision date, not a
separately attested owner decision. Short refs `DD.NN` expand to `D-2026-11-DD-NN`. Section refs point into
`docs/spec.md`.

## 2026-11-22

- **D-2026-11-22-01** (§2.1.6, §2.2.8): Reject self-graded outcomes; keep independent Decision API labels.
  A single `hud_report` writes report, optional one-line summary and file list, and done receipt. Reuse the
  signature-bound summary for result line, notices and `hud_read`, with model fallback for absent, stale
  or wrong-language summaries. No two-minute hold for settled results (qualifies D-2026-11-11-05).

The owner approved the lean spec and resolved the draft questions:

- **D-2026-11-22-02** (§2.2.2, §2.2.4, §2.2.5): Control is a main tab, not a Project page. Narrows the
  original Project hub scope (D-2026-11-12-04 and D-2026-11-14-04).
- **D-2026-11-22-03** (§2.2.9): Backup skills are listed in Help (`?`), not in a Skills tab. Drops the
  earlier setup wording (D-2026-11-17-12 and D-2026-11-17-14).
- **D-2026-11-22-04** (§2.1.1): Update the main-session inventory to match the real tools, including
  `hud_lease` and `hud_statusline`. No tool-count cap (D-2026-11-17-02 and D-2026-11-21-07).
- **D-2026-11-22-05** (§2.2.2, §2.2.4): The removal in D-2026-11-18-08 was of the panel-level Inbox.
  Project keeps Timeline (default), Board and Inbox (D-2026-11-20-06).
- **D-2026-11-22-06** (§5): Document MCP tasks only under MCP-ORCH, where D-2026-11-21-12 moved them.
- **D-2026-11-22-07** (§5): List 0.2.0 (MCP orchestration & Panel V2) as the current milestone. The ladder
  accepts concrete `0.x.y` IDs as well as `M`-prefixed IDs.
- **D-2026-11-22-08** (§2.1.6): Native pi gets the same worker tools, without a fixed count. Clarifies
  D-2026-11-21-03 after `hud_lease` was added.
- **D-2026-11-22-09** (§2.1.6): Per-response `changes`, `watcher_alive`, `hud_wait` and `hud watch` are for
  clients without MCP tasks. Declaring clients get task completions instead (D-2026-11-20-09 takes
  precedence over D-2026-11-14-03 and D-2026-11-18-03).
- **D-2026-11-22-10** (§2.1.5, §3): No general process-supervision platform. The per-job CLI supervisor
  and on-demand watcher are allowed (clarifies D-2026-11-10-03).
- **D-2026-11-22-11** (§2.2.3, §5): D-2026-11-20-04 wins: collect worker decisions without showing them.
  Drops the earlier display and title rules in D-2026-11-11-04 and D-2026-11-11-05.
- **D-2026-11-22-12** (§1, §2.1.3, §2.1.6, §2.2.1, §2.4): Antigravity joins the HUD's supported main
  sessions. Workers get the worker MCP with a shell done-command fallback. Deliver events through
  `PreInvocation` when working and type them into the prompt when idle. Use Antigravity's `statusLine`
  command. The `agy` extension may edit its client config reversibly (Antigravity adapter proposal 25).
- **D-2026-11-22-13** (§2.1.4): In single-job `hud_read`, `git_summary` includes files also changed in other managed worktrees of the same checkout (proposal 15 §6 defaults).
- **D-2026-11-22-14** (§2.1.3, §2.1.7, §2.2.3, §2.2.4, §2.2.8): Home progress (design docs/design/home-progress/,
  owner 2026-11-22): keep STATE `## Slices` plus `.scratch/` joined at read time (not one ledger); ticket
  working/try/done derived at read time from jobs, STATE, commits and accepted tries (no `land` op); a failed job
  leaves Home once superseded (retry, newer job on the same target, or landed), an unhandled one after 30 minutes;
  the Recommended AI paragraph stays but never shows once its inputs changed; the display model may translate
  waiting items, open worker questions and open ticket titles that are not in the panel language (original folded).
- **D-2026-11-22-15** (§2.1.3, §2.1.4, §2.2.6, §5 MCP-ORCH; workflow): Orchestrator load (docs/llm/orch-load-2026-11-22.md,
  owner 2026-11-22: all of A/B/C): the orchestrator hands chores to sonic/imp (integration in a separate worktree
  with test gate, lookups), `hud_read` defaults to a digest, task notices wait for HUD checks and get shorter,
  owner panel actions (answers, try marks, retry/land intents) reach MCP-task clients, batch forms for the
  mutating MCP tools; the watcher may reap worktrees whose commits were cherry-picked onto the base. Settled
  pre-0.2.0 STATE slices moved to docs/handoff/archive/. Behaviour changes approved with their cost and gain.
- **D-2026-11-22-16** (§2.1.5): Before job deletion, append facts only to a monthly archive; no report or brief text, no reader or archive expiry, and no change to job retention (proposal 14 §6 defaults).
- **D-2026-11-22-17** (§2.1.4; worker instructions; owner configs): imp load (docs/llm/imp-load-2026-11-22.md,
  owner 2026-11-22: accept the recommendations): replace the obsolete root `AGENTS.md` with a short worker entry
  and trim worker read lists; cap git self-checks to status/stat/check; targeted tests while iterating and one
  full run at the end (imp keeps its own full run; sonic still gates integration); no sleep polling; pi workers
  start without the MCP adapter when no MCP server is configured; a child sonic's report reaches imp as a push,
  no `timeout_s: 0` polling. imp model: finish the HOME-PROGRESS/ORCH-LEAN batch on astra, compare, then if the
  gap holds switch to sol-fast default with astra for complex slices picked by the main session (that changes
  the §2.1.4 no-override sentence; told to the owner first). CodeGraph removed from every harness (Claude,
  Codex, pi) and from worker instructions; code lookup is grep and read.
- **D-2026-11-22-18** (§2.1.4; worker instructions; owner configs): Non-imp workers (docs/llm/workers-load-2026-11-22.md,
  owner 2026-11-22: accept the recommendations, global not per project): Sonic auto-thinking on; sonic batches
  turns, ~20-turn soft budget, ≤60-line report, no hud_sonic of its own; callers give sonic narrow briefs; reviewer
  stays gpt-6.2-sol max and keeps context under 150k (file-by-file diffs, sonic lookups); oracle pinned to
  thinking high with a max preset and gets a sonic fact dossier first; CLI workers load only the HUD MCP plus
  role-named servers and get instructions as system prompt with short briefs inline. frontend-imp stays
  cli:claude claude-sonnet-5-5 xhigh (earlier neon dispatches were one-off mistakes).
- **D-2026-11-22-19** (§5 MCP-ORCH): Owner 2026-11-22 asked that the orchestrator stop hand-chaining dispatches. Instead of a
  general code mode, fixed HUD flows chain their listed steps and hand back once: land (gate in a fresh worktree,
  fast-forward, build, push, clean up, ticket and STATE line; failures go back to the source imp, at most two
  repairs) and scouted dispatch (a sonic fact dossier first, passed by from_jobs); a ticket queue that dispatches
  the next unblocked ticket comes after those two. Supersedes the §5 exclusion of `after` chaining for these
  flows only; general plan execution stays out.
- **D-2026-11-22-20** (§2.1.4): After the astra trial (docs/llm/imp-load-2026-11-22.md: astra ~$3.7/job vs sol-fast
  ~$0.9 at similar turns and wall time), imp's default preset returns to `fast` (gpt-6.2-sol-fast) and the main
  session passes `preset: astra` for hard slices (several modules, review fixes, design-heavy); the only standing
  exception to the no-override rule.
- **D-2026-11-22-21** (§2.1.2, §2.1.4, §2.2.4, §5; owner configs): After docs/llm/post-change-load-2026-11-22.md
  the owner accepted most recommendations: workers run targeted tests and the land gate runs test:mjs once; no ticket
  claim commits (live jobs count as claims) and `hud_tickets` lists ready tickets; a reload refreshes clients' tool
  lists; CLI workers get role text and brief in the first message; STATE.md keeps milestones while slice progress
  comes from tickets (one commit per land); repo-level Claude tool pruning. Sonic becomes a headless one-shot query
  role outside the herdr worker rules (no hud_ask, no continuation), its thinking choices gain `none`. Roles: imp
  stays pi gpt-6.2-sol-fast high with `astra` for hard slices (the neon trial ends), oracle moves to agy
  gemini-4-carbon-high and the main session may call it without per-job approval for milestone, architecture, design
  and optimization questions, frontend-imp stays claude-sonnet-5-5 xhigh, general runs on agy gemini-4-neon-high (pi general kept as a
  preset), reviewer on agy gemini-4-neon-xhigh (pi gpt-6.2-sol max kept as preset `sol`), and `pro`/`flow` become
  optional roles.
- **D-2026-11-22-23** (§2.1.6, §2.4): The owner wants a Claude Code mod so the workflow is not limited to MCP.
  First slice: main-session context slimming (compact HUD tool results and notices, merge duplicate events,
  route report reads through `hud_read`). Panel inside Claude Code and event wake come later. Installed as an
  `./install` extension like the others.
- **D-2026-11-22-24** (§2.2.9, §2.2.3): Owner after trying the title-less Home: Home rows show no model, effort or
  route marks; the role icon leads the row; no running glyph. Icons become a Nerd Font set (Font Awesome BMP
  glyphs, owner picked from a live render in MesloLGS NF) as the default, with `unicode` and `text` kept as
  fallbacks; emoji stays out (double width). Reverses the Nerd Font part of D-2026-11-11-06. Home's top line
  counts workers per role since the panel opened, whatever their state; no cross-session total.
- **D-2026-11-22-25** (§2.1.6): The owner approved four further Claude mod slices: mod-owned event wake, a band
  and toasts above the prompt, slash commands for owner actions, and mechanical convention rules as hooks. No
  panel inside Claude Code: it would add little over the herdr panel, which stays the panel for every client.
  Oracle designs the four slices before tickets are filed. Oracle's design (job j173e9f379178e359): the mod runs
  `hud watch --mod` on demand and, while it is live, owns wake for that session in place of MCP tasks (Claude
  cannot drop an engine task-notification row, so running both would always duplicate); HUD jobs then leave
  Claude's `/tasks` list and batch `hud_create({ jobs })` works again.
  Owner: an explicit `/land <job>` typed in Claude starts `hud_land` directly (no main-session turn); band
  buttons and `/retry` keep recording intent.
- **D-2026-11-22-26** (§2.1.1, §2.1.5, §2.1.6, §2.2): Three open reviews (fable, carbon, astra) agreed the land
  path is where the day goes. The owner approved all seven directions: install-wide `hud doctor` and
  `hud --version`; docs reflowed one sentence per line with zh synced per milestone; per-job usage and outcome
  in the archive with `hud stats`/`hud day`; compact results from the MCP for every client; a merge check at
  worker report time; fast project checks before a report settles; a land train sharing one gate; and an
  authorized ticket batch that lands clean settles and hands back at the first judgement point. The last two
  of these change the spec (checks may refuse a report; main does not decide each step inside an authorized
  batch); the spec lines change when those tickets are dispatched. Tickets: `.scratch/review-next/`.
- **D-2026-11-22-27** (§2.2.1, §2.2.3, §2.2.4, §2.2.6, §2.2.8, §2.2.9): After the open reviews the owner approved
  six trims, each listed with what disappears: Project keeps only the Inbox layout (Timeline and Board go);
  the per-slice try flow (y/n marks, model try briefs and steps, try detail, `m` land intent) shrinks to
  accept-all plus the main session's flagged items, since every try record was an accept and the main session
  now accepts; bars keep only `line` and `p10k` (six BAR-THEMES go; native covers only those two); the job
  `kind` label and Home's Recommended ranking go (outcome, question category, review severity and routing
  stay); Help drops the backup-skills list for `docs/optional-skills.md`; tickets become the only slice
  ledger and STATE keeps milestone, now, waiting and next. Each ticket updates its own spec lines.
  Tickets: `.scratch/trim/`.
- **D-2026-11-22-28** (§4): Owner after many Home and statusline rounds: what matters is not how complete the
  shown information is but showing the most important; attention is the scarcest resource. Most acceptance
  does not need the owner: only explicitly interactive behaviour suits owner acceptance, otherwise a model's
  live check does better. `owner_try` narrows accordingly in the convention.

## 2026-11-21

- **D-2026-11-22-29** (§2.1.2, §2.1.4): Owner, comparing imp models on landed astra tasks: `general` is the flexible
  seat, so it can borrow any role's instructions for one job (`instructions: "<role>"`), letting a model comparison
  or an owner-named model run with the implementer prompt without editing role files. `imp` still rejects
  placement options; its tier stays the MCP's routing.
- **D-2026-11-22-30** (§2.1.4): The owner runs several subscriptions side by side. `imp` gets a placement mode:
  `fixed` (one preset), `even` (rotate chosen presets by job count over the last day) or `auto` (routing). imp
  first, other roles later. Comparisons on landed astra jobs showed sol found the same root causes at about 40%
  of the cost, so tier is not model strength (astra is often unnecessary). After the neon and hydrogen runs (all
  four found both root causes; they differed in diff size and cost) the owner judged routing has no real judgement:
  `auto` stays as today's routing with no re-tuning, the owner configures placement, and `even` balances quota.
- **D-2026-11-21-01** (§2.1.2): Skip pre-input launch failures for that dispatch; report the places tried.
- **D-2026-11-21-02** (§2.1.2): Grok paused; switch off `grok` and `xai`, remove Grok `imp` presets.
  The shipped `imp` combinations include Antigravity Hydrogen at high.
- **D-2026-11-21-03** (§2.1.6): Move job protocol out of worker prompts into HUD. The dedicated worker MCP
  gets job from environment; pi gets "the same four tools" natively, and the worker list includes leases once
  available. Scripts are fallback only. D-2026-11-22-01 adds report fields; D-2026-11-22-08 removes the count.
- **D-2026-11-21-04** (§2.1.4): HUD owns launch parameters; check model facts before opening tabs, map to
  supported thinking and report the level used. Pre-start failure closes the tab and names the real cause.
- **D-2026-11-21-05** (§2.1.4): Sonic uses role default `high`, not caller choice. Decision API auto-pick
  `low`/`high`/`max` is optional and off by default: the marginal gain does not justify changing model
  behaviour; sonic tasks are simple. Supersedes same-day caller selection and default high with no HUD
  auto-pick (`bdfcf3a0`, `605c908d`).
- **D-2026-11-21-06** (§2.1.5, §5): Closed-job `hud_send` automatically creates a repair job referencing old
  brief and report. Derive create/send idempotency keys when omitted. Builds on D-2026-11-17-08.
- **D-2026-11-21-07** (§2.1.1, §2.1.6, §5): Named exclusive leases before brief-named shared resources;
  release when the holder ends, no resident process. See D-2026-11-22-04 and D-2026-11-22-08 for the
  updated main and native worker tool inventories.
- **D-2026-11-21-08** (§2.1.6, §5): Optional check commands run by HUD after explicit turn completion,
  attached to the report signature. They cannot settle, accept or fail jobs.
- **D-2026-11-21-09** (§2.1.6, §5): Scope jobs to project root, adopt after pane disappears. Choice B on
  restart: recovery stays manual; herdr resume loses HUD bindings, and HUD does not relaunch.
- **D-2026-11-21-10** (§2.3.1, §5): Optional standing `.hud/brief.md` in set-up projects; reference it after
  the task in each brief.
- **D-2026-11-21-11** (§5): Accept MCP-ORCH from oracle job `j61e7649cba37181c`, summarized in
  `.scratch/mcp-orch/`. Milestone follows WORKER-MCP; see §5 for ordered scope and non-goals. Done is a real
  owner project day compared using the same counts as the 2026-11-21 study.
- **D-2026-11-21-12** (§5): Pull MCP tasks forward from M5. D-2026-11-22-06 removes the duplicate text.

## 2026-11-20

- **D-2026-11-20-01** (§2.2.2, §2.2.5): Make Control a main tab alongside Home, Project and experimental EXP
  (see D-2026-11-22-02). Control presents project roles, attention, usage and files, with shared harness
  switches and direct preset/chain editing. See `docs/design/control-tab/design.md`, `docs/design/control-tab/index.html`,
  `.scratch/control-tab/`. Project layouts apply only to Project pages.
- **D-2026-11-20-02** (§2.2.5): Pi model discovery on demand; terminal picker, all enabled providers, local
  model facts. UX-PASS: quick path via `m` or click, in-pane, ranked search with pins; single-model edits save
  immediately. See `docs/design/model-picker/index.html`, `.scratch/model-picker/`, `docs/design/ux-pass/`,
  `.scratch/ux-pass/`.
- **D-2026-11-20-03** (§2.1.7, §2.3.2): Adapted `to-tickets` moved from installed skill to `hud_tickets`,
  the sole workflow exception. Every client uses shipped method/template; no convention additions. Main
  drafts tickets. Local `add`/`update`, `sync` for the mirror; remove old Claude, Codex and pi skill links.
  Supersedes per-client skill delivery, not the method.
- **D-2026-11-20-04** (§2.2.3, §5): Keep collecting worker decisions for the owner but no longer show them.
  Default to seeing, trying and accepting tasks (milestones/features), with a setting for slices/tickets.
  Supersedes the older hide/reveal and title rules, as confirmed in D-2026-11-22-11.
- **D-2026-11-20-05** (§2.2.4): Resolve `(waits on ...)` in display and counts without a STATE edit when all
  dependencies finish. A to-try slice is never also a waiting item.
- **D-2026-11-20-06** (§2.2.2, §2.2.4): Project Timeline (default), Board and Inbox in Classic and Split;
  PROJECT-UX B/C in `docs/design/project-ux/` and `.scratch/project-layouts/spec.md`. Arrangement only;
  counts, keys, rows, cuts, words, Home and Tickets unchanged. See D-2026-11-22-05 for Inbox scope.
- **D-2026-11-20-07** (§2.2.7): Opt-in EXP collects only when on. Codex native line alongside tmux, pi
  subscription proxy and machine-wide API grant ledgers. UX-PASS proxy uses Claude quota style plus source
  and `≈`. No resident refresh or billing/requests integration; zero is not blocking. See
  `docs/design/exp-usage-plan.md`, `.scratch/exp/`.
- **D-2026-11-20-08** (§2.3.1): Allow project CLI routing like owner chains (agent/model/thinking, no args).
  Worker customization remains pi-only.
- **D-2026-11-20-09** (§5): MCP tasks for declaring clients (then Claude Code): a moderate gain over
  `hud watch` plus Monitor, no re-arm and fewer wake-ups. One task per turn, ends at report/question, result
  state/path/summary is not a read, cancel closes job. Replaces wait/watch/changes/watcher-alive for those
  clients (see D-2026-11-22-09); first verify wake, cancel and `/tasks`. Moved from M5 by D-2026-11-21-12.
- **D-2026-11-20-10** (§2.2.2): UX-PASS mouse everywhere: select on first click, Enter on second, scroll by
  wheel, set model on picker row click.

## 2026-11-19

- **D-2026-11-19-01** (§2.1.5): Explicit current-turn done receipt with a fresh report signature, or pi native
  settlement plus changed report. Invalidate on new turn or rewritten report, not screen or idle. Valid
  completion clears the live-child settlement block; close reaps proven descendants only.
- **D-2026-11-19-02** (§2.2.4): Ledger text is written for agents. The list row shows the ID and first
  sentence of the to-try brief from D-2026-11-18-07. The preview or expanded row shows the full brief and
  steps, with ledger text folded below. If no brief exists yet, show the full original text wrapped.
- **D-2026-11-19-03** (§2.2.2, §2.2.6): Arrow keys, Tab or clicks switch tabs, not numbers. Split adjusts
  only with `=` / `-`, no divider drag.

## 2026-11-18

- **D-2026-11-18-01** (§2.1.2): One-job preset override leaves role file intact. Quota reset is parsed,
  with an hour if no window is named. Refines D-2026-11-14-01 and D-2026-11-17-04.
- **D-2026-11-18-02** (§2.1.3): CLI trust preflight before opening tab; concurrent per-job launches so
  other jobs and answers are not held up. Refines D-2026-11-13-01.
- **D-2026-11-18-03** (§2.1.4, §2.1.6): Add context files and prior-job inputs without main-context round
  trip, clean worktree isolation with read summary and conservative reap, multi-job wait and bounded peek.
- **D-2026-11-18-04** (§2.1.5): Known-launched MCP servers (`npm exec`, `npx`, `uvx`) do not count as live
  turn children even if startup ends after first input. Refines D-2026-11-17-05.
- **D-2026-11-18-05** (§2.1.5): Intentional stop wins tab-close race; retry failed cleanup. Pre-input
  continuation refusal starts no working turn.
- **D-2026-11-18-06** (§2.1.6): Pi native session message queue, not editor typing. No typing while native
  or watched delivery is active.
- **D-2026-11-18-07** (§2.2.4): Batch trial marks into one record/line. Never cut what the owner tries to a
  name; show whole wrapped waiting text. A model writes a short brief explaining what changed in plain
  words, and steps for trying it, from the ledger line, ticket and commits. With the model off, show the
  original text. Only board model use. D-2026-11-19-02 changes how the brief is shown.
- **D-2026-11-18-08** (§2.2.2): Owner tried both and kept Split. "Inbox is deleted; Classic stays the
  default" (panel-v8 decision; panel-level Inbox scope confirmed in D-2026-11-22-05).
- **D-2026-11-18-09** (§2.2.2, §2.2.4–§2.2.6): Owner job focus/answer/reap micro-actions without briefing
  or chaining. V2 adds Split/preview cues, filter, sparklines, progress/sonic trees, safe numstat, Control
  quota/spend/health, and self-contained offline HTML board export.

## 2026-11-17

- **D-2026-11-17-01** (preamble): Only the owner decides the spec; tell the owner change and reason before
  editing. Boundary for briefs, answers and reviews over concept and older decisions.
- **D-2026-11-17-02** (§2.1.1): One MCP across all three main sessions. Opening tool inventory is not a
  cap; add a tool when clearer. See D-2026-11-22-04 for the updated inventory.
- **D-2026-11-17-03** (§2.1.2): Merge architect into oracle, turning former setups into presets and
  retaining create alias unless a file defines `architect`. Strongest-model read-only seat beyond design.
- **D-2026-11-17-04** (§2.1.2, §2.2.5): Apply a whole named chain at once, not place by place, and show the
  current preset. Later one-job override D-2026-11-18-01.
- **D-2026-11-17-05** (§2.1.5): A live turn child proves work. After two live Antigravity runs: background
  and daemon commands are its descendants while herdr can look idle. Session-long helpers do not count,
  otherwise Claude and Codex workers would never close. Later launcher and done-receipt refinements in
  D-2026-11-18-04 and D-2026-11-19-01.
- **D-2026-11-17-06** (§2.1.6): WORKER-UNIFY: neutral workers, one text across harnesses; only sonic may be
  started by workers, for useful simple fully specified tasks, with report collection.
- **D-2026-11-17-07** (§2.1.7): Short replace-whole dispatch convention, mechanics only. Methods are
  on-demand skills, optionally uninstalled; `hud_roster` returns current roles/convention.
- **D-2026-11-17-08** (§2.1.5): Close a settled worker as soon as main reads its report; an unread report
  keeps it until the idle deadline. Repair after closure is a new job; D-2026-11-21-06 adds automatic creation.
- **D-2026-11-17-09** (§2.2.1, §2.2.2): One standalone herdr sidebar via `/hud`. Retire Codex tmux panel,
  F12/Shift-F12, prefix keys and setting, gutter focus lock; keep tmux bar. Extend pi's output tokens/s to
  Claude and Codex.
- **D-2026-11-17-10** (§2.2.3): Include waiting items in Home question count; idle Home adds waiting items
  and newest landed slices above progress.
- **D-2026-11-17-11** (§2.2.4): To-try `y`/`n` records only in HUD home; main hears and edits STATE.
- **D-2026-11-17-12** (§2.2.2, §2.2.9): First a standalone Skills tab, then Help (`?`) the same day. That
  left Home and Project as the only main tabs until Control and EXP joined in D-2026-11-20-01. Wrap the
  full localized catalog description in the 40-column panel; display only. D-2026-11-22-03 drops the
  stale Skills tab wording from setup.
- **D-2026-11-17-13** (§2.2.2): PANEL-REDESIGN: Classic and Split (panel-v8 option 2). Split only departs
  from the Home/Project layout rules where the notes say so; never hide owner needs. See D-2026-11-18-08.
- **D-2026-11-17-14** (§2.3.2, §2.2.9): Second decision supersedes the same day's adapted-skills and
  MATT-PARADIGM decisions. Use HUD delegation, `to-tickets` slicing and one review per milestone. Turn
  off upstream plugin; keep adapted and verbatim backup collection inactive with upstream commit IDs, no
  tracking. Install `hud-handoff` beside HUD delegate/setup in all three. Later D-2026-11-20-03 moves
  `to-tickets` to MCP. D-2026-11-22-03 confirms Help for the catalog.
- **D-2026-11-17-15** (§2.3.3): Sync GitHub parent/sub-issues one way via `gh` to Project-format `.scratch/`
  for panel and workers; only the sync tool writes the mirror. Sync after each tracker write, no polling.

## 2026-11-16

- **D-2026-11-16-01** (§2.1.2): Ship `general`, global ad-hoc role with brief-defined work and per-job model.

## 2026-11-14

- **D-2026-11-14-01** (§2.1.2): Logical roles, ordered places with owner control and single-job harness choice.
  No per-harness/site names. `bro`, not Jev; distinct web `pro` seat. See D-2026-11-18-01 for refinements.
- **D-2026-11-14-02** (§2.1.5, §3): Exception to main deciding next steps: a quiet CLI job with no report
  past idle grace gets one Decision API choice, with confidence, key and error fallback. The fail choice
  requires a quoted quota/rate-limit message from the worker's screen. Only facts end a CLI job. No
  live-worker quit/failure from screen status, absent report or dead supervisor. See D-2026-11-22-10.
- **D-2026-11-14-03** (§2.1.6): Whatever the panel shows about a job reaches the dispatching session; panel
  and MCP share one reader. Return failure, response changes and watcher signal; command-watch lines and
  silent Codex queue. Later pi delivery in D-2026-11-18-06; task-client scope in D-2026-11-22-09.
- **D-2026-11-14-04** (§2.2.2, §2.2.4, §2.2.5): Project hub with per-page summaries originally including
  Control; project switcher with Home remaining local. PROJECT-UX A: Timeline Now/Latest, last seven days,
  ticket lanes. Control opens on attention and next place, healthy roles folded (`48002b18:docs/spec.md`).
  D-2026-11-22-02 confirms Control is not a Project page.
- **D-2026-11-14-05** (§5): 0.1.3 Project hub (`.scratch/project-hub/spec.md`); 0.1.4 roles apart from harnesses
  (`.scratch/role-bind/spec.md`).

## 2026-11-13

- **D-2026-11-13-01** (§2.1.3): Official interactive CLIs use herdr, model/effort/bypass only, preserve
  CLI config/session store. `hud trust <dir>` alone writes owner-chosen trust after backup under `$HUD_HOME`.
  Trust preflight and concurrency refined by D-2026-11-18-02.
- **D-2026-11-13-02** (§2.3.1): Conversational `hud-setup` modeled on claude-hud, explicit owner setup in
  `projects.json` before `.hud/` activates. Committed project roles; pi-only customization. Later CLI
  routing D-2026-11-20-08.
- **D-2026-11-13-03** (§5): 0.1.1 CLI workers/`hud trust`; 0.1.2 `hud setup` (`.scratch/hud-setup/spec.md`).
  Later D-2026-11-14-05; D-2026-11-22-07 adds 0.2.0 and version IDs in the ladder.
- **D-2026-11-13-04** (§2.4; *recorded*): One-command install/uninstall, core plus chosen extensions, using
  client registration commands where available.

## 2026-11-12

- **D-2026-11-12-01** (§2.2.1): Keep pi ribbon location and other extension statuses. Add BAR-THEMES on
  three bars plus ribbon, with unchanged default and one two-row opt-in (Stacked).
- **D-2026-11-12-02** (§2.2.3, §2.2.8): Decision API display labels only; Settings default OpenAI; no consent
  or authority layer. Default or model-ranked Recommended Home, never hide owner needs.
- **D-2026-11-12-03** (§2.2.3, §2.2.8): Native subagents from transcripts get Home lanes, nesting and model
  summary under the master switch. Drop agent log, card label and card summary settings.
- **D-2026-11-12-04** (§2.2.2–§2.2.5): Project at a glance: control plane (roles/models, convention source,
  key and browser availability), tree, docs, progress and tickets. STATE conventions, compact Home
  progress with card priority, and Control assignments/files with editor open. D-2026-11-22-02 separates
  Control from the Project hub.
- **D-2026-11-12-05** (§5): M4 follows open items without waiting on Matt's skills. Tickets stay empty until
  a later `to-tickets` slice. Freeze M4 at review, fixes, three last slices (panel self-reload after a new
  build, Settings model calls per feature, one test snapshot-update command), and release. New ideas go to
  M5 candidates, not M4.
- **D-2026-11-12-06** (§2.2.9): Changes keeps only Git/worktree summary, no file lists, diffs or previews.
- **D-2026-11-12-07** (§5; *recorded*): Unscheduled M5 retention, tail-first transcript on open and Advanced
  folding candidates, selected by the owner.

## 2026-11-11

- **D-2026-11-11-01** (§2.1.2, §3): Jev/Decision API is structured decision output, not browser work.
  Browser tasks use the shared browser; execution remains on existing runtimes.
- **D-2026-11-11-02** (§2.1.4): Single-job model/thinking override, named pi switches and raw extra pi args.
- **D-2026-11-11-03** (§2.1.5, §4): HUD, not main, starts and closes workers; `hud_close` closes early.
  Watcher starts on demand, listens to job-file/herdr events and exits after reaping the last open job.
- **D-2026-11-11-04** (§2.2.1–§2.2.3): Merge Home and Work, owner needs before package lanes. Hide finished
  jobs and older decisions after a short time; `a` reveals in place. D-2026-11-22-11 supersedes this for
  decisions only. Bottom bars always on and side panel only with `/hud`, delegation tools registered both ways.
- **D-2026-11-11-05** (§2.2.3, §2.2.8, §5): AI-THIN: small external model with owner's keys, job files in and
  display text out. Originally: decision titles ≤8 words from question and answer saying what was decided,
  and one sentence each on card, decision and result lines. D-2026-11-22-11 drops the decision display rules.
  Try real owner jobs and keep keywords scannable. Remove consent/authority (`src/core/materials`),
  "Job consent denied",
  progress only used by removed facade jobs, and text in hidden views (main recap, approval words, change
  summary, session title, `S` overview). Keep native-card text for NATIVE-TREE. Later visibility change
  D-2026-11-20-04 and worker summary/cadence change D-2026-11-22-01.
- **D-2026-11-11-06** (§2.2.9, §5): Keep Inspector (`v`), Settings and Help in Home's look. Delete old
  Timeline, Activity hub, Summary and diagnostics except model-call count in Settings → LLM. Remove old
  Agents pane after NATIVE-TREE; separate cleanup after ONE-PAGE. Drop Settings panel picture, Look presets,
  Nerd Font and emoji sets, motion switch, stack/tabs layouts, foot status card and rows only they used.
  Changes narrowed in D-2026-11-12-06.
- **D-2026-11-11-07** (§5; *recorded*): M2 right after M1 deletes R6b slice L, old role facade and its
  identity/release checks (replaced by the thin layer), old hud-mcp default managed surface and role-main,
  and their tests. M3 adds browser tasks and oracle.
- **D-2026-11-11-08** (§2.2.3; *recorded*): Optional package label from `hud_create`, else the brief title.
  Group lanes for display only; MCP does not interpret the label (`b94b5f00:docs/spec.md`).

## 2026-11-10

- **D-2026-11-10-01** (§2.1.1, §3, §5): Thin HUD, unbundled pi-roles; no upstream tracking for ours (ported
  claude-hud statusline, p10k-style footer). M1: repo `./install` core + Claude/pi/Codex, `hud uninstall`,
  MCP and skill registered in all three, `hud panel`, six tools for imp/reviewer/sonic via herdr, Claude
  parity and pi replacing p10k-footer. Owner installs and uses it.
- **D-2026-11-10-02** (preamble, §1; *recorded*): Original owner-draft date. One Linux/WSL user in herdr,
  one HUD across three clients, one boundary above concept and older decisions.
- **D-2026-11-10-03** (§3; *recorded*): No own execution platform, automation engine, adversarial/multi-user
  security, transactional installer, vendor pins, native Windows, publishing to npm or cross-machine use.
  D-2026-11-22-10 clarifies the scope of the process-supervision non-goal.
- **D-2026-11-10-04** (§4; *recorded*): Local owner trust, guard data/config loss and untrusted repositories
  only. Simplicity; no new guard/option/abstraction without a reason. Match prior speed; done is usable.
- **D-2026-11-10-05** (§6; *recorded*): Brief limits and milestone review. Owner trial is main review.
