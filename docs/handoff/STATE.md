# State of the universal-hud effort (handoff to remote orchestration, 2026-11-03)

Milestone: M4 · Project view

## Waiting for the owner

- Try (9 landed): reopen `/hud` in a Claude pane → Home shows `Claude · 本次会话` with nested subagents indented
  (CLAUDE-BIND, NP-01, NP-05); a subagent waiting on background work turns ◉ again when it resumes (NP-02); job cards
  show the brief's heading as title (NP-04); Chinese 「」 keywords are coloured (NP-03); Home's spare rows show progress
  and open tickets, Enter jumps to Project (HOME-PROGRESS); Settings → Models → Decision API switches Jev's provider
  (GEMINI-DECIDE); settled cards show an outcome mark, the Inspector shows kind/outcome/review counts, Project has a
  questions show a category (DL; needs a working Gemini or OpenAI key); Settings → Theme offers
  terminal, titanium, mocha, arctic, ember, contrast, latte, paper and each changes Home/Project/Inspector (THEMES); bottom bars in each look match the concepts (BAR-FIDELITY);
  Home's progress/tickets sit at the bottom, Model fit is gone (HOME-TIDY).

## Next

- m4-close 05: review round 3 (Sol xhigh + DS max on 2a0f8735). Sol: changes-required, one finding (retention
  deleted legacy real sessions in old job dirs), fixed by RETENTION-SAFE 377ecb69. DS: accept, two minors (dead
  Claude facade modules, stale CODEX_HUD_SKIP_FONTS row), fixed by M4-FIX3 6a27a421. Round 4 on 6a27a421: Sol accept (optional: bounded
  header read); DS changes-required: a self-referential session link (from the failed first PANEL-SCOPE dispatch,
  before the pi-roles guard) made the watcher's recursive fs.watch throw ELOOP at startup, so no watcher had run
  since 20:10 (tabs not closed, no retention). Live tree unblocked by hand (link removed, job reaped); M4-FIX4 8dd1703a makes
  the watcher survive it. Round 5 on 8dd1703a: Sol changes-required (the normal `.dispatch/current.json` receipt
  makes every scan throw ENOTDIR; degraded polling stops while only a failed-tab deadline is pending) → M4-FIX5;
  DS changes-required on the same receipt bug (plus optional: retry the watch, BASELINE.md drift; added to FIX5). Fixed by M4-FIX5 88c048da. Round 6 on 88c048da: both changes-required on
  the same defect (a job whose session housekeeping throws is not counted open, so the watcher can exit while it
  works) → M4-FIX6 2d0fed42 (plus DS optional: no async error retry loop, rate-limited log lines).
  Live check 22:04: the old watcher stopped, the next hud_create started one on 2d0fed42 over the real job tree
  (four `.dispatch/current.json` jobs): alive, no error lines. Round 7 on 2d0fed42: **both accept** (m4-close 05 done). DS optional
  follow-ups (SESSION.txt guard, rate-limited reap/preservation lines, BASELINE counts, CI calling removed scripts)
  → M4-FIX7. Architect (Astra) whole-project review (docs/reviews/2026-11-12-m4-architect.md): **Release:
  blocked** by one point — the Codex bar (`src/collectors/git.ts`) and the pi footer (`p10k-footer.ts`) let a
  repository's clean/process filter (and, in pi, core.fsmonitor) run (spec §4) → GIT-SAFE. Advice taken for the
  release: archive inventory + extraction rehearsal (m4-close 06), stale hud-mcp README / historical activation
  text in reference.md / ARCHITECTURE (RELEASE-DOCS, with the real Node floor in engines + install preflight). Advice deferred to the next milestone: job-dir
  listing and pi session totals grow with history; no deadline on MCP child processes. Round 8 on 1ec6e0ef: Sol changes-required (docs
  only: live pi /hud controls and piFooter cut from the reference; `codex-hud` examples name a command the installer
  does not install), DS accept (one false rotation sentence + optional notes); GIT-SAFE and FIX7 confirmed fixed by
  both → RELEASE-DOCS2 b622a7ba (+ short ja/ko READMEs). Round 9 on b622a7ba: **both accept**; their small optional notes fixed directly (Changes view
  ignores submodules; pi display package is registered, never `pi -e`). The full suite on Node 22.13.0 fails 5
  watcher tests, so the Node floor becomes 24 (only tested line; owner runs 24). RELEASE-ARCHIVE c00936e4:
  `npm run release` (clean worktree only) writes hud-<version>.tar.gz by git archive (tests, docs history, .scratch,
  .github, cx-continue, agent guides export-ignored); `npm run test:release` rehearses offline extract (path with a
  space) → ./install core + all extensions → hud / panel / MCP six tools + roster → both uninstall paths with data
  kept; first-party audit clean. Round 10 (Sol + DS) on the release change, then the final archive is built from the
  reviewed HEAD and the owner merges/tags; RELEASE-ARCHIVE (m4-close 06: `npm run release` = git archive minus dev-only paths, offline install
  rehearsal in a temp HOME) running in parallel; then m4-close 06 (archive via git archive of tracked files
  minus dev-only dirs, extraction rehearsal in a temp HOME), then stop for the owner before merge/tag.
- Waiting for the owner (shelved): `hud import` still merges jev/aistudio TOML sections nothing reads now (DS review2
  finding 1); delete that part of the command or keep it?
- Until each client restarts its hud MCP server (Claude `/mcp` reconnect, pi/Codex restart), old servers still pass
  `--session-dir <job>/sessions`, so those jobs keep real session files in the job dir; run
  `python3 tmp/bin/migrate-sessions.py apply` before they turn one day old (pi-roles 27e2006 guards the self-link).
  Since RETENTION-SAFE the watcher moves them itself before deleting; the script stays a manual shortcut.
- Waiting for the owner (shelved): `cx-continue/` (types "continue" into stalled Codex panes; Python, with its own
  CI job) is in the repo but in neither the spec nor the installer: keep or remove? Not shipped in the archive
  until decided.
- Then m4-close 06 release: a clean-built archive (stale dist files from deleted sources must not ship) + ./install,
  temp-HOME install/uninstall, merge to main, tag.
- Small leftover for me: pi-roles' pi-dispatch test still uses synthetic ids.

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
- try · M3b · CLAUDE-BIND · hud panel finds the caller's Claude session via herdr pane current at open time;
  nothing stored per pane (owner: pane ids are dynamic) (968b0f27)
- accepted · M3b · CARD-DETAILS · newest card expanded, others folded; keywords colour files, stances (approve, object,
  reject) and opinions (6c9cb40b)
