Verdict: accept

Spec

None. Each first-round blocking, major and minor finding is fixed on the path a user hits, and the docs that were rewritten say what ships.

Roster. `hud_roster` calls `found.assignment(role)` with one argument, so the one-hour mark is judged at `Date.now()` rather than at the array index. An expired mark drops, and `runs_on` matches `hud_create`.

CLI reference, both languages. A job ends only when the recorded pid is gone or replaced, the tab is closed, or dispatch is rejected before input. A dead supervisor with a live worker stays `waiting_orchestrator` ("supervisor exited; worker still running"); `hud_send` starts a new supervisor. herdr status is advisory. The blocked-CLI notice sentence is gone; the session hears it through `changes` or `hud watch`. Both references describe `changes`, `hud watch` (caller pane or `--all`, nothing read at rest beyond a 30 s rescan, no step-by-step flood, nothing typed into the main pane), and the quiet-job rule (one Decision API choice, 0.8, quota line required to fail).

Outbound row. Both tables list the quiet-job input as the last 60 pane lines (≤12,000 characters), job state, role, agent, minutes quiet, background child, and whether the report prompt was sent. That matches `decideQuietJob`.

Release notes. `oracle` is the local advisor (`claude` `fable`, then pi `architect`). `pro` is the browser role (ChatGPT Pro, then Gemini, then AI Studio Argon). The notes also cover the Control plane, fact-only CLI endings, the quiet-job choice, `changes`, `hud watch`, and the timeline hub. Shipped role files match.

`imp` / `reviewer`. Reference, Chinese reference, and `hud-delegate` say they ship as pi only, and that a fallback is the owner's Control plane or `$HUD_HOME/roles/<role>.json`. `imp.json` and `reviewer.json` have one pi place each.

Failed report prompt. The shell still publishes `turn.json` before the prompt, so a fast report has a baseline. If `herdr agent prompt` fails, the decision becomes `needs-human` / `prompt-failed`, the in-memory turn and `prev.seq` move to that new seq, and the judge leaves the job `waiting_orchestrator`. The following turn-file wake does not reopen it as `working`.

Report prompt once per job. `turn.json` carries `report_prompt_sent`. `writeTurn` keeps the flag, and a new supervisor reads it. After `hud_send` respawns a dead supervisor, the fixed prompt is not sent again.

Settled cards. `workCardDetail` shows `quiet_decision` only while `settledAt` is null, or when the card failed and the action is `fail`. A later `still-working` or `prompt-report` line does not sit on a settled result. The collector maps `waiting_orchestrator` to an unsettled card, so that handoff still shows.

Chinese Control plane note. The `t()` key matches the English string in `work-view.ts` (`m picks a model`). The Chinese frame uses that translation.

`hud watch`. One recursive `fs.watch` of `$HUD_HOME/jobs`, 50 ms debounce, 30 s rescan when the watch is missing or as a safety read. At rest it does not list `jobs/` or stat `STATUS.json` between rescans. With neither `HERDR_PANE_ID` nor `--all` it writes one stderr line and exits 1. `.tmp`, `supervisor.pid`, and `sessions/` do not wake it; STATUS, report, and `qa/` do.

Open question. For `waiting_orchestrator` with no stored reason, `jobRow` adds "quiet without a report…" only when there is no open question. A question still produces a `QUESTION` changes line. The panel's second `jobRow` passes the open-question count, so the card keeps the question instead of that sentence.

No scope beyond the first-round findings and the three optional items this pass was told to include (event-driven `hud watch`, the no-pane line, the open-question reason).

Simplicity and quality

None. Nothing the fixes added should be deleted. Publishing the turn before the prompt, then aligning `prev.seq` only on failure, is what keeps the report baseline without clearing the handoff. The rescan is the safety read the design asked for, not a second poll loop.

Optional (does not change the verdict)

- `docs/ARCHITECTURE.md` still says a dead supervisor fails the job (the watcher paragraph, about line 341). The reference, release notes, and skill now say `waiting_orchestrator`. That file was not part of either fix commit.
- The outbound row says "once per quiet turn, ≤3 per job". A `still-working` choice asks again after another idle grace on the same turn. The three-question counter is still per supervisor process; only the report-prompt flag is stored on `turn.json`. A `hud_send` respawn can call the Decision API again (the new test expects that) and will not send the report prompt again.

Files read and checks

Read: reviewer instructions; both briefs (`REVIEW-014`, `REREVIEW-014`); both first-round reviews; `docs/spec.md` §2 and §5; `docs/delegation.md` step 5; `docs/ARCHITECTURE.md` §7–§8; `docs/reference.md` and `docs/reference.zh.md` (CLI, roles, outbound); `docs/releases/0.1.4.md`; `integrations/skills/hud-delegate/SKILL.md`; `.scratch/cli-workers/issues/10-quiet-job-decision.md`; `git show a2b2b033` and `git show 7bd5e175`. Code: `packages/hud-mcp/src/thin-main.ts` (roster), `packages/hud-mcp/bin/hud-cli.mjs` (prompt failure and flag), `packages/hud-mcp/src/cli-judge.ts`, `packages/hud-mcp/src/quiet-decision.ts`, `src/roles/roster.ts` `assignment`, `src/cli/watch.ts`, `src/collectors/thin-jobs.ts` (`jobRow`, `jobChanges`, card `settledAt`), `src/render/work-card.ts`, `src/render/work-view.ts`, `src/render/workboard-i18n.ts`, `src/render/home-view.ts` (needs-you strip only), `src/render/work-inspector.ts`, role JSON for `imp`, `reviewer`, `oracle`, `pro`. HEAD `7bd5e17566c1eb9a5766f173358f862541fe3d40`. The brief states the orchestrator's full suite was 562/562; I did not re-run it.

Checks, worktree, `/home/fires/projects/MyHUD/tmp/env.sh` (temp homes):

| Command | Result |
|---|---|
| `npm run build && npm run build:hud-mcp && npm run build:test` | exit 0 |
| `node --test tests/unit/cli-judge.test.mjs tests/unit/role-places.test.mjs tests/unit/hud-watch.test.mjs tests/unit/thin-job-scan.test.mjs tests/unit/card-details.test.mjs tests/unit/kept-pages.test.mjs` | 87 pass, 0 fail |
| `node --test --test-name-pattern 'failed prompt-report\|reportPromptSent persists' tests/unit/thin-mcp.test.mjs` | 2 pass, 0 fail (`failed prompt-report keeps waiting_orchestrator across turn wake`; `reportPromptSent persists across supervisor restart via hud_send`) |

`git status --short` after the build was empty. Real `~/.hud`, herdr, and logged-in CLIs were not touched.
