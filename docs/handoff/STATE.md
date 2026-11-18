# State of the universal-hud effort (brought current 2026-11-18)

Milestone: 0.2.0 · MCP orchestration & Panel V2 (mcp-next + panel-v2)

Older sections (2026-11-03 to 2026-11-14: the R0–R7 queue, merge rules, review rounds, night logs) moved to
`docs/handoff/archive/STATE-2026-11-03-to-11-14.md`; they are not current.

## Waiting for the owner

- Nothing waits: the owner approved all 14 vertical-slice tickets across `mcp-next` (01–07) and `panel-v2` (01–07) on 2026-11-18. Still `try` in the ledger from earlier rounds: HOME-RECOMMEND, SETTLE-FIX, M4-PRUNE, MATT-OFF, SUPERVISOR-FIX.

## Next

- MCP-NEXT (`.scratch/mcp-next/`, 7 tickets): 01 fine-grained locks + pre-flight trust + parsed quota TTL → 02 `hud_create` preset + 04 pi native silent watch → 03 `hud_wait` → 05 `context_files`/`from_jobs` → 06 `hud-progress` + `hud_peek` → 07 managed `worktree` isolation.
- PANEL-V2 (`.scratch/panel-v2/`, 7 tickets): 01 micro-actions (`g` tab focus, `1–4`/`d` QA reply, `X` stop) + 05 safe `--numstat` diff bars + 06 Control plane quota/spend radar → 02 Split V2 (working cues, ratio, scrollbar) + 07 static HTML review board (`hud board` / `w`) → 03 global `/` filter → 04 activity sparklines + nested sonic subtrees.
- SUPERVISOR-FIX: CLI jobs stayed `working` because npm-launched MCP servers finished starting after the first turn (docs/reviews/2026-11-18-supervisor-stuck.md); owner chose fix 1 (known launcher chains are not work) + A (stop vs tab close) + B (retry failed cleanup) + C (refused send opens no turn); landed 1c4530ce (generic launcher rule) + 32e26e4f (npm quotes the bin name in sh -c; found by the live check); live check passed. thin-mcp.test.mjs SIGPIPE deaths fixed 8a43ed40 (hud watch removed its process-wide SIGPIPE listener, which on Node 24 reset the test process to die on a closed-socket write; test-only symptom, predates the supervisor fix). Full suite 85+678 green. SUPERVISOR-FIX waits for the owner's try: dispatch any Claude worker (frontend-imp or oracle) and watch it settle after its report.
- PANEL-REDESIGN: done and accepted (Split kept, Inbox deleted, batch try records, whole to-try text with model briefs).
- After the tries: the owner picks from the M5 candidates (docs/spec.md §5: retention periods, tail-first transcript read, Advanced settings).
- Release rule: keep main fast-forwarded to universal-hud at each release (v0.1.4: tag and GitHub release with `hud-0.1.4.tar.gz`, sha256 33f0c04f…, 2026-11-14).

## Slices