- accepted · M4 · TICKETS · the Project tab's Tickets section from to-tickets' .scratch tracker (6364ddad)
- accepted · M3b · M3B-REVIEW2 · the closing M3b two-axis milestone review (Sol xhigh + DS max): changes-required, 2 blocking keys (docs/reviews/2026-11-12-m3b-review2-*)
- accepted · M3b · M3B-FIX2 · the closing review's fixes: Codex Ctrl+\ 2, Settings s/t, dead code, docs (c283e7ea)
- accepted · — · PI-STOP · hud_close stops a working pi job in seconds, not after a 30 s wait (Fishpref 38447ef)
- accepted · — · LEGACY-SKILLS · herdr-delegate, herdr-delegate-codex, pi-subagent retired to Fishpref (6bd0ef8)
- try · M4 · NP-01 · native-polish 01: nested Claude subagents always sit under their parent (e295a0a9)
- try · M4 · NP-02 · native-polish 02: a resumed Claude subagent shows running again and gets a fresh result (a5a3e6a4)
- try · M4 · NP-03 · native-polish 03: Chinese keyword marks colour instead of showing brackets (746971eb)
- try · M4 · NP-04 · native-polish 04: HUD job cards show a short title (eb3e5558)
- try · M4 · NP-05 · native-polish 05: live /hud binding check and CLAUDE-BIND leftovers (live check passed; Fishpref pi-roles fixed)
- try · M4 · GEMINI-DECIDE · Gemini Decisions API provider + Settings switch; default primary OpenAI (Jev pages too heavy for the free tier), 429 cooldown (fe3aed6c)
- try · M4 · DL · decision-labels 01–06 in one slice (owner): outcome, kind, model fit, looping mark, question category, review severity (f52c4106)
- try · M4 · HOME-PROGRESS · Home shows a compact progress board and open tickets in its spare rows (owner) (2de1e8a7)
- try · M4 · LIVE-FIX · live-check bugs: active job shown stalled; finished subagents briefly running on open; «--flag» read as reject (445689e9)
- try · M4 · HOME-LAYOUT · m4-close 01: Home's progress block layout (frontend-implementer) (426dbc02)
- try · M4 · THEMES · m4-close 02: each theme its own board inks; refined terminal; new arctic, ember, contrast, paper (frontend-implementer) (6f9a079f)
- try · M4 · ROW-FIX · native rows keep one order; a growing transcript counts as activity (no false 停滞); running cards drop the flipping tool name (66f37e57)
- try · M4 · CARD-HEIGHT · owner: Home cards are title + two fixed sentence rows (sentence ≤30 zh chars / 16 words); only the newest current result opens by itself (c1647299, aca06c54)
- try · M4 · HOME-RECOMMEND · m4-close 08: Settings Home mode Default | Recommended (Decision-API ranking) + progress brief on top; addendum: Decision API own ledger + cap row (default unlimited), unlimited LLM cap option, 5-min summary floor, no kind backfill (owner) + Summary interval setting (e21b0a6b)
- try · M4 · PANEL-WIDTH · owner: Settings Width applies to Claude/pi herdr panels too (open at it, live resize), row moves to Panel (6c89eb09)
- try · M4 · DECIDED-LOCALE · owner: Decided for you shows question/answer/instead/why in the Settings language (one lite DS call, effort none) (30da9cd7)
- try · M4 · BAR-FIDELITY · m4-close 07: the six bar looks match their approved concepts (inks, spacing, idioms) (frontend-implementer) (2e2b2650)
- try · M4 · HOME-TIDY · owner: Model fit removed from Project; Home's progress block sits at the bottom of the spare rows (42e8bcc5)
- try · M4 · OAI-RUNNING · decision labels follow the Settings choice (default OpenAI, owner); running Claude subagents visible again (meta without finished) (5d0e54aa)
- try · M4 · SETTLE-FIX · closing an idle job no longer resets its 完成 age and re-asks its outcome label (8ada150e)
- try · M4 · CARD-FOLD · owner: settled cards fold to one line after 5 min, hide into `a` after 15 min; both in Settings (frontend-implementer) (b9597884)
- try · M4 · SNAPSHOTS · `npm run snapshots:update` rewrites every frame snapshot (51d16a29)
- try · M4 · PANEL-RELOAD · owner: the panel restarts itself after a new build, keeping its place (0d160038)
- try · M4 · CALL-BREAKDOWN · owner: Settings shows this hour's calls per feature, LLM and Decision (209d2c58)
- accepted · M4 · M4-REVIEW · m4-close 04: whole-project review (Sol xhigh + DS max on 3b17f7a0): changes-required, Sol 4 major, DS 2 major + 4 minor (docs/reviews/2026-11-12-m4-review-*)
- try · M4 · M4-FIX · m4-close 05: the review's behaviour findings (brief independence, statusline default, bounded job scan, settings guards, TZ, docs) (8cd38f1e)
- try · M4 · M4-PRUNE · m4-close 05: delete the unreachable retired ledger/supervision/runtime, dead modules and the historical installer chain (769cfa3d)
- try · M4 · SESSION-LINK · owner: pi session history stays in pi's default place; job directories only link to it (23a9782d; Fishpref 45d93a1)
- try · M4 · RETENTION-SAFE · 377ecb69 · the job watcher moves real pi session files to pi's store before deleting a job directory (imp; review-3 q1 ruling)
- done · M4 · M4-REVIEW3 · Sol changes-required (1, fixed by RETENTION-SAFE), DS accept (2 minor) · docs/reviews/2026-11-12-m4-review3-*.md
- try · M4 · M4-FIX3 · 6a27a421 · round-3 leftovers: dead Claude facade modules, font env row, reap before delete, doc drift
- done · M4 · M4-REVIEW4 · Sol accept, DS changes-required (watcher dies on a link loop) · docs/reviews/2026-11-12-m4-review4-*.md
- try · M4 · M4-FIX4 · 8dd1703a · watcher survives a session link loop and a failed fs.watch; retention optional notes
- done · M4 · M4-REVIEW5 · Sol and DS changes-required (watcher dies on the normal .dispatch/current.json receipt) · docs/reviews/2026-11-12-m4-review5-*.md
- try · M4 · M4-FIX5 · 88c048da · watcher: .dispatch receipt file, per-job containment, degraded polling with a pending deadline, watch retry
- done · M4 · M4-REVIEW6 · both changes-required (open job lost on a housekeeping error) · docs/reviews/2026-11-12-m4-review6-*.md
- try · M4 · M4-FIX6 · 2d0fed42 · session housekeeping errors no longer hide an open job; watch retry only on the timer; log rate limit
- done · M4 · M4-REVIEW7 · Sol accept, DS accept (4 optional) · docs/reviews/2026-11-12-m4-review7-*.md
- try · M4 · M4-FIX7 · 77500308 · round-7 follow-ups; CI runs only existing scripts on Node 24; fixture idents
- try · M4 · RELEASE-DOCS · 1ec6e0ef · shipped docs describe today's HUD; Node ^22.13.0 || >=24 in engines + install preflight
- done · M4 · M4-REVIEW8 · Sol changes-required (2 doc), DS accept · docs/reviews/2026-11-12-m4-review8-*.md
- try · M4 · RELEASE-DOCS2 · b622a7ba · round-8 doc fixes, short ja/ko READMEs
- done · M4 · M4-REVIEW9 · Sol accept, DS accept · docs/reviews/2026-11-12-m4-review9-*.md
- try · M4 · RELEASE-ARCHIVE · c00936e4 · npm run release + offline install rehearsal (test:release); Node floor 24
- done · M4 · M4-ARCH · Release: blocked (1: repo Git filters run from the Codex bar and pi footer) · docs/reviews/2026-11-12-m4-architect.md
- try · M4 · GIT-SAFE · 76e2ba8b · one safe Git policy (src/utils/git-safety.ts) for Claude, Codex, pi footer, Project, Changes; submodule working trees not probed
- try · M4 · PANEL-SCOPE · owner: a panel shows only HUD jobs that settle while it is open; the open time survives reloads (9b9ea418)
- try · M4 · JOB-RETENTION · owner: the job watcher deletes a settled job directory one day after it closes (71801be1; existing 99 pi sessions moved to ~/.pi/agent/sessions and linked first, toktrack totals unchanged)
- accepted · M4 · M4-REVIEW2 · re-review on 3280cc02: changes-required; Sol 3 major (reload place, reload width, retired host/bridge left), DS 1 major + 3 minor (docs/reviews/2026-11-12-m4-review2-*)
- try · M4 · M4-FIX2 · re-review fixes: reload keeps place and width in bound panels; brief persists across sentence changes (152db34b)
- try · M4 · M4-PRUNE2 · re-review: delete the remaining retired runtime exports and host/bridge; docs and READMEs that describe deleted things (0871f74d)
- try · M4 · INSTALL-EXT · owner: ./install gets the browser and herdr extensions of spec §2.3 (96deabe9)
- todo · M4 · RELEASE · m4-close 06: one release archive with ./install; merge to main, tag
- dropped · M3b · BAR-PHOSPHOR · bar themes Phosphor and Pill Rail (owner: not built)

## Now (2026-11-12, night): review round 3 running; fix round 2, SESSION-LINK, JOB-RETENTION, PANEL-SCOPE landed; owner away

Landed since noon: NATIVE-TREE, PROGRESS-BOARD, OPEN-TAB, CARD-DETAILS, TICKETS, PI-STOP (Fishpref), legacy skills
retired, Matt Pocock skills installed (to-tickets slices multi-slice features), closing M3b review + M3B-FIX2.

### Earlier on 2026-11-12

Landed today: hud_read/list perf (`5ac1ee5c`), bar perf (`476bed9f`), ONE-PAGE Home (`9e54af8b`), stopped-after-report
shows done (`979414c6`), pi ribbon back in the editor's top border (`75519c63`, owner checked), CLEANUP-VIEWS
(`a0357f7e`: Timeline, Activity hub, Summary, diagnostics deleted; Changes keeps only the git/worktree summary).
pi-roles retries `agent_pane_busy` on a fresh split (Fishpref `798cc6b`).

Running, each in its own worktree (`../MyHUD-wt/<WP>`, docs/delegation.md Conventions): PAGES-BUILD (Inspector,
Settings, Help, Changes in Home's look) and BAR-THEMES-BUILD (Gauge Plates, Tide, Micro Glyphs, Stacked, Headline,
Triptych; default unchanged).

Next: perf finding 3 (standalone panel backoff) and a panel re-measure; the owner tries M3b; NATIVE-TREE; M4 Project
(no to-tickets dependency). Open: `hud_close` cannot stop a working pi job (match the STATUS pid in pi-roles); panel
open notification burst; panel self-close with its caller; retiring legacy skills (list features first); a Jev
"did it finish" verdict only if rule-ambiguous stopped jobs show up. The Codex credits notice was already removed
(`72d971ca`).

## 2026-11-11, night: bottom bars and panel polish done, pushed; theme concepts running

The owner is satisfied with the bars (pushed through `6f641d82`). The three bottom bars (Claude statusline, pi
footer, Codex tmux bar) show one field set on one line:
- model with its provider mark and a short name (`✻ opus-5.5 high`);
- context as a claude-hud bar against the auto-compact window (`40%/400K`);
- repo and branch;
- each client's own quota (claude-hud bar; pi shows `$` or `~$`);
- an event-only notice zone (`◐|✓|✗ name [model · effort]`, `✦ skill`, `!` needs-you; 3 min each, two at a time);
- `MCP n  skills n` on the right.

`barStyle` is line (default) or p10k (powerline capsules); `barFields` switches fields off. PANEL-POLISH
(`e60d5bb7`): Enter on a Work card opens its report, rows are erased before they are written (fixes `⏎ ope`), lane
maps show only real stages, readable worker tab labels. The real-herdr check of the `⏎ ope` fix is still the
owner's.

Running: BAR-THEMES, a concept-only job for 5–8 bar themes (`tmp/tasks/BAR-THEMES/`). The owner picks; a later slice
builds them.

