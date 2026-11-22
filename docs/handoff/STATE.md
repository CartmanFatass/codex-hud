# State of the universal-hud effort (brought current 2026-11-18)

Milestone: 0.2.0 · MCP orchestration & Panel V2 (mcp-next + panel-v2)

Older sections (2026-11-03 to 2026-11-14: the R0–R7 queue, merge rules, review rounds, night logs) moved to
`docs/handoff/archive/STATE-2026-11-03-to-11-14.md`; the 2026-11-18 handoff to `docs/handoff/archive/STATE-2026-11-18-now.md`.
They are not current. Other historical records are indexed in [the documentation archive](../archive/).
Keep this file well under 64 KiB (the Project page reads only that much).

## Waiting for the owner

- Owner 2026-11-22 on agy's proposals 17–24: 17 do it (lean spec + archive old docs; spec-docs/01–03, spec lands
  only after the owner approves the draft and errata); 18 drop the self-graded outcome/verdict, do the rest: HUD-side
  summary fixes and an optional worker summary + file list (report-summary/01–03; spec updated; behaviour change approved); 19 restart recovery stays manual plus a guard so a resumed worker cannot use main-session tools
  (resume-guard/01); 20 at most proposal 13's single-job form; 21 `after` chaining dropped; 22 waits for 14; 23 web
  board server dropped; 24 deferred (at most worktree cleanup).
- Owner 2026-11-22 ("do as your recommendation"): lean spec draft approved with F-1..F-10 resolved as recommended (spec-docs/03); proposals 10, 11, 14, 15, 16 ticketed with their §6 defaults (settings-advanced/01, claude-tail-first/01, job-archive/01, worktree-overlap/01, place-health/01; 14–16 spec sentences approved, each lands with its slice); 13 `hud doctor` not now; 05 Q1 no models.json (primitives/04).

## Next

- MCP-ORCH tried live by the main session for the owner (2026-11-21); every original slice accepted. Two follow-ups to
  try after `/mcp` reconnect: FANOUT-TASK (dispatch a job, `hud_send({jobs:[it]})` while it works, the session is still
  woken at its report) and SONIC-AUTO-THINKING (a sonic job shows `thinking_source: default` at high; with the
  Settings toggle on, `decision`). Then the milestone's done check: a real project day compared with the 2026-11-21 study counts.