<!-- One line per slice: `- <state> · <milestone> · <ID> · <what it is> (<commit>)`. States: working, blocked,
try (landed, the owner has not tried it), accepted (the owner tried it), todo, dropped. The Project tab's progress
board counts these; update at every landing or decision. -->

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
- try · M4 · HOME-RECOMMEND · m4-close 08: Settings Home mode Default | Recommended (Decision-API ranking) + progress brief on top; addendum: Decision API own ledger + cap row (default unlimited), unlimited LLM cap option, 5-min summary floor, no kind backfill (owner) + Summary interval setting (e21b0a6b)
- accepted · M4 · PANEL-WIDTH · owner: Settings Width applies to Claude/pi herdr panels too (open at it, live resize), row moves to Panel (6c89eb09)
- accepted · M4 · DECIDED-LOCALE · owner: Decided for you shows question/answer/instead/why in the Settings language (one lite DS call, effort none) (30da9cd7)
- accepted · M4 · BAR-FIDELITY · m4-close 07: the six bar looks match their approved concepts (inks, spacing, idioms) (frontend-implementer) (2e2b2650)
- accepted · M4 · HOME-TIDY · owner: Model fit removed from Project; Home's progress block sits at the bottom of the spare rows (42e8bcc5)
- accepted · M4 · OAI-RUNNING · decision labels follow the Settings choice (default OpenAI, owner); running Claude subagents visible again (meta without finished) (5d0e54aa)
- try · M4 · SETTLE-FIX · closing an idle job no longer resets its 完成 age and re-asks its outcome label (8ada150e)
- accepted · M4 · CARD-FOLD · owner: settled cards fold to one line after 5 min, hide into `a` after 15 min; both in Settings (frontend-implementer) (b9597884)
- accepted · M4 · SNAPSHOTS · `npm run snapshots:update` rewrites every frame snapshot (51d16a29)
- accepted · M4 · PANEL-RELOAD · owner: the panel restarts itself after a new build, keeping its place (0d160038)
- accepted · M4 · CALL-BREAKDOWN · owner: Settings shows this hour's calls per feature, LLM and Decision (209d2c58)
- accepted · M4 · M4-REVIEW · m4-close 04: whole-project review (Sol xhigh + DS max on 3b17f7a0): changes-required, Sol 4 major, DS 2 major + 4 minor (docs/reviews/2026-11-12-m4-review-*)
- accepted · M4 · M4-FIX · m4-close 05: the review's behaviour findings (brief independence, statusline default, bounded job scan, settings guards, TZ, docs) (8cd38f1e)
- try · M4 · M4-PRUNE · m4-close 05: delete the unreachable retired ledger/supervision/runtime, dead modules and the historical installer chain (769cfa3d)
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
- try · — · SUPERVISOR-FIX · owner 2026-11-18: a CLI job settles after its report even when npm-launched MCP servers finish starting after the first turn (any npm exec/npx/uvx/pnpm dlx → sh -c 'bin' → bin chain); a stop racing a tab close records stopped; a failed worker cleanup is retried; a refused hud_send opens no turn; hud watch keeps Node's SIGPIPE default (1c4530ce, 32e26e4f, 8a43ed40)
- accepted · — · GENERAL · owner 2026-11-16: `general` role for ad-hoc dispatch, model/thinking per job (cb0d67a9; pi-roles general.md in Fishpref)
- dropped · — · MATT-FLOW · owner 2026-11-17: the convention keeps only HUD mechanics (a convention absorbing Matt's flow was written and reverted the same day); hud-build no longer installed (MATT-OFF)
- try · — · MATT-OFF · owner 2026-11-17: Matt skills are an inactive collection taken on demand; the HUD flow is delegation.md (to-tickets + one milestone review). Only to-tickets installed (Claude, Codex); grill-with-docs, to-spec, hud-build, tdd, diagnosing-bugs moved to integrations/skills-optional/ and listed in the Skills tab; global links and JevDev's pi-worker links removed
- accepted · — · SKILL-ROLES · owner 2026-11-17: only to-tickets is in the HUD flow (ticket management and boundaries; spec gaps become owner questions, tickets held); oracle is the strongest-model seat for any read-only judgement (oracle.md, Fishpref architect.md); frontend-imp designs and builds UI; pro research asks for cited primary sources; hud-delegate defers brief contents to the convention; the remaining Matt skills (wayfinder, triage, improve-codebase-architecture, wizard, teach, wait-what, writing-for-agents, to-questionnaire, prototype, retro, pr, codebase-design) copied verbatim into skills-optional; delegation.md role table matches hud_roster
- accepted · — · ARCH-ALIAS · owner 2026-11-17: hud_create takes `architect` for `oracle` unless a role file defines its own; spec rule: an agent edits docs/spec.md only after telling the owner the change and the reason; spec §2.3 lists the verbatim skills-optional copies and oracle as the strongest-model seat with no default skill; pi extension reinstalled (hud-setup linked)
- accepted · — · MODELS-6.2 · owner 2026-11-17: sol and astra are 6.2: pi-roles implementer/reviewer → openai/gpt-6.2-sol, architect (oracle presets) → openai/gpt-6.2-astra (Fishpref pi-roles); HUD's PI_ROLE_DEFAULTS match
- working · 0.2.0 · MCP-NEXT · high-throughput MCP orchestration: fine-grained locks, pre-flight trust, parsed quota TTL, preset dispatch, hud_wait, pi native watch, zero-copy context, hud-progress/hud_peek, managed worktree isolation (.scratch/mcp-next/, 7 tickets)
- working · 0.2.0 · PANEL-V2 · panel micro-actions (g/QA reply/X), Split V2 cues/ratio/scrollbar, live / filter, sparklines + sonic subtrees, safe --numstat diff bars, Control quota radar, static HTML board (.scratch/panel-v2/, 7 tickets)
- try · — · MCP-READ-COMPACT · compact actionable `hud_read()` list; `view:"recent"` retains the newest 20 full rows (separately scheduled, `.scratch/mcp-read-compact/issues/01-compact-hud-read.md`); landed e629b295 (default 327 B vs recent 4,475 B, −92.69%)
- try · — · SUPERVISOR-MCP · bug 2026-11-18 (live, Claude frontend-imp): a CLI worker stays `working` after its report when its CLI started an MCP server directly (`node …/hud-mcp`) just after the first input; cli-judge counts it as turn work (spec §2.1: MCP servers do not count); landed 2d281b7b: on the first turn a direct non-shell child started within 10 s of the first input is a launch helper (shells and later children still count); live check passed 2026-11-18 (panel-v2 04 frontend-imp j9dbc6abfd9f248a6 reached idle_grace on its own after its report)

## Now (2026-11-18): 0.2.0 all 14 tickets landed (mcp-next 01–07, panel-v2 01–07) + MCP-READ-COMPACT 01 and SUPERVISOR-MCP; full suite 86+757 green and check:fixtures OK on 7a3da0d0; milestone review running (reviewer j12b20efb9f14274c, brief tmp/tasks/review-0.2.0/brief.md); then one fix pass, then the owner's try

State on 2026-11-18, checked against the ledger below (no working, blocked or todo slice), herdr (only the main session's tab) and origin (in sync).

### 2026-11-17, what was decided and in what order (sources: the day's session transcripts and the commits)

- 08:48 MATT-PARADIGM chosen (paradigm B: Matt's originals, patched only at collisions; cec69c09). 08:48–09:20 WORKER-UNIFY: oracle report 691b31b9,
  addendum b99f5f72 recommending route (a); the owner decided nothing and asked for a handoff (9bcdc141).
- 14:24–15:21, a later session, answered the skill half of it: MATT-OFF (74b1794c) supersedes paradigm B, so Matt's skills are an inactive,
  on-demand collection and only `to-tickets` is installed; SKILL-ROLES (9dcd86f2) leaves oracle without a default skill and has a brief name a
  method skill by path, which drops ORACLE-SKILL; ARCH-ALIAS (34bfabc4) makes `architect` another name for `oracle` and requires telling the
  owner the change and reason before any spec edit. ROLE-PRESETS and SIDEBAR-ONE landed the same day (ledger).
- From 15:24, the panel review: PANEL-TIDY, STATUSLINE-TPS, BAR-NOTICE and PANEL-NEXT landed. The architect's independent opinion cut a usage
  total, a today view, change size on cards, a quota table, a quota ETA and TTFT; the main session withdrew its `↑N` branch suggestion (the bars
  already show ahead/behind). A status-bar job counter and an always-shown running job were declined (docs/reference.md: the bar shows no task count).
- The owner's workflow changes: reviews run one reviewer with no model-family rule (docs/delegation.md); a read report closes its worker and a live
  child process counts as still working (WORKER-CLOSE, spec 38a27e21).
- WORKER-UNIFY and PANEL-TRY decided late 2026-11-17 (ledger). `[✓●]` keeps hiding after 3 minutes (owner: no, 2026-11-17).

### 2026-11-14 (was Next)

- The owner tries 0.1.4 (then 0.1.3, 0.1.2, 0.1.1, M4). Orchestrator live check 2026-11-14 on 60a254b1: dispatch failure returned and its tab closed;
  agy two turns with a supervisor kill and hud_send respawn; Control plane, hub, Tickets, Progress read through herdr. Found and fixed live:
  ticket fields on a shared line were skipped (supervisor feature missing), STATE head was stale.
- Leftovers closed 2026-11-14: hud_read waits between reads and returns `quiet_decision`; the retention test's fake clock is written atomically
  (a torn read gave Date.now() 0 and a TimeoutOverflowWarning); pi-roles' dispatch test uses real-shaped herdr ids (Fishpref 1f91417). The
  panel-reload width flake did not reproduce (6/6, full suite 564/564).
- 2026-11-14: main fast-forwarded to universal-hud (owner chose fast-forward + tag); tag and GitHub release v0.1.4 (sha256 33f0c04f…).


- 0.1.3 review (docs/reviews/2026-11-14-013-review-*.md): Sol changes-required (Codex prefix `[`/`]` unwired; active jobs
  from other panes have no title), DS accept with 3 minors. FIX-013 landed 6359b958 (467/467); re-review: Sol accept (no findings), DS accept
  (5 optional; the stale "top row" wording fixed). 0.1.3 waits for the owner's try.
- SUPERVISOR (owner 2026-11-14: misjudged/killed workers are the bottleneck; the panel shows failures the session
  never hears). Fable design opinion in: facts-only `failed`, one shared job-row reader for display + MCP, `hud_create`
  returns dispatch failures, `changes` in every MCP response, `hud watch`. Owner answered (spec §2 amended 130a8eb1;
  no typing into the main pane; ticket 10's decided fail needs a quota line). .scratch/supervisor/ 7 tickets:
  01–03 landed (2c5d7e1d, 52b21b91, 458ef06b), 04–05 as a stopgap 90ef78cd (496/496); 08 landed 4ffe4d7b +
  d880ee7b (oracle's event-driven design: herdr events, file watches, deadlines, 30 s tick, STATUS on change;
  554/554). Real agy run 1 found pushes ignored (herdr sends `pane.agent_status_changed`, fake used `_`): fixed;
  the safety tick re-reads status (one request/30 s). 09 (hud_send respawns a dead supervisor) landed (556/556). Real agy run
  2 passed (working through a 150 s background command, idle_grace 25 s after the report). 0.1.4 milestone review
  on 3e3edfc8: grok + DS changes-required (0d24ed0f); docs fixed a2b2b033; code fixes 7bd5e175 (roster expiry, failed
  report prompt, prompt once per job, stale quiet card, ZH note, hud watch on one recursive fs.watch, open question
  reason; 562/562). Re-review on 7bd5e175: grok and DS accept; follow-ups 86007c37 (563/563). 0.1.4 to the owner's try. Imp now dispatches on its default place (agy hydrogen high).
- PROJECT-UX (owner 2026-11-14): try. Landed 891556a1: timeline hub (A + 2 transplants, Latest folded first,
  Progress last 7 days), ticket lanes, attention-first Control plane, provider → model picker with curated pi
  list (arena, mistral deepseek, anthropic opus, openai gpt-6; newest per family). Page rows scroll, never trimmed (owner).
- ROLE-BIND 03 landed 19333df8 (480/480): the Control plane switches places. ROLE-BIND 04 (model lists from the
  harnesses, catalog fallback, typed model) running: agy imp j8a87fdd732834890 in MyHUD-wt/ROLE-BIND-04.
- ROLE-BIND (0.1.4, .scratch/role-bind/): roles are the work with an ordered place list (primary + fallbacks),
  `bro` replaces `jev`, browser work is oracle + flow, the control plane switches places, `on` kept. 01 and 02 (agy-imp)
  after PROJECT-HUB 02; 03 (frontend) after 02 and PROJECT-HUB 03.
- CLI-NOREPORT (bug, 2026-11-14; .scratch/cli-workers/issues/09): herdr's `done` is a screen heuristic; agy shows it
  while waiting on a background command, and the supervisor failed and quit ROLE-BIND 01's first job. Fix: the report
  is the completion signal; done without a report keeps the job open; background child processes count as busy; quiet past the
  idle grace → waiting_orchestrator with a notice; the HUD sends the worker nothing and never quits it for a missing report. After ROLE-BIND 01 (same files).
- QUIET-DECIDE (cli-workers 10, owner 2026-11-14, spec §2 "One exception"): after 09, a quiet CLI job without a report
  gets one Decision API choice among fixed actions (keep waiting / one fixed report prompt / fail / main session);
  below 0.8 or on any error → main session. Also: Mistral DeepSeek (reasoning off) as a Decision API provider if it
  gives structured output with probabilities.



Owner 2026-11-14: Project becomes a hub with progress, tickets, working tree, docs and control-plane pages and a
project switch (spec §2, .scratch/project-hub/). Routing for this package: frontend work to frontend-implementer, data work to agy-imp (gemini-4-hydrogen-high),
review only at the milestone by Sol xhigh (arena provider when quota runs out) and DS max, sonic unchanged.