Waiting on the owner: whether the Codex `◆ window spent, on credits now` notice stays (it is outside the
owner's notice list).

Open defects and requirements:
- **An orchestrator-stopped job reports nothing** (owner, 2026-11-11): stopping a job on purpose must not push
  `[role@job] FAILED agent aborted` to the main session; it ends as stopped, not failed.
- `hud_close` cannot stop a working pi job: pi ignores quit mid-turn and pi-role-reap's SIGTERM guard looks for the
  task dir in argv, but pi retitles itself `pi`. Fix in pi-roles (match the PID recorded in the job's STATUS.json).
- `codex mcp add/remove` drops comments from config.toml; the installer now backs up and warns, no re-insertion.
- Later: notification burst when the panel opens, the job scan reading all history, then AI-THIN, NATIVE-TREE,
  panel self-close with its caller, M4 Project tab, retiring the legacy skills (list visible features first).

## 2026-11-10: spec first, new workflow

The owner judged the effort over-engineered and slow: in ten days no usable build, tests twice the source, 127
review rounds and 322 questions across 200 task directories, and a first week spent on an execution platform the
2026-11-07 scope convergence made obsolete (and an installer runtime package that entry had already ruled out). Cause:
no stated requirement or complexity bound, an implementer/reviewer pair on every task optimising locally, and the
orchestrator approving each expansion instead of holding the scope.

Changes (owner, 2026-11-10):
- `docs/spec.md` is the product boundary, short and owner-owned. It wins over the concept log and this file.
- `docs/delegation.md` is rewritten: grill, vertical slices, one implementer per slice without review, one two-axis
  review (spec incl. scope creep; simplicity) per milestone, the owner tries it. Role texts in pi-roles changed to
  match (Fishpref `81e1859`).
- Grilled M1 (owner, 2026-11-10): install from the repo with `./install`, MCP + skill in all three clients, `hud panel`,
  Claude statusline at claude-hud parity, pi footer replacing p10k-footer. Old execution stack deleted right after M1
  (M2). Milestones in `docs/spec.md` §5.

Dispatch core (owner, 2026-11-10): the six tools are rewritten as a thin layer over `pi-dispatch` / STATUS /
`pi-role-reap`, and M1 depends on the installed pi-roles. The existing facade conflicts with the spec (release
verification, caller identity proofs) and goes with M2. Record, with the proposed workflow corrections and the
role/workflow split still waiting for the owner: `docs/reviews/2026-11-10-workflow-discussion.md`.

Status: STATUSLINE-PARITY merged (`4e3ba42`; old-workflow brief, heavy, prune at the M1 review). PI-FOOTER-PORT still
running. R6A-A8 stopped by the owner's call, WIP kept on branch `r6a-a8` (`0b02400`). INSTALLER-ARCH reaped; its
answer is superseded by the spec's simple installer. Next: owner approves the M1 slice list, then build.

## Current queue (2026-11-07): R0–R7

Authoritative scope: `docs/universal-hud-concept.md` §15, "2026-11-07 Scope convergence: fixed roles, herdr execution, owned Jev". This is the current queue. Sections below are
earlier results and are not a second queue. The general agent host and the observer-only
retirement plan are outside this queue. WF1 stays deferred.

Dependency order: R0, then R1 → R2 ∥ R3 → R4; R2b follows R2 once the pi-roles dispatch contract settles. R5 proceeds against R2 and R3 fixtures.
R6 follows acceptance of the replacement paths. R7 closes delivery.

After R1, R2 and R3 can proceed in parallel. R4 depends on R3; R5 can develop against their fixtures. R6 follows the replacement paths’ acceptance, and R7 closes delivery.

Progress (2026-11-07; full handoff in `docs/handoff/2026-11-07-handoff.md`):

- Done, reviewed and pushed: R0 (`5abc76a`), R1 (`c5deb38`), R2 (`1bce8d9`), R3 (merge `37725d1`), and the R2↔R3 Jev adapter (`3c34a7d`).
- The six role tools are served only with `HUD_MCP_SURFACE=roles`. Default sessions keep the old tools until R6.
- Merge gate from now: full `test:unit`, `test:mjs`, `test:hud-mcp` and WP0, compared against the base commit.
- At `3c34a7d` two unit failures remain. `B11 … path with spaces` already failed before R1. A statusline test is flaky under the full suite.
- Next is R4 (ChatGPT Pro and AI Studio target adapters), then R5. It was paused for Codex usage; since 2026-11-07 code tasks run on the pi harness with gpt-6.1-sol (`docs/delegation.md`), so R4 no longer waits on the Codex CLI.
- R2b added 2026-11-08 (concept §15, "Pi execution through the pi-roles dispatch prototype"): the facade runs pi roles through `pi-dispatch` / STATUS / `pi-role-reap` instead of its own pi launch. Starts once pi-roles DISPATCH-2B and DISPATCH-3 have settled the contract.
- Live Jev smoke (2026-11-08, owner-approved) found three R3 defects: production config was never found, judge markers were compared by identity, and a missing Chrome surfaced as `internal`. R3F (`aa6e86c`) fixed them and added a single-settlement CDP deadline. Re-smoke: the OpenAI judge settles in 1 call; the runtime auto-starts a detached headless Chrome and leaves it running.
- Judge structure (SONIC-AB-02, merged `1b0865f`): judge observations now carry the observed actions as `elements` (via `actionSpace`) and up to 12 visible h1–h3 headings in `facts.headings`; a vm test runs the real expression. Live: on a synthetic localhost page a TypeSafe judge job passes "main heading is …" in 1 call (p=1.0). The earlier p≈0.2 on example.com was mostly the page itself: it no longer has an h1 (the phrase is only its title). A/B result in `docs/sonic-ab.md`: DS max best (9/10), GLM max 8, GLM high 7, DS high 3 (invalid expression with green tests). Sonic default settled on DeepSeek V4.1 Flash (owner); no SONIC-AB-03.
- R2b merged (`178e5bd`) and accepted live on 2026-11-08 through `HUD_MCP_SURFACE=roles` with a synthetic scratch repo:
  - a pi imp called sonic and the reviewer itself and settled; the caller-backgrounded `hud wait` returned DONE;
  - SESSION `ORCH` was empty, so there is no second wake channel;
  - `hud_close` reaped every agent and the tab, and a repeated close was idempotent;
  - with `pi-dispatch` off PATH the R2 direct path launched, waited and closed.
- The direct path first failed live with `unsafe_launch`: pi-roles' one-extension bundle (PIBUNDLE) put raw JSON in `--role-bundle`. pi-roles now encodes it as base64url (Fishpref `f7f2481`).
- R2c merged (`e2e9d4e`), accepted live on 2026-11-08 with a sonic job through the roles facade:
  - the returned wait command is the absolute `bin/hud` path with `--timeout-ms 3600000`; bare waits default to 30 min;
  - a short `--timeout-ms` printed `TIMEOUT` and exited 6; the full wait returned DONE, exit 0;
  - waiter RSS: about 98 MB before, about 50 MB on the synthetic fixture, 62 MB live while polling herdr; an import-graph test pins the waiter;
  - pi-roles PIAUTOCLOSE (Fishpref `92fc938`): the sonic tab closed itself after its clean finish, before `hud_close`, which then reaped idempotently.
- Known debt (cleared by DEBT1, 2026-11-09): pack-cloud-preview self-test, B11 spaces path, panel publisher under load.
- R4 merged (`d489581`): ChatGPT Pro and AI Studio oracle targets, three review rounds, 24-case crash-window matrix, close/stop admission fences checked by in-memory negative controls.
- R4 live acceptance (2026-11-08) found three defects; R4F is fixing them:
  - D1 ChatGPT: `page_ready_timeout` before Send on a ready, logged-in page that held a stale composer draft (nothing was sent);
  - D2 the pre-send code reached the job as `internal`;
  - D3 AI Studio: the send succeeded (answer visible in the tab), but confirmation never settled because the URL stayed `new_chat`; closing the job left it `failed` instead of closed and recoverable.
  The AI Studio record `r4-studio-1` stays `send_attempted`; after R4F, a resume must collect it with zero clicks.
- R4F merged (`14b13fc`):
  - D1 mechanism: `awaitStates` timed out whenever a backoff did not fit the remaining budget. An offline replay with
    a recorded real judgment proved this. The historical latency was not observed.
  - D2: the public code list is now complete.
  - D3: confirmation binds to the numeric user turn.
  - Runtime lifecycle diagnostics were added.
  - 70/70 mutation variants were killed.
- R4F live acceptance, first run (2026-11-08 20:32Z): the D3 resume failed `internal` exactly 60 s into confirm. The
  AI Studio tab was hidden (background). Suspects: a CDP call that never settles on a hidden tab (60 s CDP timeout),
  and the URL settling to `prompts/<id>` after the send. Nothing was clicked or sent. R4F2 is fixing it. The
  ChatGPT Pro run waits for R4F2.
- R4F2 merged (`406fe52`):
  - Root cause: on a background tab, the post-scroll `Page.captureScreenshot` never settles. Oracle reads no
    longer use compositor screenshots.
  - Browser timeouts are now the finite code `browser_timeout`: `failed` before a send, completed + recoverable
    after one.
  - A same-document URL settlement keeps the prompt proof.
  - Internal failures now get finite diagnostics.
  - T9 runs on an isolated Chromium; the shared CDP endpoint is opt-in only.
- Live acceptance, second run (2026-11-08 22:35Z):
  - **D3 accepted.** The `r4-studio-1` resume completed `answered` (`437`) with zero resends, and the record is
    `done/sent`. Collect took 1 min 44 s; the cause is being investigated.
  - **D1 accepted.** ChatGPT `page_ready` passed in 2.9 s, and the stale draft was cleared.
  - **D2 accepted.** The failure below surfaced as its own code.
  - **New failure:** a ChatGPT Pro ask with an attachment (`r4-pro-attach-2`) failed `upload_finished_denied`.
    The judge denied "uploaded" about 1 s after the file input was set. Nothing was sent.
  - R4F2 fix round 2 is working on it: `upload_finished` becomes pass-only, real upload failures are detected
    from facts, card matching and leftover attachments are checked, and the collect latency is explained.
- R4F2 round 2 + R4F2B merged (`57fa531`):
  - `upload_finished` is pass-only.
  - The collision-name rule and the attachment-chip exclusion are fixed.
  - The public decision codes are complete.
  - The AI Studio collect replay drops from 104 s to 3 s.
  - Owned-tab cleanup now survives timeouts and runtime stop.
  - The review found one major issue (an orphaned saved-view tab), fixed by R4F2B and then accepted.
- Live acceptance, third run (2026-11-09 00:53Z): **ChatGPT Pro with an attachment answered correctly, end to
  end.**
  - Timeline: page_ready took 2.9 s, the upload 5.0 s, and the Send decision passed on its first attempt.
  - Defect: confirm never bound (about 2.5 min) because R4F's hydration rewrite applies to every facts read. A
    conversation page hides its composer while thinking, so it looked like loading. Reconcile bound the turn and
    the job completed.
  - R4F3 is fixing it (scope the rule to `page_ready`).
- R4F3 merged (`e34af41`): both targets normalise hydration only in prepare's `page_ready` observation; every other
  phase sees raw facts.
- **R4 accepted live (2026-11-09 01:40Z).** ChatGPT Pro ask with an attachment and a mid-wait runtime restart:
  - Timeline: prepare → `page_ready` → upload 5 s → Send (attempt 1) → confirm in 2.4 s → wait → SIGTERM to the
    runtime at 01:40:49. The job went `interrupted`.
  - Resume on a fresh runtime went straight to wait → collect → `answered`. The answer was correct (code word plus
    a computed count).
  - Exactly one Send click in total; the record ended `send_effect: sent`, and every owned tab was closed.
  - Together with the D3 resume (`437`, zero resends), all R4 acceptance items are now met live on both targets.
- Decision (orchestrator, 2026-11-09): the `submitted` and `answer_complete` thresholds stay as they are.
  - `answer_complete`: the oracle collects through deterministic finality, not this judgment.
  - `submitted`: a deny in confirm only leads to a read-only reconcile, never to a resend.
  - Revisit if a live run shows a stall.
- R5 (2026-11-09, owner-approved): architect design decided in `tmp/tasks/R5/design.md` (archived with R5a).
  R5 runs as R5a (records, external registration, observation, pure tree composition) then R5b (panel,
  presentation, summaries/dry-run, performance).
- R5a merged (`1817a64`): optional association timestamps and native refs (no native-ref writer yet: the facade
  holds no complete ref), `hud observe-herdr` external registration, bounded read-only job collector (herdr
  list matched to recorded agents only; Jev liveness from `runtime.json` + `/proc`, no socket), pure
  composition into `SubagentTree` (one node per job; exact-ref dedupe enriches the native node). Archives:
  `docs/reviews/2026-11-09-r5-*`, `2026-11-09-r5a-review-*`. Merge gate on the integrated tree: unit 4007/0
  fail, mjs 381/0, hud-mcp 211/0, WP0 1176/1176 — the first fully green gate. Next: R5b.
- DEBT1 merged (`18dca62`): B11 spaces path (missing fixture dependency), cloud preview self-test (stale
  inventory; now checked against real build output, run after builds), load-sensitive statusline (test-child
  clock pin + real-clock degradation tests), panel publisher and runtime-compose fixture guards (measured).
  Production deadlines unchanged. Remaining load-sensitive failures are recorded in the DEBT1 report, not fixed.
  `format:check` still fails on 20 untouched baseline files; a format-only commit follows the R5a merge.
- PIGUARD merged in Fishpref (`19d2828`): the pi-roles reviewer guard no longer treats a quoted `>` in simple
  commands as a redirect; complex shell syntax keeps the old raw check.
- R5b merged (core `4eb53a0`, ui `0ca866a`), so R5 is code-complete.
  - Core: live panel job pipeline (generation fences, all-roots composition, afterPaint), `hud panel --root`,
    final action fence for observation-only ids (mouse and keyboard), job material excluded before
    brief/progress/model planning, dry-run omission notice, global coverage into the existing partial notices.
  - UI: effective status at render time (stale non-terminal → `?`, no running glyph or clock), job name/role/backend
    badge in rows, Inspector job sections (`src/render/job-details.ts`), Timeline admits native terminal events
    only when they agree with the job.
  - Reviews: `docs/reviews/2026-11-09-r5b-core-review-*` (accept round 2), `2026-11-09-r5b-ui-review-*` (accept
    round 3).
  - Merged-tree gate: unit 4079/0 fail (24 skip), mjs 383/0, hud-mcp 212/0, WP0 1176/1176, format clean.
  - Live look (owner, 2026-11-09, staged by `scripts/demo-r5-jobs.mjs` on branch `r5-acc`): cards read as process
    state, not work progress. Decision in concept §15 "Agent cards show work progress, not process state".
    Hermes stalled on a multi-line prompt (killed after 11 min); retry with a single-line prompt later.
  - Next: R5-UX, refocused the same day (concept §15 "Home page: decisions made for you"): home page = decisions
    made for you, needs you, work progress, one-line workers; detailed cards move to an Agents tab. Argon layout
    proposal requested (`tmp/tasks/HOME-ARGON/`); architect card design archived for the Agents tab. Then R6.
  - Follow-ups: job-scoped material authority; per-root change stamp; no native-ref writer yet (exact-ref
    enrichment is fixture-only).
- R5-UX planned (2026-11-09). Layout approved by the owner from mockup `HOME-VIS4` (concept §15 "Home and Work tabs:
  approved layout"); display only, passive data, model roles and the HUD's own credentials file decided the same day.
  Architect plan archived in `docs/reviews/2026-11-09-r5-ux-plan-architect.md`. Packages:
  - P1 passive records + Home + transitional Work merged (`9d18bff`; reviews
    `docs/reviews/2026-11-09-r5ux-p1-review-{1..5}.md`, accept on the fix-round-4 re-check; gate on the merged tree:
    unit 4157/0 fail, mjs 465/0, hud-mcp 218/0, WP0 1176/1176, format/fixtures clean). Follow-up: A1's
    `runtime-install.test.mjs` "fix1 output ENOSPC" test failed once under load (empty stderr) and passed alone 3/3;
    load-sensitive, watch it;
  - KEYS merged (`7ef5b2f`; reviews `docs/reviews/2026-11-09-r5ux-keys-review-*`, accept round 2; gate on the
    same code: unit 4092/0 fail, mjs 391/0, hud-mcp 212/0, WP0 1176/1176, format clean). Owner machine configured:
    `~/.hud/credentials.env`, `~/.hud/config.json` (Jev + AI Studio, migrated from the jev-ask TOML), HUD settings on
    `https://api.mistral.ai/v1` with `deepseek-v4-1-flash-1017` at none/low/high (live check: 200 on all three tiers,
    0.7–1.7 s); settings backups `hud-settings.json.bak.20261109-keys`;
  - P2 final Work lanes and cards + 110-column peek (after P1);
  - P2c cleanup (after P2): remove the test-only no-sidecar `renderMonitor` path and migrate its fixture tests (P2 q4);
  - P3a job material authority (parallel with P2 in disjoint files), P3b option-B sentences (after P2 + P3a);
  - later: decision-provider judgements (`≠` when rules are unsure, card attention, stall category).
  Parallel plan (owner approved 2026-11-09): line A P1 → P2 → P3b; line B P3a → decision-provider judgements (after
  P1); line C R6a packaging/installation; line D R7 scenario and Hermes script preparation; R6b retirement after
  R5-UX merges. At most three implementers at once.
- R6a planned (2026-11-09): architect plan plus the decided amendments in
  `docs/reviews/2026-11-09-r6a-plan-architect.md`. Concept §15 "Plugin independence" (same day): everything under
  `$HUD_HOME` for every harness, Codex included; old locations only through `hud import`; Jev keeps the shared Chrome
  as explicit config; pi-roles is built into the HUD. Packages: A0 independence (after P1), A1 release/activation,
  A2 ordinary-session binding (A1/A2 first), A3 panel control, A4 Claude plugin, A5 pi package and status segment,
  A6 role-summary cache, A7 `tree-page.ts` lifecycle hunk (after P2), A8 Codex activation and rehearsal, PIROLE
  (pi-roles built in; plan `docs/reviews/2026-11-09-pirole-plan-architect.md`, slices PR1–PR5, PR1 when a slot frees).
  A2 merged (`bd13045`, reviews `docs/reviews/2026-11-09-r6a-a2-review-{1,2}.md`): per-call binding for Claude,
  Codex and pi; ordinary Codex 0.167.0 daemon-backed MCP admission is refused (`identity_unverified`, ancestry ends
  at the app-server daemon), so a Codex consult (A2b, `docs/reviews/2026-11-09-a2b-codex-admission-architect.md`) decided: Codex role calls
  stay fail closed (concept §15); the disclosure text and refusal tests fold into A8; the live provenance
  qualification is deferred (owner item).
  A1 merged (`8f972aa`, reviews `docs/reviews/2026-11-09-r6a-a1-review-{1,2}.md`): release staging and reversible
  activation through `hud install` / `hud uninstall`; integrated gate green. PIROLE PR1 merged (`856e576`, Codex trial).
  R5-UX P1 merged (`9d18bff`). PIROLE PR2 A/B decided (owner): **pi flow** (record `docs/codex-vs-pi-ab.md`: pi 0
  open major, $3.49, 93 min; Codex 1 open major, $4.76, 44 min). pi arm merged as PIROLE PR2 (`c8eba24`, reviews
  `docs/reviews/2026-11-09-pirole-pr2-review-{1,2}.md`); Codex arm kept on branch `pirole-pr2-cdx`. All roles back on
  pi; pi-roles optimised for throughput (Fishpref `ed0cf77`: check logs, background suites, reviewers verify logs).
  PR3 design inputs: `tmp/tasks/PIROLE-PLAN/design-after-pr2.md`. Token cost from toktrack only after a rescan
  (`toktrack daily --json`) and full pagination. Next: P2, A0 on the pi flow (≤ 3 implementers).
  The r5-acc demo stage is merged (`1f20f01`).
  PIROLE PR3 and R6A-A0 merged together (`ab76c25`, `743ec27`; reviews
  `docs/reviews/2026-11-09-pirole-pr3-review-{1,2}.md`, `docs/reviews/2026-11-09-r6a-a0-review-{1,2,3}.md`). Merged-tree
  gate: unit 4276/0 fail, mjs 708/0, hud-mcp 219/0, WP0 1176/1176, 12/12 PIROLE mutants, fixtures/format/diff clean.
  PR3: worker-only pi extension, `call_sonic` for every non-sonic role (nested sonic in a split of the caller's pane,
  borrowed reservation, unresolved child keeps the slot), implementer autoclose on unused grace, release-relative A1
  inventory for the reaper, pi 1.5.0 lazy session file handled; nothing selects it until PR4. A0: one resolver
  `src/hud-home.ts` (`$HUD_HOME`, default `~/.hud`; display state `$HUD_HOME/display/`), `hud import preview|apply`,
  explicit Jev locations, decisions primary/fallback, Mistral/DeepSeek defaults; six WP0 entries replaced (q7).
  **Owner item:** before running a build with A0, `hud import preview` then `apply` with `--from` the chosen
  `hud-settings.json` and jev-ask TOML (report: `tmp/tasks/R6A-A0/report.md` §4); the old saved briefing key is not
  carried over. Follow-ups: PR3 cost test `cold fake launch` ends `close_unresolved`/`process_unknown` under heavy
  load (3/3 alone) — check process-identity probing under load in PR4/PR5; reviewer guard blocks `mkdir` in the temp
  dir (pi-roles and product guard); known load flakes run-light-leader INT harness, managed-codex-adapter callbacks.
  Next: P2 finishing; P3a and A3 launch on this head; PR4 after P2 (shared collectors).
  R6A-A3 merged (`ef7e8d9`; reviews `docs/reviews/2026-11-09-r6a-a3-review-{1,2,3}.md`): herdr panel control for the
  main session in `src/integrations/panel/` (display-only receipts under `$HUD_HOME/display/panels`, intent before
  split, launch tokens, generation fences, `isCurrent()` epoch seam for A4/A5, single-flight lifetime monitor, internal
  `hud panel open|close|toggle|status`). A lost split reply stays `uncertain` with an orphan-pane hint (explicit reopen
  only); absence needs a failed `pane.get` plus the recorded workspace's list. Orchestrator fix at acceptance: the panel
  env keeps the caller's settings path (neutral name, then the `CODEX_HUD_` alias). Gate on `ef7e8d9`'s tree: unit
  4298 with one failure = `run-light-leader.test.js` hung for ~2 h under load (stopped; 53/53 alone), mjs 708/706,
  hud-mcp 219/218, WP0 1176/1176, mutants 12/12 + 7/7 panel. Real right-split/focus acceptance stays NOT_RUN (needs an
  isolated herdr). Follow-ups: `run-light-leader` H05 can hang a whole unit run (no per-test timeout; seen twice);
  load flakes also include `claude-regressions` evicted-duplicate (20 ms reader slice) and RUNZ1 census.
  Review policy (owner, 2026-11-09): `Review tier: display` ≤ 2 rounds, `safety` ≤ 3; re-check rounds block only on
  realistic or safety defects (`docs/delegation.md`; pi-roles `5748105`).
  R5UX-P2 merged (`30d855d`, integration merge `699da79` onto the A0/A3 head; reviews
  `docs/reviews/2026-11-09-r5ux-p2-review-{1..4}.md`, accept on round 4, the one extra round approved under q24).
  Work is now compact shared cards (`src/collectors/work-card.ts`: needs-you / in-progress / awaiting-acceptance /
  stalled / done; `src/render/work-{card,lanes,visibility,inspector}.ts`) with current-episode QA and helper proof, a
  110-column Home peek and `cardStallMinutes` (1–120, default 10); retired rich-card presets moved to a test fixture.
  Merge resolution:
  - reference docs keep P2 text with `$HUD_HOME/display` paths;
  - settings and `main-features.json` keep both A0 and P2 divergences, with recomputed replacement hashes;
  - two P2 tests adapted to the removed `briefingApiKey`.

  Gate on `699da79`:
  - unit 4366/4336, with 4 load-timing failures (B19 drainer 50 ms, managed-codex-adapter callbacks, P2 render
    timing), all green alone;
  - hud-mcp 219/217, with `managed-target` partial coverage green alone;
  - mjs 708/706/0, visual 331/331, WP0 1176/1176;
  - mutants, fixtures, format and diff clean.

  New load flake: the P2 render-timing test. Known limits:
  - Work QA is stricter than the shared `JobRequest.current`;
  - an unknown-start primary has no report-mtime ≤ settle upper bound (q23).

  Next: A6+A7 merged into one package (R6A-A67: panel self-registration and lifetime plus the role-summary cache);
  then A5; P2c, PR4 and P3b (after P3a).
  R5UX-P3A merged (`f3fffa1`, clean merge `6a88620`; reviews `docs/reviews/2026-11-10-r5ux-p3a-review-{1..4}.md`, accept
  on round 4, approved under q16). This is the inert job-material boundary:
  - default-deny authority scoped to canonical home, exact root, invocation and episode, with concrete recipient
    consent;
  - bounded public output reductions (16 KiB, 32 fragments);
  - a job-only request and typed-pending path in `small-model.ts`, with guarded settlement, a final publication fence
    and reservation cleanup;
  - native material formats unchanged.

  Gate on the merged tree: unit 4412/4386/0 fail, mjs 708/706, hud-mcp 219/218, visual 331/331, WP0 1176/1176;
  mutants, fixtures, format and diff clean. P3b is now unblocked.

  FIX-RLL-HANG has two causes. First, INT/TERM arriving while a group-leader shell reads the protocol drops partial
  bytes: the protocol readers now ignore INT/TERM. Second, the waiter's interrupted `wait` retry can yield `DONE -1`,
  which the leader rejects and then waits for forever. Decided under q4: the waiter ignores INT/TERM only after the
  workload fork, and waits exactly once. Per-test timeouts and the test's own process-group cleanup are added too.
  Safety review accepted on round 2 (`docs/reviews/2026-11-10-fix-rll-hang-review-{1,2}.md`). Merged `78a3f74`.
  Evidence: file alone 92/92; 20/20 loaded whole files with zero hangs; 500 uninstrumented topology attempts with zero
  hangs (the old code hung at attempts 290, 201 and 33). Gate on `78a3f74`:
  - unit 4493/4466, with 1 failure: P2 render timing, which passes alone. `run-light-leader` completed inside the
    full suite.
  - mjs 725/723/0, hud-mcp 219/218, visual 331/331, WP0 1176/1176; fixtures, format and diff clean.

  The "run-light-leader INT harness" load flake is retired.

  2026-11-10 merges (`ed689cb`, `a854f59`, `fa5c5c3`, orchestrator test fix `29c29bf`):
  - **R6A-A67** (reviews `docs/reviews/2026-11-10-r6a-a67-review-{1,2}.md`, accept on round 2):
    - `hud panel` with any `HUD_PANEL_*` marker registers itself in the same process and installs its lifetime;
    - the schema-1 role-summary cache under `$HUD_HOME/display/role-summary`;
    - the Claude statusline `Work:` segment for the exact root.

    Real herdr split/focus is NOT_RUN.
  - **R6A-A4** (reviews `docs/reviews/2026-11-10-r6a-a4-review-{1,2,3}.md`, accept on round 3): the Claude `hud`
    plugin, including:
    - templates and materialization;
    - hook and MCP adapters;
    - `/hud:hud`, `/hud:setup`, and the optional bare `/hud` alias (proof-gated);
    - statusline activation orchestration and the native write-set rehearsal.

    The external hook timeout is NOT_VERIFIED as safe interception (q11). Nothing is activated live; owner rows §H 4–6
    are in its report.
  - **FIX-CLOCK-LEAK** (review `docs/reviews/2026-11-10-fix-clock-leak-review-1.md`, accept): `r5Fixture` wrote real
    wall-clock mtimes while injecting 2026-11-09. Once the date passed, Home dropped the day's decisions, and
    `workboard-fix4` / `workboard-visual-facts` failed. The fixture now stamps files with its own clock. Clock-shift
    regressions run at +2 and +400 days. No production change.
  - **Orchestrator fix at acceptance** (`29c29bf`): the claude-plugin "JSON alone" assertion probed the host process
    tree, and under a real Claude ancestor gave `panel_origin_unverified`. It now injects the no-proof probe.

  Gate on `fa5c5c3`, with reruns alone on a loaded host (load average 60, FIX-RLL's synthetic load):
  - unit 4454/4426, with 2 failures: P2 render timing and `statusline-native-details`, whose summary line was missing
    under load. Both pass alone at normal load (46/46).
  - mjs 725/721, with 2 failures: runtime-activation mutants (pass alone), and claude-plugin, fixed in `29c29bf`
    (16/16).
  - hud-mcp 219/218, visual 331/331, WP0 1176/1176; fixtures, format and diff clean.

  Watch item: A67's statusline `Work:` segment shares the read budget with the legacy summary. Under heavy load the
  summary line can drop, so check it at R7 under normal load.

  - **R6A-A5** (`715ad1d` / `f1d086e`; reviews `tmp` R6A-A5 review-1 changes-required, review-2 accept): the pi
    `hud` package (one `/hud` command, six private-channel role proxies, lifecycle fencing, A3 panel through
    native/herdr corroboration) and the bounded `hud-delegation` status segment; p10k stays the footer owner. Row 7
    and row 10 select the package through A1 preview/apply/restore. Live herdr split, owner footer visibility and
    real activation are owner gates for R7.
    - Focused merged check on `f1d086e`: builds; A5, activation, Claude-plugin and panel-control tests; 9/9 mutants;
      fixtures, format and diff: all pass. The full gate runs once, after P3B and PR4 merge.
    - Follow-ups: qualify an ordinary `/fork` for the panel; an A3 lifecycle-versus-manual close reason (covers
      reload); check the panel-control test's timeouts (it hung once under swap pressure, and passes alone).

  - **R5UX-P3B** (`47e4406` / `ab957f6`; reviews tmp R5UX-P3B review-1 changes-required with two reproduced
    defects, fixed; review-2 accept): option-B job sentences on Work cards, the 110-column peek and the Inspector,
    behind a default-off consent action that writes the job-material policy for the displayed recipient.
    - Collection is scheduled inside the remaining collector budget. Three extraction slots; the Inspector keeps its
      sentence without making new requests; model attention is display only.
    - Focused merged check on `ab957f6`: builds; 209/209 focused; visual 331/331; WP0 1176/1176; fixtures, format and
      diff clean.
    - Watch item for R7: collection p95 rises about 1 ms when quiet, and from 12 to 16 ms when scrolling 100 jobs.
      Render is unchanged (an unchanged card is about 0.3 ms).

  - **PIROLE PR4** (`f0825c0` / `a5343ce`; reviews tmp PIROLE-PR4 review-1 changes-required, review-2 accept): the
    facade cuts over to owned pi execution.
    - New pi jobs freeze owned contracts and launch through the owned runtime. Send, QA and close use the pinned
      release plus the runtime binding. Legacy v1 receipts drain read-only.
    - Acquisition verifies the installed A1 release, the herdr instance and the caller pane from process ancestry,
      with no source or PATH fallback.
    - Nested helper QA is decoded with bounds.
    - A1 seam fix (q5): a retained release is verified against its own manifest; incoming bundles stay strict.
  - **Batched full gate on `a5343ce`** (A5 + P3B + PR4), with no failures and no reruns:
    - unit 4519/4493/0 fail, mjs 764/762/0, hud-mcp 219/218/0, visual 331/331, WP0 1176/1176;
    - pi-owned mutants 18/18; builds, fixtures, format and diff clean.

  2026-11-10 testing change (owner): tests are designed at project scope; see `docs/delegation.md` and
  `docs/reviews/2026-11-10-test-volume-audit.md`. TEST-SLIM (approved) comes before R6b. Stage 0 builds the project
  test map (`docs/testing.md`), the inventory and the consolidation proposal.

  TEST-SLIM-0 (`80736fa`): the project test map draft `docs/testing.md`, plus the proposal and reviews in
  `docs/reviews/2026-11-10-test-slim-0-*`. The proposal kept every unique assertion and so estimated only about 2%;
  the owner chose to cut by behaviour (see `docs/reviews/2026-11-10-test-volume-audit.md`).

  Order change (owner, 2026-11-10): the product comes first, and TEST-SLIM uses spare capacity.

  Running:
  - **R6A-A8 + PIROLE PR5**, one package: Codex activation, the release rehearsal from a staged artifact, real-client
    smoke, the cost table and the owner runbook `docs/release-runbook.md`;

  Merged: TEST-SLIM-1B (`f0a555c`, shared stand-ins); TEST-SLIM-1A (`41fdb65`, opt-in `npm run test:perf`, 31 cases
  moved, unit wall 320 s to 224 s). Gate on `41fdb65`: all green except one load-sensitive B6 idle-wait write count
  (passes 3/3 alone; old ledger code, removed in slice L). The perf suite's B6 cancel p95 failure goes with slice L too.

  Merged: FIX-UNPIN (`4a43cb3`): the Claude hook helper, Claude configuration observer and herdr client no longer
  admit by exact vendor version (2026-11-07 decision); schema, protocol and behaviour checks stay. Remaining pins sit
  in slice-L code (`src/harness/claude/managed-*`, hud-mcp `managed-runtime.ts`); the capability-manifest version
  tuples are checked at the slice-L re-census. TEST-SLIM-2A (`35531ef`): nine display test files, 823 lines (12.8%)
  cut. Gate on `35531ef`: all green, no reruns.

  Merged: R6B-1 (`022c75c`): slices P, T and W retired (5.8k lines) and the read-only drain audit
  `scripts/audit-r6b-drain.mjs` added. Gate on `022c75c`: all green, no reruns. Slice L waits for A8, the owner's
  install and `--slice runtime`.

  2026-11-10: the owner approved R6b slice L (full retirement, concept §15 "R6b full retirement approved"), including
  the WP0 exception for the `hud run` cases in `b11-cli.test.ts`.

  2026-11-10 (owner): the HUD replaces claude-hud and p10k-footer at parity (concept §15). Two packages:
  **STATUSLINE-PARITY** (Claude) and **PI-FOOTER-PORT** (pi). The A8 release installs first; the parity release
  switches the Claude statusline and the pi footer.

  2026-11-10 (owner): one installer package (concept §15 "One installer package with core and extensions"):
  release archive + `./install`, components core + extensions, `hud install|uninstall|upgrade|status`. Architect
  consult INSTALLER-ARCH running; implementation starts after A8 merges. The owner installs with the installer, not
  the row runbook.

  Next:
  - R6b slice L, after A8 merges, the owner installs, and the drain audit passes (`--slice runtime`);
  - R7 acceptance, whose plan is drafted alongside;
  - the TEST-SLIM area slices, only when a slot is free.

| Package | Deliverable | Acceptance |
| --- | --- | --- |
| R0 — Scope and baseline | Apply the concept §15 scope entry and the companion document updates for this queue. Preserve WP0, J1/J1b/J2, relevant fixtures/licenses, and retained HUD features. Remove WF1 executor work from the active queue. | One active implementation plan; bash tests/run-main.sh baseline recorded; no weakened main assertions or scenes. |
| R1 — Roles, bindings, and skill | Define the five roles, oracle phases, routing.toml, session-scoped selection, capability validation, and static skill. Import actual backend settings from installed recipes. | Switching a preset changes the next dispatch; existing jobs remain unchanged; two main sessions can select independently; incompatible role bindings fail clearly. |
| R2 — Herdr-backed MCP facade | Implement the six tools for CLI jobs, stable parent attribution, atomic job receipts, same-key serialization/reconciliation, supported question adapters, continuation, and explicit cleanup. Reuse existing launch recipes. | Pi/Grok and supported Codex/Claude recipes work through the common API; Pi questions round-trip; duplicate/ambiguous creates do not relaunch; missing herdr is reported honestly; no TUI is required. |
| R2b — Pi roles through pi-roles dispatch | For pi-backed roles, `hud_create` calls `pi-dispatch` with the task contract, `hud_read` reads the task STATUS files, `hud_close` calls `pi-role-reap`. Role map imp→implementer, sonic→sonic, reviewer→reviewer, plus architect. DONE/FAILED events feed the wake path. Fallback to the current direct launch when pi-roles is absent. | A pi imp started through the MCP calls sonic and the reviewer itself, exits on its own after settling, and its DONE reaches the main session through the wake path; `hud_close` leaves no agent or tab; without pi-roles the old path still works; R2 tests stay green. |
| R3 — Owned Jev runtime and judgments | Extract a lazy Jev-only runtime from reusable IPC/lifetime pieces. Connect src/jev, preserve J2 records/leases, and complete both judge() provider mappings. Map it into the same job API. | Direct browser and read-only judgment jobs work; TypeSafe/OpenAI are selectable; disconnect ends observation only; runtime cleanup is bounded; no CLI-launch modules load. |
| R4 — Web-oracle targets and recovery | Complete ChatGPT support and add a distinct AI Studio adapter from the existing owner driver. Complete wait/reconcile/result collection. Preserve cross-language compatibility while old and new writers coexist. | Prompt/attachment handling, target selection, send evidence, result extraction, crash windows, and same-key recovery pass for each target. Recovery never repeats Send. Both decision providers are checked. |
| R5 — Unified tree and retained summaries | Adapt the tree/collectors to one job per invocation, role/phase/backend attribution, pending requests, results, and external herdr tasks. Preserve non-Codex roots, Pi footer, generic materials, brief/dry-run, and production summary restoration. | One tree correctly shows CLI, native descendants, oracle-through-Jev, and direct Jev jobs; no duplicate “oracle + Jev” nodes; stale observation is honest; main visual behavior remains protected. |
| R6 — Installation and retirement | Install the small facade and skill/shims. Replace the general native execution path only after herdr and owned Jev paths pass. Drain existing live handles through their owning version. Remove unused direct-launch adapters, obsolete bridge wiring, and dependencies. | CLI-only use starts no detached HUD execution host; Jev starts only its narrow runtime; existing work is not killed or replayed during migration; old/new control paths do not compete. |
| R7 — End-to-end acceptance | Validate all three supported main harnesses, representative concrete bindings, both oracle phases, repair continuation, questions, provider switching, restart/recovery, cleanup, and WP0. | Actual results and limitations recorded. Fixture success does not substitute for real parent notification or browser-target checks. |

Native-v2 mapping: keep attribution, observation, tree, summaries, and necessary parent integration. Replace its execution interfaces with the role facade. Cancel its general agent host, process-group sweeps, agent idle/abandon timers, direct native dispatch adapters, and workflow fields. Keep useful herdr code during pruning.

Jev package mapping: retain J1/J2; finish J1b judgments; implement J3a plus a new AI Studio package; retain J4; narrow J5 to the Jev-only runtime and common facade; retain J6/J7/J8/J9 as relevant. Gemini consumer-chat and Flow remain separate targets; neither is required to satisfy the newly specified ChatGPT Pro + AI Studio scope.

WP0 remains necessary, including its documented qualification that several model-feature carriers currently use the B17 test double. Production summary restoration and the accepted <dir>/cache.json location remain active work.

## Local validation phase (from 2026-11-07)

After the native thin delivery (`aa4b9dd`) development is back on the owner's machine, to run the real-client checks the cloud could not run ([local validation guide](../cloud/handoff/native-hud-local-validation.md)). Routing is in `docs/delegation.md`. Remote sessions should not merge into `universal-hud` during this phase.

Status:

- **LV0, local baseline:** on this machine (Unix sockets and procfs available) the cloud's socket/procfs/ptrace failures do not occur. Five remaining failures were fixed: three Claude render tests assumed `NO_COLOR`; a Pi bridge test opened the no-longer-created ledger file; and a real regression in the historical MCP composition (the lazy `call-budget` import in `server.ts` let a second same-chunk call advance the clock before the first call's admission check) — historical callers now supply the budget synchronously via `bodies.budget`, and the native default still loads no ledger module. Full local run after the fixes (WSL2, Node 24.22.1, non-tmpfs `TMPDIR`, `NO_COLOR` unset): builds PASS; MCP 210 PASS / 1 opt-in benchmark SKIP; core 211 PASS / 1 SKIP; unit 3350 PASS / 16 opt-in SKIP / 1 FAIL (`RUNZ1 same-session outsider…`, which ran while another agent was rebuilding `dist`; 24/24 PASS when rerun alone); mjs 317 PASS / 1 optional-Pi SKIP / 2 FAIL — both in `runtime-compose.test.mjs` (`installer-apply: deadline`, the fixture's fixed 15 s child deadline under full-suite load; their ~31 subtests then do not run). That file passes 33/33 alone and passed in the first full run. Recorded as load-sensitive; no deadline was changed.
- **LV1, validation kit:** `scripts/local-validation/` ([kit doc](../cloud/handoff/local-validation-kit.md)) sets up an isolated `HUD_HOME` and launches real Codex/Claude/Pi with hud-mcp attached for one session, without editing user configs. `smoke-discovery.mjs` checks tool discovery for all three without model spend.
- **LV2–LV5, real clients:** Codex, Claude and Pi pass create/send/read, parent exit with the host continuing, same-parent resume, cross-session refusal, explicit child resume and close/drain; Jev passes create/run/snapshot/list, tab retention, isolation and explicit close. Details and eight findings (Codex queue-woken turns refused, child proxy/environment, Jev interpreter/credentials, Jev hosts not draining, among others) in [the results record](../cloud/handoff/local-real-client-results-20261107.md). The missing hud-mcp host entry found by the first run is fixed.
- **Design alignment (2026-11-07):** the owner reset the product definition — symmetric cross-harness dispatch (any of Claude/Codex/Pi as the main session), MCP as the single interface and TUI data source, non-interference with each harness's own workflow, Pi as the customisable exception, and removal of the historical delegation stack. Recorded in the [decision log](../universal-hud-concept.md) ("2026-11-07 本地对齐").
- **Next:** the active queue is R0–R7 at the top of this file. Scope is concept §15, "2026-11-07 Scope convergence: fixed roles, herdr execution, owned Jev".

## Authorized implementation status: native thin path (2026-11-07)

> Historical status of the 2026-11-07 native thin path. The current queue is R0–R7
> above. Scope: concept §15, "2026-11-07 Scope convergence: fixed roles, herdr
> execution, owned Jev".


The owner approved the revised [local native-session architecture](../architecture/simplified-harness-architecture.md), parallel implementation, and changes directly on `universal-hud`. This supersedes older sequencing, separate-branch and policy-framework requirements below **for this approved implementation**, not unrelated permission or safety requirements. The historical snapshots and their test counts remain historical.

Implementation is source-complete and independently accepted in the reviewed scopes, not production-verified. The default path is authenticated native caller → detached local connection host → official Codex app-server / Claude Agent SDK using the user's executable / installed Pi RPC, plus the existing Jev Agent bridge. It must not route through DelegationService, claims/slots, retirement, version qualification, or the draft managed session/operation tables. See the [updated reference index](../architecture/official-harness-reference-index.md) and supersession notes in contracts 01–07.

A follow-up design audit removed the remaining default caller-scope database dependency before publication. Native main/hook paths now use current native-session/process evidence without loading the historical ledger; one-shot evidence and isolation remain. Pi uses native storage defaults, and Jev forwards existing run yields without adding concurrency. See the verification record for the correction and narrow checks.

Required boundaries: per-native-session isolation; children continue after parent/MCP exit; explicit official resume; native request/response routing; existing three wake channels; existing HUD model summaries. These are acceptance requirements, not claims of successful live verification. The HUD chat UI remains out of scope. Old history remains read-only, with no migration into fabricated new task states.

Packaging work removes the pinned Pi CLI runtime dependency and retains the official Claude SDK as a real Node library dependency. Bundles use a reviewed lockfile-derived library closure, omit only the SDK's declared optional platform clients, and depend on the user's installed Claude executable. Reproducible package integrity is not a vendor-client version gate. No real installer, user configuration migration, provider/browser task, or production activation is authorized merely by this status note.

Packaging evidence for this implementation (2026-11-07): `node --test tests/unit/runtime-package.test.mjs tests/unit/runtime-install.test.mjs` passed **146/146**, with zero skips. This includes fixture-only installation safety tests and a real SDK import from the isolated reviewed library closure, then selection of an explicit synthetic user executable that exits without making a provider request. `node scripts/pack-cloud-preview.mjs --self-test`, focused formatting and `git diff --check` also passed. No full runtime archive was built and no real installer/provider/browser flow ran. Regenerate the library closure after an intentional lock update with `node scripts/runtime-package/update-dependencies.mjs`, format its generated `dependencies.mjs`, review that diff, then rerun packaging tests. The closure metadata is generated, not a hand-maintained client support list.

Source review and verification: see [the dated verification record](../cloud/handoff/native-hud-verification-20261107.md), including original failures, isolated reruns and environment limits. Independent rechecks accepted the runtime, display, packaging and subsequent bounded fixes. The owner explicitly authorized source delivery without waiting for local real-client tests. Use [the local validation guide](../cloud/handoff/native-hud-local-validation.md) for installed-client creation/resume, callbacks, reconnect, idle/busy wake behavior, Jev and terminal validation. No real provider/installer acceptance is claimed; historical candidate counts are not reused as evidence for this reset.

> **2026-11-05 cloud-development update:** See [the current cloud handbook and revised C–F roadmap](../cloud-development/README.md). Its development sequencing, simulation guidance and validation scope replace contrary blanket phase-order, local-only and every-package check requirements below. Applicable functional integration checks, security contracts and production capability gates remain in force; the historical record below is preserved.

## Current integration snapshot (2026-11-06)

Source inventory at commit `95dac1bdd40583f6015ed686d4be4feef79cf916`, tree
`774f1a81a1727d013ceea8b81978f5a5af1beb8b`. These are implemented slices, not
whole-milestone acceptance or production qualification:

- [Pi observation](../cloud/pi-ordinary-observation.md), [synthetic protocol
  workbenches](../cloud-development/checks-and-preview.md), [vertical delegation
  workbenches](../cloud/m2-vertical-workbench.md), and the [fake-only Jev
  laboratory](../cloud/c45-jev-fake-simulation.md).
- [Experimental managed Codex/Claude/Pi preparation](../cloud-development/managed-targets.md)
  and the [opt-in Pi delegation bridge](../cloud/pi-delegation-bridge.md). Both shipped
  capability manifests remain empty; partial Claude/Pi configuration coverage
  still refuses production promotion.
- Claude committed action/Todo panel visibility (included in the [focused cloud
  check scope](../cloud-development/checks-and-preview.md)), [product statusline
  entrypoints](../cloud/product-cli.md), [shared partial direct-child
  summaries](../statusline/delegation-summary.md), and the [opt-in Pi footer](../cloud/pi-footer.md).
- [Owner-scoped delegate_list](../cloud/e4-delegate-list.md), [guarded panel Open
  and bounded logs](../cloud/e1-panel-open-logs.md), [reversible display-settings
  migration](../cloud-development/reversible-migration.md), and [cloud checks and
  runtime package preview](../cloud-development/checks-and-preview.md).

[Cloud workflow run 42135963414](https://github.com/CartmanFatass/codex-hud/actions/runs/42135963414)
completed successfully for this exact commit on Node 22.x and 24.x. That is the
focused cloud workflow's result, not full-project, missing-test or performance
qualification.

The preview is not a standalone installer. This documentation runs no settings
preview/apply/restore command. Separate Jev candidate `59e4b0a6` and ongoing
D2/statusline work are not included in this fixed baseline's delivery inventory.
The older queue and statusline-wiring notes below are historical. This snapshot
does not erase the recorded B10D/P065/C3 failures or holds, certify real providers,
or establish missing functional checks or performance qualification.

From 2026-11-03 development runs remotely: first Claude Code cloud (`docs/cloud/README.md`), then dots
(`docs/cloud/dots.md`). The local machine only does the work listed under "Local only". This file replaces the
local orchestrator's scratch notes. Keep it current: the remote orchestrator updates it whenever a package merges
or a decision is taken.

Read first: `AGENTS.md` (the remote entry point), `docs/cloud/dots.md`, `docs/universal-hud-engineering-plan.md` §1
and §4, `docs/universal-hud-concept.md` §15 (decision log), `docs/handoff/integration-notes.md`. `docs/delegation.md`
describes the former local routing only.

## Remote roles

| Phase | Implementer | Oracle (architecture, design incl. frontend, review) |
|---|---|---|
| Claude cloud | per `docs/cloud/README.md` (Opus high for core and tests, Sonnet xhigh for rendering) | Opus max |
| dots | Astra high (all packages, frontend included) | Astra max |

Owner decisions of 2026-11-03:
- In remote phases the Oracle also decides frontend design forks. Locally that was a Fable max subagent.
- On dots, the main session only dispatches. Every judgment goes to a subagent; see `AGENTS.md`.

## Merging (changed 2026-11-03)

The remote orchestrator merges accepted packages into `universal-hud` itself; there is no local merge step any more.
Merge only when:
- the package's Oracle verdict is `accept`;
- an Oracle has verified the report against the branch;
- the full check set in `docs/cloud/README.md` is green on the merged tree, with known flakes rerun alone and both
  runs recorded.

Rules for every merge:
- Use `--no-ff`; never force-push, never rewrite history, never commit to `main`.
- Only one environment merges at a time: whichever phase is active.
- After each merge, update this file and the plan §1 status line (`docs/universal-hud-engineering-plan.md`).

## Status

**Merged on `universal-hud`** (newest first):

- C3 dependent set: HYG2/NODE22-PROXY, MCP-ANCESTOR and RUNZ1/RUNZ1-KILL, merged on 2026-11-04
  as `5d2c0709c8e9674254214add15f2a04cfd606443`. See the C3 integration checkpoint below.
- HYG1, the clean cloud test baseline, from cloud run 2. Its handoff is `docs/cloud/handoff/hyg1.md`. One test stays red
  on purpose: `run-control`, which RUNZ1 fixes.
- The cloud run-2 docs, summarised in `docs/cloud/handoff/run-2.md`.
- B10B-s2, the delegation panel: cloud run 1. See `docs/cloud/handoff/b10b-s2.md`.
- B12M, metered recovery reads: cloud run 1, additive. See `docs/cloud/handoff/b12m.md`. B10D adopts it.
- B10b segment 1: the delegation presentation core, bar and statusline line 2.
- B10C:
  - the observation publisher, with production publishing **off**;
  - the native node `{title, kind}`;
  - the owner-approved worker route and split timing gates, recorded in contract 06 「B10C 增补」 and
    `docs/reviews/2026-11-02-astra-b10c-worker.md`.
- B10A: data and tick wiring.
- Earlier: batches 1–5, B13. See plan §1.

Local acceptance of the merged tree (`b42ab16`, WSL, 2026-11-03): build, `npm test` (2329 + 47 pass, 0 fail; HYG1's
red `run-control` test passes on WSL), core, visual 319/319, hud-mcp 83/83, format and fixtures are green; b12m perf
passes. The `b10b-s2-perf` compact changed tick is borderline: p99 10.151 / 8.389 / 9.290 ms over three runs against
the 10 ms gate (rich changed tick 8.77–9.06 ms, rows200 cold 5.63–5.93 ms). Treat a single run above 10 ms as a known
flake only after rerunning it alone, and record both runs; B10B-S3F reruns the gate three times.

**Stopped, not accepted:** B10D, the observation worker. Branch `b10d-worker`, commit `4f2c4ac`, pushed as frozen work
in progress and NOT mergeable. It is based on `6fcf08a`, so merge `universal-hud` (`997c4ab` or later) into it before
any further work. That merge also brings in B10B-s2, which the panel needs to paint delegation content.

The final Oracle verdict is NOT ACCEPTED. Evidence is in `docs/handoff/b10d/`:
- `report.md`, which contains the Handoff section;
- `oracle-1.md`, the design rulings §1–§19;
- `oracle-review-1.md` and `oracle-review-2.md`;
- `performance-summary.json`.

What works:
- Worker isolation. Store stalls of several seconds no longer block paint.
- Legacy output stays byte-identical, with publication only in the worker and zero workers for CLI status/wait.
- 156/156 focused integration tests pass, and the full checks pass.

What fails, measured at n = 1000 per population on 200 nodes and 20,000 headers:

1. **Legacy collection.** The Codex subagent tree and file listing run on the main thread and cost about 85–132 ms
   per tick. This holds on today's synchronous path too: the matched synchronous reference already fails P-06-7 at this
   profile.
   - Bar paint p99 is 93–154 ms; bar operation p99 is 112–282 ms.
   - Simultaneous mixed: bar paint p99 168 ms (max 212 ms), full operation p99 253 ms (bar) and 338 ms (panel).
2. **Storage stalls.** A single `publishPrepared` call took 888 ms, giving an operation max of 1,184 ms. The worker
   keeps paint unaffected, but the operation gate fails.
3. **Liveness.**
   - The 16 reader slots fill with checkpoint-only recoveries, which hold no native reader yet. Full fair traversal plus
     the 15 s lease expiry can rebuild them repeatedly.
   - Large shares of the new-checkpoint and mixed populations fail with `reader_slots_pinned`: 791–920 of 1000.
   - The 30-minute paired soak's no-rescue drain left 166 of 200 targets unsettled after 5,000 operations.
   - §18 also pins accepted history that cannot be proven evictable, such as approval pauses and ended turns.
4. **Retirement recapture.** Progress evidence is still missing.

The owner-authorized §19 fairness exception is Oracle-confirmed in [B10D route §4 and §8](../cloud/rulings/b10d-route.md#4-confirmed-fairness-exception) and recorded in contract 06 “B10D 公平续读增补”, design §6 #13 and concept §15. A normal fair admission that completes verified exact recovery but has no first native result because its granted slice ended may create one ticket for the next already-authorized ordinary collection opportunity's single reader grant. Bind it to full session identity, scope/source generation, exact accepted target and authority generation/current compatible context. Spent, refused or unusable attempts cannot rearm an immediate priority chain; stale context/head/source/scope, expired/lost/follower authority or completed capture invalidates the ticket, and the ordinary cursor resumes.

For a fixed continuously eligible set of N, a regular traversal may consume at most 2N ordinary opportunities, with regular visits and inserted attempts reported separately. Keep blocked targets and original debt/pending-request/latency ages visible. No new operation, timer, root allowance, read/publication grant, authority renewal, numeric-gate waiver or §18 exception is granted. This is opportunity ordering, not a wall-clock completion guarantee.

Implementation and focused evidence remain pending. The next separately admitted B10D work must first incorporate current universal-hud into b10d-worker, adopt B12M's metered recovery handoff, preserve the retained-order cursor correction, and implement/test the bounded ticket and authority housekeeping serially with overlapping collector/link work. It must show actual next-opportunity native progress without repeating the exact recovery, one-use/refusal/expiry/ABA safety, ≤400-opportunity regular traversal for 200 targets at C=1 s and C=5 s, unchanged age/accounting and real publication settlement. This documentation does not start that work or grant a compute window.

B10D remains frozen at 4f2c4ac, NOT ACCEPTED and NOT MERGEABLE. The measured failures and retirement-recapture gap above remain open. LEG1/RCP1 need their own separately resolved and recorded package scope/ownership release; this fairness amendment neither implements nor releases them. The full route is already recorded in docs/cloud/rulings/b10d-route.md, with the owner-decision record in docs/handoff/questions/B10D-route.md.

**Not merged:** `cloud/b10b-s3-wip`, B10B segment 3 (selection, navigation, control bar). Fix round 1 has been
applied, but the re-check is still pending. B10B-S3F finishes it.

## C3 integration checkpoint (2026-11-04)

- The accepted HYG2/NODE22-PROXY + MCP-ANCESTOR + RUNZ1/RUNZ1-KILL dependent set is merged into
  `universal-hud` at `5d2c0709c8e9674254214add15f2a04cfd606443`. Remote read-back verified the exact
  tested tree `48f59142862f643a98286e3d196d23ff13059a23` and ordered parents
  `9dd4d06d2ee5ebb022719d11b74d6de0276172a4`, `09d9c3d95fe42932ecaf35dd46806a8747681aa7`.
- The [fresh merged-tree Oracle ruling](../cloud/handoff/wave1-compat-integration/oracle-c3-merged-tree-final-20261104.md)
  accepts the complete prescribed three-profile README gate under the existing once-alone known-flake rule.
  Required commands were 29/30 exit 0. Original Node 24 `npm test` remains **FAIL / exit 1**:
  the known B6 suite passed its isolated rerun 15/15, and the omitted mjs stage passed separately 47/47.
  This is not 30/30 first-pass green; the initial Node 22 preparation UNKNOWN record also remains unchanged.
- The [joint C3 acceptance](../cloud/handoff/wave1-compat-integration/oracle-c3-owner-exception-joint-acceptance-20261104.md)
  retains the owner-accepted four-archive historical custody gap and the independently owner-deferred,
  unverified real PID > 1 optional-ancestor denial. Neither missing evidence item has been recovered or passed.
  Historical benchmark comparison remains 11/12, including the real Node 24 baseline cold-p95 failure;
  no formal WSL qualification or held-executor admission follows.
- B10B-S3F remains the next unresolved wave-1 queue package, through its separately recorded NEXT continuation.
  C3 does not accept or merge B10B-S3F, release DOC2/TPD1 or later waves, or lift P065/B10D/executor holds.
  Preserve the existing brief, review, ownership and scheduling requirements.

## Dots wave 1 checkpoint (2026-11-03)

Historical checkpoint as of 2026-11-03; the C3 integration checkpoint above supersedes only the later acceptance
and merge status of its named dependent set. At this checkpoint no wave-1 implementation package below had
been accepted or merged. Preserve these branches, failures and full evidence.

- **B10B-S3F**, `dots/b10b-s3f`: R1 is fixed, R2 and the full-check gates remain open. The owner-approved follow-on `dots/b10b-s3f-perf` candidate has received a fresh Oracle verdict **fix required**, not accepted: repeated Node 24 strict performance failures and missing full checks remain. See `docs/cloud/handoff/b10b-s3f-perf-review-1.md` on that branch and `docs/cloud/B10B-S3F-PERF.md`. Preserve the failed and passing runs; no gate is waived.
- **HYG2**, `dots/hyg2`: Oracle re-check found the P2 fix correct, but the full checks remain red. See branch handoff `hyg2-review-2.md` and `hyg2-topology-diagnosis.md`.
- **RUNZ1**, `dots/runz1`: Oracle final review found no new must-fix code issue, but the full checks remain red. See branch handoff `runz1-review-1.md`.
- The executor denies synthetic Unix sockets and ptrace; its kernel lacks `CONFIG_PROC_CHILDREN`. HYG2 diagnosis reproduced the five corresponding process-topology failures on pinned baseline and current snapshots with both Node 22 and 24. This is not evidence that the affected lifecycle behavior passes.
- The owner withdrew assistant-run local testing for this project; both local test sessions stopped without completing tests. Owner-arranged local Claude evidence has now been received on `local-verification/20261103` (see the follow-on checkpoint below); independent Oracle verification remains pending. See `docs/handoff/questions/B10B-S3F-verification.md`. Assistant continues cloud work. Wave 2 requires B10B-S3F to merge; see `docs/cloud/rulings/queue-progress-20261103.md`.

## Follow-on work checkpoint (2026-11-03)

- The owner directs cloud work to continue while local evidence is reviewed; Oracle decides project forks. No merge or check gate is waived. The [local verification report](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md) has been received at `local-verification/20261103` commit `9be7246c25b5355845e639116c57150ff79d3117`. The report itself says the HYG2, RUNZ1 and B10B-S3F-PERF README check sets are not green. Independent Oracle verification remains pending; receipt is not acceptance or a green merged-tree result.
- `docs/cloud/B10B-S3F-NEXT.md` defines one released follow-on implementation, with all previous performance failures retained. It is in progress, not accepted. The prior large profile archive and three instrumentation scripts were lost when the executor was replaced; a fresh Oracle consultation is deciding a transparently labeled replacement diagnostic. Text reports, checks and hashes remain recorded; no claim of original raw-archive recovery is made.
- `docs/cloud/rulings/p065-metadata-exception.md` approves the precise fixed private-store metadata exception under the owner's delegated Oracle authority and resolves the P065 local-gate contract fork. Contracts 01–06, concept §15 and `docs/cloud/P065-BUDGET.md` were synchronized through `448c58b1f386f72d74b730018a659c6a75068cea`. The archived [P065 scheduling release](../cloud/rulings/p065-budget-release.md) releases the bounded scope and reserves `dots/p065-budget` plus `/workspace/shared/p065-budget` from accepted integration base `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`. The initial WIP implementation was published on `dots/p065-budget` at `346b3d6300a2e3f340f22e832c459371c19e2646`, exact source tree `613c6bb048dc6b8616617b2d061232807102e9cb`, followed by handoff documentation including the [implementation report](https://github.com/CartmanFatass/codex-hud/blob/dots/p065-budget/docs/cloud/handoff/p065-budget/implementation.md). The first compute lease was returned at 20:02 UTC on 2026-11-03. The [six design questions](../cloud/rulings/p065-six-design-dispositions.md) have been ruled, and their exact P065/contract-06/concept amendments were recorded through `cb90d0a7806e09685096814fe023491db6e3d02c`. The candidate remains **NOT ACCEPTED, NOT MERGEABLE and NOT PERFORMANCE-QUALIFIED**; work may resume only in a separately assigned dispatcher window under [the resource-window ruling](../cloud/rulings/wave1-resource-windows-20261103.md). Publication and documentation recording do not grant a compute window or satisfy acceptance/merge gates. The historical local-gate ruling remains intact; the startup-registry process-I/O issue remains separate and unresolved.

- **P065 interrupted continuation, 21:20 UTC checkpoint:** The separately admitted 21:07 continuation remains frozen, uncommitted WIP, **NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED**. The [prior continuation report](https://github.com/CartmanFatass/codex-hud/blob/dots/p065-budget/docs/cloud/handoff/p065-budget/continuation-1.md) preserves its source identity and earlier checks; those checks precede the final workload-fixture addition and do not validate it. Per the authoritative [interrupted-build ruling](../cloud/rulings/p065-interrupted-build.md), the fixture append and formatting executed at 21:14:05 UTC, and the build reached the TypeScript invocation, but its exit status and authoritative session/owned-descendant termination remain **UNKNOWN**. The first empty status poll was denied; exactly one authorized empty recovery poll at 21:19:48 UTC returned `write_stdin failed: Unknown process id 87162`. No further poll or replay occurred. The reported 21:15 lease return, elapsed time and namespace-limited process snapshots do not prove termination. New controlled workloads on the shared executor remain held pending authoritative lifecycle/cleanup evidence, or a separately authorized genuinely independent executor for distinct validation under the ruling's prerequisites and a new bounded dispatcher window. Do not replay the already-executed append/format/build wrapper or infer a build pass/failure; preserve all prior evidence and restrictions.

## Package queue for dots

Historical queue (2026-11-03). The active queue is R0–R7 at the top of this file. The notes below record that queue: packages in the same wave touched disjoint files and could run in parallel. A package without a brief was to get one from an Oracle first (`docs/cloud/dots.md`, step 0).

| Wave | Package | Brief | Notes |
|---|---|---|---|
| 1 | B10D route consultation | `docs/handoff/questions/B10D-route.md` | Oracle only, no implementer. Its recommendation goes into the question file for the owner. |
| 1 | P-06-5 scope consultation | `docs/handoff/questions/P-06-5.md` | Oracle only. The recommendation is for the owner. |
| 1 | B10B-S3F | `docs/cloud/B10B-S3F.md` | rendering |
| 1 | RUNZ1 | `docs/cloud/RUNZ1.md` | `src/core/run` |
| 1 | HYG2 | `docs/cloud/HYG2.md` | ledger runtime warning and tests |
| 2 | DOC2 | `docs/cloud/DOC2.md` | starts after B10B-S3F; design doc only |
| 2 | TPD1 | `docs/cloud/TPD1.md` | starts after B10B-S3F; `src/tree-page.ts` dispatch |
| 3 | B10B-s4, the Inspector (design §4.11) | an Oracle writes it | Delegation keys, reasons for a greyed Open, the Resume diagnostic, Coverage with `omittedConflictRows` |
| 3 | Data-layer additions (B9/B16) | an Oracle writes it | See below. |
| 4 | B10D-2 | an Oracle writes it, after the owner decides the route | Merge `universal-hud` into `b10d-worker` first. |

Data-layer additions for wave 3:
- the action, brief and rate fields, and the native digest;
- `node.parent` for the viewpoint root;
- a reconcile descriptor for each conflict relation;
- the picker-label inputs.

The real resume gate waits for B14.

After that historical queue: B14, the production acceptance and capability matrix, is mostly local; see below. Then B15, the phase
review (ARCH); B3b-C after B15; then phases C–F of the plan.

## Decisions recorded on 2026-11-03

- B10D fairness exception: owner-approved and Oracle-confirmed; contract 06, design §6 #13 and concept §15 record one-use next-normal-opportunity continuation and the explicit fixed-N ≤2N ordering bound. Original debt/request ages, blocked backlog, one-reader/one-publication limits and all numeric/durable-semantics gates remain unchanged. Implementation/evidence are pending and B10D remains NOT ACCEPTED / NOT MERGEABLE. See questions/B10D-route.md and ../cloud/rulings/b10d-route.md.
- P-06-5 scope: owner authorized the Oracle recommendation; the 30 ms budget includes pre-lock preparation and is not reset at lock acquisition. See `questions/P-06-5.md` and `../cloud/rulings/p-06-5.md`. The later precise metadata exception in `../cloud/rulings/p065-metadata-exception.md` resolves the local-gate contract fork without changing numeric budgets; P065 scope and branch/worktree ownership are released by `../cloud/rulings/p065-budget-release.md` on base `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`; the initial WIP source is published at `dots/p065-budget@346b3d6300a2e3f340f22e832c459371c19e2646` (tree `613c6bb048dc6b8616617b2d061232807102e9cb`), and the first lease was returned at 20:02 UTC. The six questions are ruled in `../cloud/rulings/p065-six-design-dispositions.md` and their exact documentary amendments are recorded through `cb90d0a7806e09685096814fe023491db6e3d02c`. The candidate is NOT ACCEPTED and not performance-qualified; resumption requires a separately assigned dispatcher window.

## Open owner decisions

- O1: the implementer-comparison B14 idle-cost runner. None of the three arms met the merge bar.
- Whether to rename the real project names `shenlun` / `atlas-launch-sources` used in some tests.
- Whether to rewrite git history to remove old private paths. Those commits are already public on `main`.
- Statusline wiring: nothing calls the statusline renderer yet. Candidates are a `hud statusline` entry, or plan D3.

## Local only (needs the owner's machine)

- Herdr integration tests (`npm run test:herdr`) and anything that creates or reads Herdr panes and tabs.
- Real-harness tests that need logged-in Codex or Claude CLIs: `B13_REAL=1`, the B45 real closures, and B14's
  real capability evidence (visible cc→Codex, resume, wake delivery).
- Jev / shared browser and the Hermes human-interaction tests.
- The final P-06-7 qualification on the supported WSL platform. Remote numbers are evidence for design, labelled with
  their host. They are not the formal qualification.
- Switching the live statusline (`claude-hud` replacement), and anything touching `~/.hud`, `~/.claude`, `~/.codex*` or
  `~/.pi`.

## Rules (unchanged)

These are in `docs/cloud/README.md` "Rules every agent keeps":

- The repo is public: synthetic data only.
- Tests use a temporary `HOME` and `HUD_HOME`.
- Only hud-mcp, hud-run and the reconciler write the ledger.
- Contracts and the design are the spec.
- Performance is acceptance.
- One review per change; at most two fix rounds, then ask the owner.
- Never stage `node_modules/.package-lock.json`.