- CODE-HEALTH (owner 2026-11-21: run the docs/neon-proposal plans through imp): PRUNE-OBS-01..02, BUILD-DEDUP-01..02 landed; PRUNE-OBS-01..04 (neon 01 complete), TEST-SPLIT-01 landed; TEST-SPLIT-02, PROJECT-BOARD-LIMITS-01 landed; I18N-CHECK-01 and TEST-SPLIT-03 working. Proposals 10–16 (the rest of neon's report, reduced) wait for the owner to pick before tickets.
- Release rule: keep main fast-forwarded to universal-hud at each release (v0.1.4: tag and GitHub release with `hud-0.1.4.tar.gz`, sha256 33f0c04f…, 2026-11-14).

## Slices

<!-- One line per slice: `- <state> · <milestone> · <ID> · <what it is> (<commit>)`. States: working, blocked,
try (landed, the owner has not tried it), accepted (the owner tried it), todo, dropped. The Project tab's progress
board counts these; update at every landing or decision. -->

- try · CODE-HEALTH · PRUNE-OBS-01 · neon proposal 01 Slice 1: panel stops dead legacy observers (no herdr agent list), 15 files deleted, net −3,567 lines; retained assoc/native-relations records no longer show Home cards (owner-approved) (16892187)
- try · CODE-HEALTH · BUILD-DEDUP-02 · staged build: tsc output staged under a lock and published file by file, panel entry last; orphans pruned; `npm run clean` removes old packages/hud-mcp/dist (cba53a66)
- try · CODE-HEALTH · BUILD-DEDUP-01 · hud-mcp sources under src/mcp, one tsc build, ./install builds once; old packages/hud-mcp/dist only warned about (f9de5b72, 78df68dd); release archive drops .hud/ (c13ea5f2); live: fresh hud-mcp lists 11 tools, a sonic settled through the new worker paths
- try · CODE-HEALTH · PRUNE-OBS-02 · neon 01 Slice 2 plan A: Home no longer scans <workspace>/tmp/tasks; task-observations and pi-dispatch-status deleted, net −1,415 lines; CODEX_HUD_PANEL_ALL_DELEGATIONS now does nothing (72b01067)
- try · CODE-HEALTH · PRUNE-OBS-03 · neon 01 Slice 3: orphaned src/core and src/ledger observer modules deleted (15 files, 11 trimmed, net −1,906 lines), no visible change (7f695c5e)
- try · CODE-HEALTH · PRUNE-OBS-04 · neon 01 Slice 4: ARCHITECTURE §4.5 / reference name thin jobs + native trees as Home's only sources; guards fail if a removed module or a panel `herdr agent list` returns (89cb6963)
- try · CODE-HEALTH · TEST-SPLIT-01 · neon 09 S1: thin-mcp.test.mjs split into ten files behind tests/helpers/thin-mcp-harness.mjs, 175 cases kept; test:mjs 292 s → 71 s; teardown retries and one atomic test write fixed two flakes (e2c003de,46527cc5)
- try · CODE-HEALTH · TEST-SPLIT-02 · neon 09 S2: shared fake CLI bin, clock preload and atomic fixture writes for the MCP tests; role-places uses the shared harness; new npm scripts test:mcp, test:panel, test:fast (~10 s) (3eb0e02f)
- try · CODE-HEALTH · PROJECT-BOARD-LIMITS-01 · bug from neon 17: Project's latest review reads every docs/reviews entry (dated files only, README never wins); a STATE.md or spec past 64 KiB shows a truncation warning (23e6efbf; test flakes b588ac6b)
- try · SPEC-DOCS · SPEC-DOCS-01 · neon 17 Slice 1: 381 historical docs moved byte-identical to docs/archive/ (git mv), new docs/README.md and docs/archive/README.md, pointers updated, .rgignore hides docs/archive, empty ANALYSIS-REPORT.md deleted; kept docs untouched incl. spec (bf99226a)
- try · REPORT-SUMMARY · REPORT-SUMMARY-01 · neon 18 layer A: wake summary is the report's first prose line; sentence and outcome models see its head plus not-done/blocked/test sections (≤4 KiB); a settled card drops the running sentence and asks for its result at once; signature-bound report-meta helper (13899568)
- try · REPORT-SUMMARY · REPORT-SUMMARY-02 · hud_report (Claude, Codex, pi; hud-progress --done) takes an optional one-line summary and file list, asked for in the tool's own text (no role-text change); saved to report-meta.json bound to the report, before the done receipt; nothing reads it until 03 (9b888e4d)
- try · CODE-HEALTH · MONITOR-STATE-01 · neon 04 S1: one overlay state replaces seven modal flags; `/` filter, `g`, Control's Add back draft and stop confirmation survive (or delay) an automatic panel reload; dead MonitorState fields removed; frames unchanged (bfc8677d)
- working · MCP-ORCH · ORCH-LOAD · owner 2026-11-22: where a Claude orchestrator session's context and tokens go and how to cut them; general on agy gemini-4-carbon-high measures the orch transcripts (aggregates only, tmp/tasks/ORCH-LOAD/) and ranks HUD/workflow/config optimizations
- working · PANEL · DESIGN-HOME-PROGRESS · owner 2026-11-22: Home/progress/tickets visualization is poor, failed jobs float after a landed retry, waiting items ignore the zh setting, ticket/ledger states are hand-kept; general on agy gemini-4-carbon-high re-reviews and writes docs/design/home-progress/ (README + HTML sample); the owner picks before any build
- try · CODE-HEALTH · ASYNC-WATCH-03 · hud_create/hud_send answer at once even when herdr is slow (synthetic: create 4.4 s → 0.5 s, send 2.1 s → 0.06 s); a worker's other MCP calls keep answering while hud_ask delivers; `hud watch --queue` stops in ~0.3 s even if codex queue hangs (b8981a9f)
- try · CODE-HEALTH · ASYNC-WATCH-02 · hud_close on a CLI worker stops it in ~0.1 s even when herdr hangs, with no Decision API call; closing a worker's tab while it runs /quit records closed, not failed (f644b00a)
- try · CODE-HEALTH · ASYNC-WATCH-01 · one slow tab reap no longer holds up other jobs: while a synthetic 5 s reap runs, another job settles in ~0.1 s (was up to 135 s); stopping the watcher (SIGTERM) exits cleanly with no leftover reap or herdr process (e049e601)
- try · CODE-HEALTH · TICKET-FEATURES · the Project page and Home show every ticket feature that still has open tickets (before, only the first 16 folders by name, so new features like async-watch were missing); finished features fill the rest of 16 (d7d5b766)
- try · CODE-HEALTH · BUILD-DEDUP-03 · nothing to see in use: tests import the one shared dist/, so dist-test holds only the 40 compiled test files (was 524) and build:test no longer compiles the app twice (b32b4c45)
- try · CODE-HEALTH · MCP-SPLIT-04 · the panel looks and behaves exactly as before; tree-page.ts is now a 36-line entry over src/panel/* (controller, lifecycle, scheduler, actions, settings-flow, model-services, job-pipeline, agent-context); a running panel reloads into it by itself (c5032bc1)
- try · CODE-HEALTH · WORKTREE-OVERLAP-01 · hud_read of a worktree job lists files another managed worktree of the same checkout also changed (`git_summary.overlaps`; already-integrated changes left out) (d8443bbf); a hud_create cwd that does not exist is now refused as `invalid_arguments: cwd …` instead of a launcher ENOENT (571b9482)
- try · CODE-HEALTH · CLAUDE-TAIL-FIRST-01 · open a Claude session with a long subagent: its card shows the subagent's latest step at once, and the nesting fills in after (3a9b7166)
- try · AGY · AGY-ADAPTER-03 · in an agy main session, job events arrive by themselves: while agy works they are injected before its next model call; when it is idle they are typed into its prompt (an event right after a turn ends can take up to ~30 s); a resumed agy worker cannot use main-session tools (93471a3e)
- try · AGY · AGY-ADAPTER-04 · agy's bottom line is the HUD bar: model, context bar, project, and quota watermarks for the model's family (e.g. `5h 91% left  7d 98% left`); it answers in ~17 ms from a cache refreshed about once a second
- try · AGY · AGY-ADAPTER-01 · `./install --with agy` registers the hud MCP, the `mcp(hud/*)` permission, the HUD statusline and a (still empty) PreInvocation hook in agy's own config; `--uninstall --with agy` takes exactly those back out (83e4f931)
- try · AGY · AGY-ADAPTER-02 · an agy imp finishes with hud_report (its own one-line summary), can ask you questions and start sonic; if the tool is not loaded yet on its first turn it falls back to the shell command (9ce1fd81)
- try · CODE-HEALTH · SPEC-DOCS-03 · the lean spec is live: docs/spec.md 39.8 → 29.8 KB with history in docs/decisions-log.md; the ten open points settled as approved; the Project ladder now highlights 0.2.0 (faceafcc)
- try · CODE-HEALTH · MONITOR-STATE-04 · after a panel restart (build reload) Home and Project each come back to their own place; a panel from before this change still restores; v/f/Esc no longer rewrite hud-settings.json (603f8fd0)
- try · CODE-HEALTH · BUILD-DEDUP-04 · a HUD command, worker tool or panel that starts while main is being built waits (at most 15 s) for the publish to finish instead of crashing on half-new code; normal starts are unchanged (03da36da)
- try · CODE-HEALTH · MONITOR-STATE-03 · Home and Project each keep their own cursor, folds, filter and marks when you switch tabs or projects; Home's Split preview no longer changes Project folds; a panel restart still restores one shared place until MONITOR-STATE-04 (ee611bfe)
- try · CODE-HEALTH · RESUME-GUARD-01 · a worker resumed in its native session without its HUD job binding (claude --resume, codex resume, pi /resume) gets a refusal naming its job and the manual recovery (hud_create retry_of or a fresh tab) instead of delegating as a main session; normal main sessions see nothing (66401d79)
- try · REPORT-SUMMARY · REPORT-SUMMARY-03 · a settled job's worker summary (matching its report) is its result line at once, even with Model text off, no model call when in the panel's language; wake text, hud watch, changes and hud_read carry it; Inspector lists reported files when there is no git diff; `/` matches it (e200adcb)
- try · CODE-HEALTH · MONITOR-STATE-02 · neon 04 S2: Control and EXP own their tab state (Roles/Harnesses navigation, folds, notices); control-navigation.ts swap deleted; reload reads old and new handoffs; no frame change (acb85ffc)
- try · CODE-HEALTH · TEST-SPLIT-03 · neon 09 S3: test-only timing overrides (HUD_WATCH_SETTLEMENT_MS, HUD_PANEL_RELOAD_QUIET_MS, HUD_WATCH_DEGRADED_MS, HUD_PANEL_ADAPTIVE_MAX_MS, HUD_PANEL_CALLER_POLL_MS; defaults unchanged and tested); panel-reload and job-retention split; flaky caps raised to 30 s (3cab4219)
- try · CODE-HEALTH · I18N-CHECK-01 · neon 12: AST test fails on keys repeated across the three Chinese dictionaries, untranslated literal t() calls and placeholder mismatches; 19 overridden duplicates removed, words on screen unchanged (6cf14d7b)
- todo · AGY · Antigravity adapter (proposal 25; owner 2026-11-22: agy as orchestrator, worker and statusline; installer may edit agy config; delivery A+B): AGY-ADAPTER-01 install (landed 83e4f931), AGY-ADAPTER-02 worker MCP (landed 9ce1fd81), AGY-ADAPTER-04 statusline (landed) → AGY-ADAPTER-03 main-session delivery + resume guard (landed 93471a3e). Lane done; owner tries it. Possible follow-up: flush pending events on herdr's idle event instead of the 30 s rescan. Takes priority over the MCP lane's later slices
- todo · CODE-HEALTH · rest of neon proposals 01–09 in two lanes. Docs lane: SPEC-DOCS-03 landed (faceafcc); docs lane done. Panel lane: MONITOR-STATE-03 (landed ee611bfe) → MONITOR-STATE-04 (landed 603f8fd0) → CLAUDE-TAIL-FIRST-01 (landed 3a9b7166) → SETTINGS-ADVANCED-01 (after PRIMITIVES-04); MCP-SPLIT-04 (landed c5032bc1); panel lane done until SETTINGS-ADVANCED-01. MCP/bin lane: RESUME-GUARD-01 (landed 66401d79) → BUILD-DEDUP-04 (landed 03da36da) → TEST-SPLIT-04 (landed 58e7dfa2) → WORKTREE-OVERLAP-01 (landed d8443bbf) → BUILD-DEDUP-03 (landed b32b4c45) → ASYNC-WATCH-01 (landed e049e601) → ASYNC-WATCH-02 (landed f644b00a) / 03 (landed b8981a9f) → ASYNC-WATCH-04 focused review → JOB-ARCHIVE-01 → EVENT-WAITS-01..04 → PRIMITIVES-01..03 → PLACE-HEALTH-01 → MCP-SPLIT-01..03 → JOB-INDEX-01..04 (neon 08) → PRIMITIVES-04 (catalog). One milestone review at the end (install touched)
- try · MCP-ORCH · FANOUT-TASK · found in the live try: hud_send({jobs}) to a working job ends its MCP task ("no longer current") with no successor, so the main session is not woken at that report (88645374, test fix ee1bbf1e)
- try · MCP-ORCH · SONIC-AUTO-THINKING · owner 2026-11-21: callers never pick sonic thinking (role default high); optional off-by-default Decision API pick per sonic job (Settings row), fallback default; thinking_source recorded (f0baa540)
- dropped · MCP-ORCH · SONIC-THINKING · owner 2026-11-21: sonic's thinking chosen per sub-task from low/high/max by main session and workers; role file says what each is for; roster, hud_create, hud_sonic show it (7e9ef0b9) [superseded the same day by SONIC-AUTO-THINKING: callers do not pick]
- accepted · MCP-ORCH · RESTART-RECOVERY · CLI effort facts for haiku, claude-*-5-x ids and gemini-3.8-flash-high; legacy tmp/tasks admitted newest first; restart recovery itself not built (herdr resume strips HUD bindings; owner decision under Waiting) (bca6e312) [tried by the main session for the owner 2026-11-21: tests only; restart recovery itself stays an owner decision]
- accepted · MCP-ORCH · MCPORCH-FIX · milestone review findings (docs/reviews/2026-11-21-mcp-orch-milestone.md): pi hud_lease, registered-only standing brief, CLI effort facts, task-mode launch outcome and attention, repair during a check hold, deletions (c1572b5d; Fishpref d5e2a98 cherry-picked) [tried by the main session for the owner 2026-11-21: live run on the fixed build]
- accepted · MCP-ORCH · MCPORCH-07b · Claude Code main sessions get one MCP task per worker turn (2026-07-28 tasks extension, verified on 2.1.330): woken at report, question or failure without hud watch; /tasks cancel stops the worker (69da49a1) [tried by the main session for the owner 2026-11-21: live: dispatch, /tasks entry, wake at report]
- accepted · MCP-ORCH · MCPORCH-06 · hud_create checks: commands the HUD runs after the worker declared done, bound to that report's signature, stale on a new turn; shown in hud_read, hud watch and a panel chip (6f1bef38) [tried by the main session for the owner 2026-11-21: live: checks.json bound to the report signature, pass/fail in hud_read and hud watch]
- accepted · MCP-ORCH · MCPORCH-05 · hud_read({}) scoped to the project (linked worktrees included); a new session adopts jobs whose pane is gone, and their questions follow; restart recovery deferred (ticket 05 comment) (7accf14c) [tried by the main session for the owner 2026-11-21: live: hud_read({}) lists only MyHUD jobs; pane adoption by tests]
- accepted · MCP-ORCH · MCPORCH-03 · project .hud/brief.md referenced after the task in every brief; per-harness delivery text moves from the convention into tool results; convention sent once per session; panel titles come from the task part of the brief (4fa7b531) [tried by the main session for the owner 2026-11-21: live: standing brief after the task, delivery hint, convention_unchanged on the second roster]
- accepted · MCP-ORCH · MCPORCH-04 · hud_lease: named lease per project in both modes, waits inside the caller's turn, reclaims ended holders; Control lease row; leases shared by a checkout and its linked worktrees (45933319, ea9c4a19) [tried by the main session for the owner 2026-11-21: live: held_by, granted after release (36 s wait), Control lease row]
- accepted · MCP-ORCH · MCPORCH-02 · keys derived when omitted; hud_send to a read-closed job creates the repair job (continued_as); jobs:[...] fan-out; hud_create retry_of; a keyless identical call counts as a retry only within 10 minutes (623905b4, 80f1906b) [tried by the main session for the owner 2026-11-21: live: keyless retry same job, continued_as with brief+report refs, jobs fan-out sent/skipped]
- accepted · MCP-ORCH · MCPORCH-01 · a launch that fails before input falls through to the next place in one call; worker HUD home from the job directory (48809c12) [tried by the main session for the owner 2026-11-21: live: xhigh mapped to high and named; fall-through by tests]
- accepted · MCP-ORCH · MCPORCH-08 · settlement and report notices within 3 s arrive as one (hud watch, Codex queue, pi native); questions immediate (eca47d87) [tried by the main session for the owner 2026-11-21: live: three settlements in the same second printed together; framing by tests]
- accepted · MCP-ORCH · WORKER-MCP · workers get hud_report, hud_ask, hud_sonic, hud_progress (MCP and native pi); briefs and role texts carry no protocol paths; per-role sonic timing; unsupported thinking maps to the nearest level; failed pre-start launches close their tab and name the cause (64534c2c; Fishpref 66e24dc) [tried by the main session for the owner 2026-11-21: live: sonic workers used hud_report and hud_lease]
- accepted · — · HUD-TICKETS · to-tickets becomes the hud_tickets MCP tool (method, add, update, sync); skill links removed on ./install (48c9589d, 19d3fbd1) [tried by the main session for the owner 2026-11-21: live: hud_tickets guide returns the method]
- accepted · M3 · BAR-UNIFY · one-line bars on all three clients (d8945e22, 6f641d82)
- accepted · M3 · PANEL-POLISH · Enter opens a report, whole key hints, readable tab labels (e60d5bb7)
- accepted · M3b · AI-CORE-THIN · one master switch, one model, the call cap; consent layer gone (76bbf4c0)
- accepted · M3b · JOB-SENTENCE · a job card's line is one model sentence with coloured keywords (a89b220f)
- accepted · M3b · DECISION-RESULT · decision titles of at most 8 words from the model (b3fdd830)
- accepted · M3b · ENTER-TOGGLE · Enter expands in place; o opens the job's file (3a4d3114)
- accepted · M3b · CREATE-OPTS · hud_create takes pi launch switches (76a16393)
- accepted · M3b · STOP-CLEAN · a job stopped on purpose shows stopped and settles (f7671624)
- accepted · M3b · PANEL-OPEN · no notification burst on open; the panel closes with its caller (a020f254)
- accepted · M3b · M3B-FIX · milestone review findings (26d8adcb)
- accepted · M3b · HUD-SEND · hud_send queues a message for a working pi job (0fb4c042)
- accepted · M3b · JOB-SCAN · job scans reuse each file's parse (aa47181b)
- accepted · M3b · PERF-MCP · hud_read reads only STATUS and receipts (5ac1ee5c)
- accepted · M3b · PERF-BARS · statusline and pi footer skip needless work (476bed9f)
- accepted · M3b · ONE-PAGE · Home and Work on one page; a shows hidden cards (9e54af8b)
- accepted · M3b · PI-BAND · the p10k ribbon back in pi's top border (75519c63)
- accepted · M3b · CLEANUP-VIEWS · Timeline, Activity, Summary, diagnostics gone; Changes summary only (a0357f7e)
- accepted · M3b · PAGES-BUILD · Inspector, Settings, Help, Changes in Home's look; Bar style row (8a042817)
- accepted · M3b · BAR-THEMES · six bar themes on all bars and the pi ribbon (26eccfa7)
- accepted · M3b · SETTINGS-TRIM · four Settings rows deleted (34e10e0e)
- accepted · M3b · BAR-TIMES · same-name subagent notices collapse into ×n (25a74bb4)
- accepted · M3b · PANEL-BACKOFF · a quiet job-only panel backs off to 5 s (42d27f06)
- accepted · M3b · NATIVE-TREE · native subagents on Home, one lane per main session; old Agents pane goes (86f91368)
- accepted · M4 · M4-PROJECT · the Project tab (841cc06f)
- accepted · M4 · PROGRESS-BOARD · the Project tab's progress board: ledger bar, chips, slices in flight, drift marks (8716dcc5)
- accepted · M3b · OPEN-TAB · opening a file from the panel uses its own herdr tab, not a split pane (c3d49420)
- accepted · M3b · CLAUDE-BIND · hud panel finds the caller's Claude session via herdr pane current at open time;
  nothing stored per pane (owner: pane ids are dynamic) (968b0f27)
- accepted · M3b · CARD-DETAILS · newest card expanded, others folded; keywords colour files, stances (approve, object,
  reject) and opinions (6c9cb40b)
- accepted · M4 · TICKETS · the Project tab's Tickets section from to-tickets' .scratch tracker (6364ddad)
- accepted · M3b · M3B-REVIEW2 · the closing M3b two-axis milestone review (Sol xhigh + DS max): changes-required, 2 blocking keys (docs/reviews/2026-11-12-m3b-review2-*)
- accepted · M3b · M3B-FIX2 · the closing review's fixes: Codex Ctrl+\ 2, Settings s/t, dead code, docs (c283e7ea)
- accepted · — · PI-STOP · hud_close stops a working pi job in seconds, not after a 30 s wait (Fishpref 38447ef)
- accepted · — · LEGACY-SKILLS · herdr-delegate, herdr-delegate-codex, pi-subagent retired to Fishpref (6bd0ef8)
- accepted · M4 · NP-01 · native-polish 01: nested Claude subagents always sit under their parent (e295a0a9)
- accepted · M4 · NP-02 · native-polish 02: a resumed Claude subagent shows running again and gets a fresh result (a5a3e6a4)
- accepted · M4 · NP-03 · native-polish 03: Chinese keyword marks colour instead of showing brackets (746971eb)
- accepted · M4 · NP-04 · native-polish 04: HUD job cards show a short title (eb3e5558)
- accepted · M4 · NP-05 · native-polish 05: live /hud binding check and CLAUDE-BIND leftovers (live check passed; Fishpref pi-roles fixed)
- accepted · M4 · GEMINI-DECIDE · Gemini Decisions API provider + Settings switch; default primary OpenAI (Jev pages too heavy for the free tier), 429 cooldown (fe3aed6c)
- accepted · M4 · DL · decision-labels 01–06 in one slice (owner): outcome, kind, model fit, looping mark, question category, review severity (f52c4106)
- accepted · M4 · HOME-PROGRESS · Home shows a compact progress board and open tickets in its spare rows (owner) (2de1e8a7)
- accepted · M4 · LIVE-FIX · live-check bugs: active job shown stalled; finished subagents briefly running on open; «--flag» read as reject (445689e9)
- accepted · M4 · HOME-LAYOUT · m4-close 01: Home's progress block layout (frontend-implementer) (426dbc02)
- accepted · M4 · THEMES · m4-close 02: each theme its own board inks; refined terminal; new arctic, ember, contrast, paper (frontend-implementer) (6f9a079f)
- accepted · M4 · ROW-FIX · native rows keep one order; a growing transcript counts as activity (no false 停滞); running cards drop the flipping tool name (66f37e57)
- accepted · M4 · CARD-HEIGHT · owner: Home cards are title + two fixed sentence rows (sentence ≤30 zh chars / 16 words); only the newest current result opens by itself (c1647299, aca06c54)
- accepted · M4 · HOME-RECOMMEND · m4-close 08: Settings Home mode Default | Recommended (Decision-API ranking) + progress brief on top; addendum: Decision API own ledger + cap row (default unlimited), unlimited LLM cap option, 5-min summary floor, no kind backfill (owner) + Summary interval setting (e21b0a6b)
- accepted · M4 · PANEL-WIDTH · owner: Settings Width applies to Claude/pi herdr panels too (open at it, live resize), row moves to Panel (6c89eb09)
- accepted · M4 · DECIDED-LOCALE · owner: Decided for you shows question/answer/instead/why in the Settings language (one lite DS call, effort none) (30da9cd7)
- accepted · M4 · BAR-FIDELITY · m4-close 07: the six bar looks match their approved concepts (inks, spacing, idioms) (frontend-implementer) (2e2b2650)
- accepted · M4 · HOME-TIDY · owner: Model fit removed from Project; Home's progress block sits at the bottom of the spare rows (42e8bcc5)
- accepted · M4 · OAI-RUNNING · decision labels follow the Settings choice (default OpenAI, owner); running Claude subagents visible again (meta without finished) (5d0e54aa)
- accepted · M4 · SETTLE-FIX · closing an idle job no longer resets its 完成 age and re-asks its outcome label (8ada150e)
- accepted · M4 · CARD-FOLD · owner: settled cards fold to one line after 5 min, hide into `a` after 15 min; both in Settings (frontend-implementer) (b9597884)
- accepted · M4 · SNAPSHOTS · `npm run snapshots:update` rewrites every frame snapshot (51d16a29)
- accepted · M4 · PANEL-RELOAD · owner: the panel restarts itself after a new build, keeping its place (0d160038)
- accepted · M4 · CALL-BREAKDOWN · owner: Settings shows this hour's calls per feature, LLM and Decision (209d2c58)
- accepted · M4 · M4-REVIEW · m4-close 04: whole-project review (Sol xhigh + DS max on 3b17f7a0): changes-required, Sol 4 major, DS 2 major + 4 minor (docs/reviews/2026-11-12-m4-review-*)
- accepted · M4 · M4-FIX · m4-close 05: the review's behaviour findings (brief independence, statusline default, bounded job scan, settings guards, TZ, docs) (8cd38f1e)
- accepted · M4 · M4-PRUNE · m4-close 05: delete the unreachable retired ledger/supervision/runtime, dead modules and the historical installer chain (769cfa3d)
- accepted · M4 · SESSION-LINK · owner: pi session history stays in pi's default place; job directories only link to it (23a9782d; Fishpref 45d93a1)
- accepted · M4 · RETENTION-SAFE · 377ecb69 · the job watcher moves real pi session files to pi's store before deleting a job directory (imp; review-3 q1 ruling)
- done · M4 · M4-REVIEW3 · Sol changes-required (1, fixed by RETENTION-SAFE), DS accept (2 minor) · docs/reviews/2026-11-12-m4-review3-*.md
- accepted · M4 · M4-FIX3 · 6a27a421 · round-3 leftovers: dead Claude facade modules, font env row, reap before delete, doc drift
- done · M4 · M4-REVIEW4 · Sol accept, DS changes-required (watcher dies on a link loop) · docs/reviews/2026-11-12-m4-review4-*.md
- accepted · M4 · M4-FIX4 · 8dd1703a · watcher survives a session link loop and a failed fs.watch; retention optional notes
- done · M4 · M4-REVIEW5 · Sol and DS changes-required (watcher dies on the normal .dispatch/current.json receipt) · docs/reviews/2026-11-12-m4-review5-*.md
- accepted · M4 · M4-FIX5 · 88c048da · watcher: .dispatch receipt file, per-job containment, degraded polling with a pending deadline, watch retry
- done · M4 · M4-REVIEW6 · both changes-required (open job lost on a housekeeping error) · docs/reviews/2026-11-12-m4-review6-*.md
- accepted · M4 · M4-FIX6 · 2d0fed42 · session housekeeping errors no longer hide an open job; watch retry only on the timer; log rate limit
- done · M4 · M4-REVIEW7 · Sol accept, DS accept (4 optional) · docs/reviews/2026-11-12-m4-review7-*.md
- accepted · M4 · M4-FIX7 · 77500308 · round-7 follow-ups; CI runs only existing scripts on Node 24; fixture idents
- accepted · M4 · RELEASE-DOCS · 1ec6e0ef · shipped docs describe today's HUD; Node ^22.13.0 || >=24 in engines + install preflight
- done · M4 · M4-REVIEW8 · Sol changes-required (2 doc), DS accept · docs/reviews/2026-11-12-m4-review8-*.md
- accepted · M4 · RELEASE-DOCS2 · b622a7ba · round-8 doc fixes, short ja/ko READMEs
- done · M4 · M4-REVIEW9 · Sol accept, DS accept · docs/reviews/2026-11-12-m4-review9-*.md
- accepted · M4 · IMPORT-TOML-CUT · owner: `hud import` refuses old jev-ask TOML; only settings JSON and .env sources
- accepted · M4 · CX-CONTINUE-CUT · owner: cx-continue/ and its CI job removed (never shipped)
- accepted · M4 · RELEASE-ARCHIVE · c00936e4 · npm run release + offline install rehearsal (test:release); Node floor 24
- accepted · M4 · REVIEW10-OPT · 4995d308 · round 10 both accept; optionals fixed; release candidate built (sha256 d764c336…)
- done · M4 · M4-ARCH · Release: blocked (1: repo Git filters run from the Codex bar and pi footer) · docs/reviews/2026-11-12-m4-architect.md
- accepted · M4 · GIT-SAFE · 76e2ba8b · one safe Git policy (src/utils/git-safety.ts) for Claude, Codex, pi footer, Project, Changes; submodule working trees not probed
- accepted · M4 · PANEL-SCOPE · owner: a panel shows only HUD jobs that settle while it is open; the open time survives reloads (9b9ea418)
- accepted · M4 · JOB-RETENTION · owner: the job watcher deletes a settled job directory one day after it closes (71801be1; existing 99 pi sessions moved to ~/.pi/agent/sessions and linked first, toktrack totals unchanged)
- accepted · M4 · M4-REVIEW2 · re-review on 3280cc02: changes-required; Sol 3 major (reload place, reload width, retired host/bridge left), DS 1 major + 3 minor (docs/reviews/2026-11-12-m4-review2-*)
- accepted · M4 · M4-FIX2 · re-review fixes: reload keeps place and width in bound panels; brief persists across sentence changes (152db34b)
- accepted · M4 · M4-PRUNE2 · re-review: delete the remaining retired runtime exports and host/bridge; docs and READMEs that describe deleted things (0871f74d)
- accepted · M4 · INSTALL-EXT · owner: ./install gets the browser and herdr extensions of spec §2.3 (96deabe9)
- accepted · M4 · RELEASE · m4-close 06: one release archive with ./install; merged to main, tagged v0.1.0 (ccc447be)
- dropped · M3b · BAR-PHOSPHOR · bar themes Phosphor and Pill Rail (owner: not built)
- accepted · 0.1.1 · CLI-WORKERS · owner 2026-11-13: roles on interactive CLIs (grok, agy, claude, codex) through herdr, held to pi imp's lifecycle; harness behaviour and session places untouched (.scratch/cli-workers/, 7 tickets all done with grok-4.7 high; real E2E passed on all four CLIs) (cbe059a7)
- accepted · 0.1.2 · HUD-SETUP · owner 2026-11-13: `hud setup` (skill asks, command writes) deploys a project's pi workers: roles shown/hidden, pi role tuning, worker skills linked under .hud/skills, worker prompts; other harnesses unchanged (.scratch/hud-setup/, 6 tickets all done with grok-4.7 high; real pi job in a set-up project got its skill and worker prompt; owner to try /hud-setup) (fca81428)
- accepted · 0.1.3 · PROJECT-HUB · owner 2026-11-14: Project hub with progress, tickets, working tree, docs and control-plane pages; project switch and projects list (.scratch/project-hub/, 4 tickets); landed 5951a489, 682dec52, 162e8b1c, a20019d4; review b0e6d0f2 → FIX-013 6359b958; re-review accepted by both
- accepted · 0.1.4 · ROLE-BIND · 01–05 (5b0d5b37 … b56129ce) · owner 2026-11-14: a role is the work; places and fallbacks switched in the control plane; bro harness; grok/agy/claude/codex-imp, argon, gemini, flow-video deleted (.scratch/role-bind/, 4 tickets; 03 landed 19333df8; 04 running)
- accepted · 0.1.4 · CLI-NOREPORT · 6f4afa7c · cli-workers 09: the report, not herdr's done, ends a CLI turn; no report → ask the main session; observe only, never prompt or quit for it
- accepted · 0.1.4 · SUPERVISOR · owner 2026-11-14: only facts end a CLI job; the session hears what the panel shows (.scratch/supervisor/, 8 tickets; 01–05, 08, 09 landed and checked live)
- accepted · 0.1.4 · QUIET-DECIDE · 2117e2b5 · cli-workers 10 (real run passed): a quiet CLI job without a report gets one Decision API choice among fixed actions
- accepted · 0.1.4 · REVIEW-014 · grok + DS changes-required (0d24ed0f), fixed a2b2b033, 7bd5e175, 86007c37; re-review accept · docs/reviews/2026-11-14-014-*.md
- accepted · — · SKILLS-UX · owner 2026-11-17: Skills tab redesign within spec: section header with count, intro line, aligned name column, word-boundary truncation (Sonnet frontend imp)
- accepted · — · ROLE-PRESETS · owner 2026-11-17: named presets per role, c/C on the control plane applies the next/previous; architect folded into oracle; imp default/grok/hydrogen, reviewer default/pi, oracle fable/architect; glm-imp removed (backup ~/.hud/backups/roles-2026-11-17) (spec 070d6b6e, landed from bc5a5761)
- accepted · — · HUD-HANDOFF · owner 2026-11-17: hud-handoff installed for Claude and Codex (9a077fd2)
- accepted · — · SKILLS-READ · owner 2026-11-17: Skills descriptions wrap in full under the name, readable at 40 columns (spec f996b63f; landed from 957997cc)
- accepted · — · SIDEBAR-ONE · owner 2026-11-17: one standalone herdr sidebar for every client with mouse (click tab/row, second click = Enter, wheel, crumb back); Codex /hud skill; Codex tmux panel (F12, prefix keys, gutter lock, prefix setting) retired, tmux bar kept (spec 0cb19f5a; landed from 917fc152). Live mouse through herdr in a real terminal not yet verified
- accepted · — · PANEL-TIDY · owner 2026-11-17: Home and Project hub display fixes from a live read; .scratch/panel-tidy/: 01 Home truth (565022bc), 02 hub wraps waiting items, Now without unlisted worktrees, ▒ for to try (759b8688), 03 Skills in Help, two main tabs (2ee8d597)
- accepted · — · BAR-NOTICE · owner 2026-11-17: bar notices name the work, not the model; .scratch/bar-notice/: 01 role + title, run time, no model (41db1271), 02 pinned need names the job, first +N then N needs; HUD jobs boxed [◐] vs subagents ◐; unread report dot [✓●] while the item shows (37cc5478)
- accepted · — · PANEL-NEXT · owner + architect 2026-11-17: .scratch/panel-next/: 03 control-plane place preview + Inspector run time (ee4bc94f), 01 read one try in place (7c96e9af), 02 Progress to-try filter, t/Enter/click (6c514fdb)
- accepted · — · WORKER-CLOSE · owner 2026-11-17: a live child process means a CLI worker is still working (agy background/daemon commands, verified live twice); a settled job closes once its report is read (option A); .scratch/worker-close/: landed: 01 c4ac0183, 02 a25fca5c, 03 review fixes af6e0e85 (only children started in the current turn count, so MCP servers do not pin Claude/Codex workers); review + re-review docs/reviews/2026-11-17-worker-close-review.md; follow-up note on 03 (partial reap failure leaves a tab)
- accepted · — · CODEX-MIDNIGHT · native-tree Codex caller test failed 00:00–08:00 UTC: fixture wrote the UTC-date dir but the spawned panel ran in local TZ; fixture only, no product bug
- accepted · — · STATUSLINE-TPS · owner 2026-11-17: `~N t/s` on Claude's statusline and Codex's bar (a `tps` bar field, dropped early when narrow), like the pi footer (spec); .scratch/statusline-tps/ (imp; full suite 679/679) (082bc807)
- dropped · — · ORACLE-SKILL · owner 2026-11-17: oracle loading an adapted codebase-design dropped with MATT-OFF; then oracle became the strongest-model seat with no default skill, a brief names a method skill by path (SKILL-ROLES); the imp's work (dacf135e, worktree and branch wt/ORACLE-SKILL deleted) never landed
- dropped · — · MATT-PARADIGM · owner 2026-11-17 chose paradigm B (report docs/reviews/2026-11-17-matt-paradigm-oracle.md), then superseded the same day by MATT-OFF
- accepted · — · WORKER-UNIFY · owner 2026-11-17 decided (all of the main session's recommendations, plus: workers call sonic freely, choosing its thinking, without blocking): one worker form on every harness; spec §2.1 "Workers are neutral" rewritten; .scratch/worker-unify/ (spec + 4 tickets): 01 worker marker, MCP refuses dispatch from a worker; 02 `hud-sonic` start/wait (non-blocking, parallel, parent unsettled while a child is open); 03 HUD-run pi jobs use the HUD role text, no call_sonic/call_reviewer, one question rule; 04 delete dead execution code (oracle report §A5). Landed ahead of the tickets: browser completion no longer typed into the main pane, empty browser report fails, general.md report wording (main session); 01 landed e19d45ac (live check with 02); 04 landed (2035 lines of dead routing/slot/receipt/writer code deleted; PI_ROLE_DEFAULTS was dead too, so MODELS-6.2 matters only in pi-roles); 02 landed cf98727b (+ test fixes; pi parent gating moved to 03); live check passed 2026-11-17 (Claude worker: hud_create refused, hud-sonic start/wait 13 s); 03 landed 8609817e + Fishpref bd18067 (pi jobs get the HUD role text, no call_*; sonic child settlements stay quiet; live check passed: pi imp ran hud-sonic start/wait in parallel); milestone review docs/reviews/2026-11-17-worker-unify-milestone.md: repair (a textless pi role still got call_reviewer; worker tabs lacked HUD_HOME; RoutingError leftover; sonic.md limits); fixes landed d5e313f4 + Fishpref 86ce242 (HUD mode keyed on --hud-sonic-jobs, every worker tab gets HUD_HOME, sonic.md limits back); full suite 85+648 pass
- accepted · — · PANEL-TRY · owner 2026-11-17: on Progress's to-try view `y` accepts, `n` flags a milestone or slice; the panel writes only $HUD_HOME/tries.jsonl, the main session updates STATE from the watch line (spec §2.2); .scratch/panel-try/ 01; landed c1f0ca2d
- accepted · — · BAR-NARROW · owner 2026-11-17: the bottom bar is cramped beside the 40-column panel (main pane 144 of 184); frontend-imp designs the fit at 144/120/100/80, one line, no new fields; landed 3ada49ad: numbers before words, notices give up titles first, rate kept, loaded counts go first
- accepted · — · PANEL-REDESIGN · owner 2026-11-17: Home carries too much, Project's UX is poor; three options rendered (docs/design/panel-v8/, f6360c9a); owner: build 1 Inbox and 2 Split as Settings layouts beside Classic, try both, keep one (spec §2.2 Panel layouts); .scratch/panel-redesign/ 01 Inbox + setting, 02 Split; 01 landed 98df0c4e (Classic's Home/Project frames unchanged; Inbox drew a settled job as `done` with no sentence, page facts from pageSummary); 02 landed 31dd4035 (merged over 01 by the main session; Split's previews reuse Classic's row builders; the hub's To try list scrolls instead of showing two; no Split for the waiting page). owner accepted the try and kept Split (2026-11-18); 03 and 04 working
- accepted · — · SUPERVISOR-FIX · owner 2026-11-18: a CLI job settles after its report even when npm-launched MCP servers finish starting after the first turn (any npm exec/npx/uvx/pnpm dlx → sh -c 'bin' → bin chain); a stop racing a tab close records stopped; a failed worker cleanup is retried; a refused hud_send opens no turn; hud watch keeps Node's SIGPIPE default (1c4530ce, 32e26e4f, 8a43ed40)
- accepted · — · GENERAL · owner 2026-11-16: `general` role for ad-hoc dispatch, model/thinking per job (cb0d67a9; pi-roles general.md in Fishpref)
- dropped · — · MATT-FLOW · owner 2026-11-17: the convention keeps only HUD mechanics (a convention absorbing Matt's flow was written and reverted the same day); hud-build no longer installed (MATT-OFF)
- accepted · — · MATT-OFF · owner 2026-11-17: Matt skills are an inactive collection taken on demand; the HUD flow is delegation.md (to-tickets + one milestone review). Only to-tickets installed (Claude, Codex); grill-with-docs, to-spec, hud-build, tdd, diagnosing-bugs moved to integrations/skills-optional/ and listed in the Skills tab; global links and JevDev's pi-worker links removed
- accepted · — · SKILL-ROLES · owner 2026-11-17: only to-tickets is in the HUD flow (ticket management and boundaries; spec gaps become owner questions, tickets held); oracle is the strongest-model seat for any read-only judgement (oracle.md, Fishpref architect.md); frontend-imp designs and builds UI; pro research asks for cited primary sources; hud-delegate defers brief contents to the convention; the remaining Matt skills (wayfinder, triage, improve-codebase-architecture, wizard, teach, wait-what, writing-for-agents, to-questionnaire, prototype, retro, pr, codebase-design) copied verbatim into skills-optional; delegation.md role table matches hud_roster
- accepted · — · ARCH-ALIAS · owner 2026-11-17: hud_create takes `architect` for `oracle` unless a role file defines its own; spec rule: an agent edits docs/spec.md only after telling the owner the change and the reason; spec §2.3 lists the verbatim skills-optional copies and oracle as the strongest-model seat with no default skill; pi extension reinstalled (hud-setup linked)
- accepted · — · MODELS-6.2 · owner 2026-11-17: sol and astra are 6.2: pi-roles implementer/reviewer → openai/gpt-6.2-sol, architect (oracle presets) → openai/gpt-6.2-astra (Fishpref pi-roles); HUD's PI_ROLE_DEFAULTS match
- accepted · 0.2.0 · MCP-NEXT · high-throughput MCP orchestration: fine-grained locks, pre-flight trust, parsed quota TTL, preset dispatch, hud_wait, pi native watch, zero-copy context, hud-progress/hud_peek, managed worktree isolation (.scratch/mcp-next/, 7 tickets)
- accepted · 0.2.0 · PANEL-V2 · panel micro-actions (g/QA reply/X), Split V2 cues/ratio/scrollbar, live / filter, sparklines + sonic subtrees, safe --numstat diff bars, Control quota radar, static HTML board (.scratch/panel-v2/, 7 tickets)
- accepted · — · MCP-READ-COMPACT · compact actionable `hud_read()` list; `view:"recent"` retains the newest 20 full rows (separately scheduled, `.scratch/mcp-read-compact/issues/01-compact-hud-read.md`); landed e629b295 (default 327 B vs recent 4,475 B, −92.69%)
- accepted · — · SUPERVISOR-MCP · bug 2026-11-18 (live, Claude frontend-imp): a CLI worker stays `working` after its report when its CLI started an MCP server directly (`node …/hud-mcp`) just after the first input; cli-judge counts it as turn work (spec §2.1: MCP servers do not count); landed 2d281b7b: on the first turn a direct non-shell child started within 10 s of the first input is a launch helper (shells and later children still count); live check passed 2026-11-18 (panel-v2 04 frontend-imp j9dbc6abfd9f248a6 reached idle_grace on its own after its report)
- accepted · 0.2.0 · PANEL-UX-01 · to-try rows read as briefs; counts agree; number keys leave the tabs (f = Changes); direct `1–4`/`d` answers; no divider drag (f287d6e1)
- accepted · 0.2.0 · PANEL-UX-02 · one meaning per key (n flag, > < next question, i/Del places, g job tab); state said once; 40-column rows keep model names; zh words (用量, JSON 无法解析) (b1b4c8eb; job-sentence JSON fix 8e384387)
- accepted · 0.2.0 · PANEL-UX-TITLES · ticket titles cut at a word, never inside one (imp neon) (1234b2a0; clamped sentences 9d60eec7)
- accepted · 0.2.0 · PROJECT-LAYOUTS-01 · Settings → Panel → Project layout (Timeline | Board | Inbox); the Board layout (imp neon) (f9aa6dda)
- accepted · 0.2.0 · PROJECT-LAYOUTS-02 · the Inbox layout: Needs you first, Running, Progress by To try; Project tab only (imp neon) (8b0aba6c)
- accepted · — · EXP-01 · experimental EXP tab behind Settings → Panel → Experiments (实验功能): Codex, pi proxy and API grant settings; readings say 未接入 until 02–05 (imp) (2cc3760c; test fix 1f10549a)
- accepted · — · EXP-02 · Codex native status line: hud-mcp serves a compact MyHUD row (model, context, quota, pane's HUD reminder); pick it in Codex /statusline; codexH bar unchanged (imp) (b0801952)
- accepted · — · EXP-03 · pi subscription proxy: bind a Codex profile in EXP; pi footer on openai+OAuth shows its 5h/7d windows (≈), refreshed only while a pi footer draws (no timer) (imp) (67811752)
- accepted · — · EXP-04 · oapi grant ledger: per-request cost JSONL (dedup), balance on read, pi footer on oapi shows API ≈$; EXP openai-api rows live (imp) (feb9893b)
- accepted · — · EXP-05 · Anthropic API grant ledger: only API-key routes count; footer shows the current route's reading among proxy / oapi / anthropic (imp) (7dc40a59)
- accepted · — · CONTROL-TAB-01 · Control as its own main tab, Roles landing per the sample (imp) (1e6334dd; test fix 1446ff59)
- accepted · — · CONTROL-TAB-02 · harness switches end to end: Harnesses view (h), disabled IDs in harnesses.json, one shared chain evaluation for panel/roster/create; off overrides refused (imp) (74810834)
- accepted · — · CONTROL-TAB-03 · full pi model picker (m on a place): every model of the providers that are on, grouped, typed filter, discovery on open/r only; include curation removed (imp) (550da5a8; flake fix hud-watch)
- accepted · — · CONTROL-TAB-04 · presets on the role row: c/C switch, p list, N copy / R rename / D delete with preview; active_preset + hidden_presets, project roles locked (imp) (41dd0030)
- accepted · — · MODEL-PICKER-01 · picker model facts (ctx/out/think/img from the same pi --list-models call), strip, ✗/⊘/? row facts, off-provider line, ^R, Esc clears filter first (imp) (b1d81f98)
- accepted · — · MODEL-PICKER-02 · clickable [model ▾] on editable pi/cli places (locked rows plain, Flow keeps m), pinned current + this role's preset models, folded groups open on typing, mouse select/set/wheel/header fold (imp) (094c514a)
- accepted · — · MODEL-PICKER-03 · picker zooms the panel's herdr pane (--on; --off only if it zoomed), 120×36 list with pi columns + read-only detail (used by, off provider), narrow below 100 cols / outside herdr / refused (imp) (a43f4bef)
- accepted · — · CONTROL-TAB-05 · direct chain editing: Enter focuses the chain, I empty draft, i one-sheet add (target/model/thinking, picker for pi), K/J/Del, s one atomic save + select, Discard edits?; p/P, e/E, M cycling and auto fallbacks removed (imp) (011bf261)
- accepted · — · PI-ASYNC-HUD · pi main session gets HUD notices natively: steer at the next model boundary, idle wake, draft untouched, session fence (pi imp) (86445c1f; merged f7fcd0fa; Fishpref worker async ask 5e4b6d8 on main 2026-11-20)
- accepted · — · HUD-MCP-LEAN · lean roster (convention_version, detail), compact job read and peek, shared tool definitions; report notice never reads (pi imp) (32686bf1; test fix c748433f; merged f7fcd0fa)
- done · — · REVIEW-CONTROL-EXP · review on 2e4b45d3: changes-required, 5 blocking (EXP-02 native bar never reaches EXP, EXP-03 7d dropped, EXP-04/05 duplicate ledger lines, draft rows lose [model ▾], focused chain lacks provider unknown) · docs/reviews/2026-11-20-control-exp-review.md
- accepted · — · REVIEW-FIX-CONTROL-EXP · review fixes: native bar seen per Codex profile (EXP switch = tracking), pi footer 5h + 7d (≈ for proxy, second window dropped only when narrow), ledger one line per event ID on disk, draft rows keep [model ▾], focused chain says provider unknown; superseded immediate-edit paths deleted (imp) (5d39de2c; 86+853)
- accepted · — · NO-DEFAULT-LABELS · Control drops [default]/[Custom] tags; unset model/thinking show the effective value muted ([▾] / blank when unknown); picker's clear row says role's model (…) / clear; no-selector choice is "file chain" (imp) (aeb74f31; test fix) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-01 · pi footer quota in Claude's style: bar, % used, level colour, reset; ≈ estimate, ? stale, ↻ pending; API grant bar (imp sol) (4bdb9207) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-02 · m on a role row (or place) → pick → saved at once; multi-place edits stay a draft (imp sol) (40fc5585; merge test fix 6401c781) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-06 · one footer rule: row actions, Enter verb, Esc, page actions, ? help last; no movement keys; ? opens Help over Settings (imp sol) (4a0a4d2f) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-03 · picker opens in the panel's own pane, no zoom, one click sets, two columns from 100 cols (imp sol) (6598afa1) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-07 · Project hub, Progress and question slabs say a fact once (imp sol) (ca6d86b5; test 339fac37) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-08 · Help grouped by tab (Everywhere, Home, Project, Control, Split, Marks), opens at the current tab (imp sol) (dec80c71; tests ab8c9a2e) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-09 · EXP in the panel's form, choices listed (imp sol) (3c001661) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-10 · Harnesses rows show exceptions only (imp sol) (9b19ec26) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-04 · likely models first (current, presets, providers the roles name), ranked flat filter, `was` row for the last quick save (imp sol) (808c57ac; tests after it) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-11 · top row: no models on / EXP exp, Esc stays on root tabs, 分, Split lane says subagents (imp sol) (123a9b9f) [owner accepted without a separate try, 2026-11-21]
- accepted · — · PROJECT-CLI-PLACES · a registered project's role chain may name CLI places (agent, model, thinking; no args, no bro); hud setup plan `runs`, skill asks (imp sol) (d13a16a6) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-05 · CLI and AI Studio places open the same picker, flat; the inline quick list is gone (imp sol) (2ebfb5f2) [owner accepted without a separate try, 2026-11-21]
- accepted · OWNER-VIEW · OWNER-VIEW · Decided for you hidden (still collected); to-try rows grouped per milestone task by default, Settings → Acceptance switches to per slice (imp sol) (cf70780d; tests after it) [owner accepted without a separate try, 2026-11-21]
- accepted · OWNER-VIEW · OWNER-VIEW-2 · Tickets per feature and Progress per milestone at task detail (Settings → Detail/粒度); Home commit dates cached by hash; decision titles asked only for the Inspector (imp sol) (8f71a605, 72a72e88) [owner accepted without a separate try, 2026-11-21]
- accepted · UX-PASS · UX-PASS-REVIEW-FIX · review fixes: current provider via resolved bare ID; ? help opens over a Control draft; string hints removed (imp sol) (3534b622) [owner accepted without a separate try, 2026-11-21]
- done · — · UX-PASS-DESIGN · model selection + pi footer quota design: S1 FOOTER-QUOTA, S2 QUICK-MODEL, S3 PICKER-PANE, S4 PICKER-ORDER, S5 PICKER-FLAT (opt); 4 owner decisions · docs/design/ux-pass/model-selection.md
- done · — · UX-PASS-OVERALL · overall design: 1 FOOTER, 2 SAY-ONCE, 3 HELP, 4 EXP-FORM, 5 HARNESS-ROWS, 6 TOP-ROW; 4 owner decisions · docs/design/ux-pass/overall.md

## Now (2026-11-21, session handoff)

- MCP-ORCH is complete and pushed: WORKER-MCP, tickets 01–08, review (docs/reviews/2026-11-21-mcp-orch-milestone.md)
  and MCPORCH-FIX; then RESTART-RECOVERY (items 2–3 only; restart recovery is an owner decision above). No slice is
  working. The owner tries MCP-ORCH next: `/mcp` reconnect first (sessions started before today run old MCP code), then
  a live Claude Code task (ticket 07: dispatch, see `/tasks`, wake at the report without `hud watch`). If that works, a
  small slice delivers non-job events (try accepted/flagged) to task clients with the next tool reply.
- MyHUD is registered (`.hud/project.json`, all shipped roles inherited) with a standing brief `.hud/brief.md`; briefs
  here no longer need to repeat tmp/env.sh, the full-suite timeout, worktrees or the public-repo rule.
- Sonic's default is `thinking: high` (owner role file `~/.hud/roles/sonic.json`, changed from max 2026-11-21); callers do not pick (an optional Settings toggle lets the Decision API pick per job); watch its durations
  (2–8 min at high). Sonic briefs ask for facts, not recommendations; split wide surveys (convention, role texts).
- Noted 2026-11-21: a sonic ran `agy models` despite offline instructions (network access, writes to Antigravity's local
  CLI state; job under RESTART-RECOVERY jed235679bed45e93). Not reverted.
