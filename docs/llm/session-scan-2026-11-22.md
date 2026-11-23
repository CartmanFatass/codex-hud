# Cross-Project Session-Log Scan: What Nine Tickets Came Out Of (2026-11-22)

Dated study of the `2026-11-22` session-log scan: six scoped read-only scan slices (plus the shared instruction
file) over four projects and four harness record kinds, the findings they produced, and the nine tickets
(`.scratch/scan-fixes/issues/01..09`) that landed out of it. Companion to `docs/llm/orch-load-2026-11-22.md`, `docs/llm/imp-load-2026-11-22.md`,
`docs/llm/workers-load-2026-11-22.md` and `docs/llm/post-change-load-2026-11-22.md`, which measured load; this scan
looked for defects. Aggregates and categories only, per the privacy rule in every slice brief.

**Citation keys.** `SCAN/<slice>` = `tmp/tasks/SESSION-SCAN/<slice>.md` (runner copies; not committed). `NN` =
`.scratch/scan-fixes/issues/NN-*.md`. `TRACE/brief.md` = `tmp/tasks/TRACE-REVIEW/brief.md`. Every count below is
quoted from one of those files; the tickets are the only durable record of the scan that survived in the repo.

---

## 1. Scope & Cutoff

Each slice had the same shared body (`SCAN/common.md`: read-only, stream large transcripts, never copy or quote
more than three lines, never quote keys) and its own `## Your scope` paragraph. `SCAN/common.md` carries no scope
line of its own.

| Slice | Project(s) | Harness & record kinds | Window stated in the brief | Notes from the brief |
| --- | --- | --- | --- | --- |
| `myhud-main` | MyHUD | Claude Code main/orchestrator sessions (`~/.claude/projects/…MyHUD/*.jsonl`) | since `2026-11-20` | skip the newest file: the live session |
| `myhud-pi` | MyHUD + `MyHUD-wt-*` | pi worker sessions (`~/.pi/agent/sessions/…`) | since `2026-11-21` | map sessions to jobs by `job.json` cwd; focus on worker-side `hud_progress`, `hud_ask`, `sonic`, reports |
| `myhud-cli` | MyHUD | Claude Code CLI workers in `-MyHUD-wt-*`; `agy` `transcript_full.jsonl` (calls in `PLANNER_RESPONSE`, results in `GENERIC`) | since `2026-11-21` | brief receipt, HUD tool reach, reporting, wasted steps |
| `hud-jobs` | every project | `~/.hud/jobs/*/`, `watch.log`, `profile.log`, `mcp-tasks/`, `flows/`, in-job `*.gate-*.log` | since `2026-11-19` | no transcripts; tallies, failure reasons, retry chains, land outcomes, `sonic` rates, time-to-report |
| `bilingual` | bilingual (+ `-wt`) | Claude Code, pi, HUD job records | last `7` days, newest first | project sessions and worktrees |
| `rush-jevdev` | rush, JevDev (+ `-wt`) | Claude Code, pi, Codex rollouts under two Codex homes | **not stated** | only sessions that used HUD matter |
| `common` | — | — | — | shared instructions only, no scope of its own |

**What was not scanned.** No slice reports a wall-clock cutoff time; the windows above are the briefs' own words and
nothing in the tickets records when the last slice stopped reading. The live MyHUD main session was excluded by
design (`SCAN/myhud-main.md`). `SCAN/hud-jobs.md` deliberately opens no transcripts, so it sees outcomes but not
what a worker or the caller did to reach them. Transcript content beyond short excerpts was not retained, so the
scan leaves no per-session rows to re-check — only ticket-level counts.

**Not covered by any ticket.** The bilingual, rush, JevDev and Codex slices produced no ticket, so any finding they
had either did not survive or was judged lower impact; the scan record does not say which, and per-slice report
totals are not recorded anywhere in the repo.

**Related earlier studies (bilingual only).** `tmp/tasks/MCP-ORCH/brief.md` is the `2026-11-21` oracle proposal to
move orchestration mechanics into the HUD MCP, built on one day of bilingual sessions alone;
`tmp/tasks/WORKER-MCP/brief.md` is its companion spec slice moving the job protocol from worker prompts into the
HUD. Both are single-project predecessors of this cross-project scan.

---

## 2. Questions Asked

Every slice asked the same questions (`SCAN/common.md`), against the HUD surface — MCP tools `hud_create`,
`hud_read`, `hud_send`, `hud_respond`, `hud_land`, `hud_tickets`, `hud_roster`, `hud_peek`, `hud_close`, `hud_ask`,
`hud_lease`; roles `imp`, `frontend-imp`, `sonic`, `general`, `oracle`, `reviewer`; job events, task
notifications, panel, statuslines, pi footer, Claude mod:

1. HUD tool errors and their messages; repeated calls the model had to retry or work around.
2. Jobs that failed, stalled, were retried or stopped; launch problems; workers that could not reach a HUD tool.
3. Duplicated, late, missing or pointless events and notifications; polling and wait loops.
4. Workers misreading briefs, leaving scope, asking needless questions, reporting wrong state.
5. Land/gate failures and whether they were flakes or real.
6. Wasted context: huge tool results, repeated reads, repeated injected text.
7. Anything the owner complained about in their own messages.
8. Anything else that looked wrong.

The required report shape was fixed (`SCAN/common.md`): scope actually covered with counts, findings ranked by
impact with evidence and a one-line fix, things that look fine, what could not be checked — in English. Nine of
the resulting findings became tickets in `f194b2b7`; one scan job is a shared contributor to several of them
(`j52c7712b41ba4a70` in `01`, `03`, `04`; `j2cfddd907cde7d8c` in `02`, `04`; `j5b0fbe7ad17f060f` in `03`, `04`;
`j632148defd832215` in `04`, `07`), plus a carbon review (`j91fa6e1950156406`, cited in `03`) and a land flow
(`f9fb00124014d9e2`, cited in `08`).

---

## 3. Findings (ranked by impact)

Ranking is by how many records a defect touched and how much of a session it could derail; all nine tickets are
`**Status:** done` with a `gate 5/5 passed` comment.

| # | Finding | Count / evidence | Project(s) | Ticket | Fix commit | Status |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Launch diagnostics named the caller's pane, did not retry a busy pane, and put a raw CLI JSON blob in `exit_reason` | `595` of `631` audited job records carry the caller's pane id, headless ones included; `4` launches failed `agent_pane_busy` when several started in the same second; `6` jobs hold a raw JSON blob in `exit_reason` (`05`) | MyHUD and others | `05` | `51416d46` | done |
| 2 | A `sonic` runner death left nothing diagnosable behind | `6` children failed with `sonic runner exited without an exit receipt`; `2` died in the same millisecond when the parent session restarted; all `27` headless `stderr.log` files were empty (`03`) | MyHUD pi workers | `03` | `76116df8` | done |
| 3 | Land failure evidence was blank panel frames instead of the assertion | `8 KiB` gate excerpt and `40`-line repair tail, one excerpt `83` of ~`100` lines blank, notices saying only `failed: repair 1`; seen by `4` scan jobs (`04`) | MyHUD | `04` | `72761197` | done |
| 4 | Worktrees kept after landing did not say which paths kept them | bilingual `20/20` imp worktrees kept, MyHUD `44` kept, one reap sweep `removed=0 kept=36` (`08`) | bilingual, MyHUD | `08` | `046f1d0d`, `8f10c89c`, `a92dcf3f`, `d61e1531` | done |
| 5 | `hud_sonic` start refused a field its own description offered | `8` pi worker calls `{task, timeout_s}` failed `start or wait for sonic, not both` (`01`) | MyHUD pi workers | `01` | `9a7782b1` | done |
| 6 | An oversized `hud_read mode:"full"` was spilled out of the client into a file | `57 KB` report exceeded Claude Code's tool-result limit; ~`40 KB` cuts needed a second read (`07`) | MyHUD main session | `07` | `f06d5d9f` | done |
| 7 | Six small MCP contract mismatches (schema vs description, ticket ticklist written before validation, roster listing presets `hud_create` refuses, redundant ready notices, `watch.log` repetition) | summary `maxLength 320` vs a `160`-code-point description; `37%` of `hud-sonic-ready` notices redundant with a collection the same session already made (`06`) | MyHUD | `06` | `c84302b7` | done |
| 8 | A finished report was refused in the gap before its next turn prompt | `2` of `60` `agy` reports rejected for the wrong turn token; the worker re-sent the whole report (`02`) | MyHUD `agy` workers | `02` | `ca958f55` | done |
| 9 | Rows for jobs built from one brief were indistinguishable on Home | `3` general jobs from `1` brief, different models, all showed the same truncated title (`09`) | MyHUD panel | `09` | `11adc84d` | done |

Commit subjects, for the record: `9a7782b1` hud_sonic accepts `timeout_s` on start; `ca958f55` accepts a prior-turn
report while the CLI follow-up is in flight; `76116df8` keeps registered sonic runners out of parent reaps and
records unexpected exits; `72761197` keeps land failure assertions ahead of panel output; `51416d46` distinguishes
caller panes and retains actionable launch failures; `c84302b7` fixes six small MCP contracts; `f06d5d9f` pages
large `hud_read` full reports; `046f1d0d` explains kept worktrees and offers disposable ignore globs; `8f10c89c`
treats `node_modules` as disposable in managed worktrees (untagged, same theme as `08`); `a92dcf3f` and `d61e1531`
carry the `08` dotfile-glob bug and its acceptance; `11adc84d` tags same-title Home rows with the model's short
name; `f194b2b7` creates the nine tickets. Only `08` and `09` are recoverable by `git log -i --grep "scan-fixes/0N"`
(`a92dcf3f`, `d61e1531`, `11adc84d`); the other seven fix commits do not name their ticket in the subject, so their
mapping above is recoverable from `git log -- <ticket path>` (each fix commit also updates its ticket file), not
from the subject.

**What the fix commits claim, per ticket checkboxes.** `01`: start ignores `timeout_s`, `{task, wait}` still names
`wait`. `02`: old-token report accepted for the old turn, older tokens still fail, no double settlement. `03`: exit
code or signal plus stderr tail recorded, parent-restart cause named, partial report written from the session tail.
`04`: no whitespace-only runs in excerpt or repair tail, failing step and up to `3` failing tests named. `05`:
headless records carry no pane (or one marked as the caller's), a busy pane retries once, `exit_reason` is a short
code. `06`: each of (a)–(f) fixed and tool schema bytes grow by no more than `200 B`. `07`: bounded first page plus
size and next-page hint, paging to EOF reproduces the report exactly. `08`: up to `5` blocking paths listed, `hud
setup` proposes globs from kept worktrees and writes them only when accepted, a `dir/**` glob covers dotfiles.
`09`: only rows that share a title get a tag, EN/ZH frames updated at `42` and `80` columns.

---

## 4. What the Scan Found Fine, and What It Could Not Check

**Fine — not recorded.** Each slice brief required a "things that look fine" section and every slice was asked for
it, but the landed tickets keep only the findings that became work. Nothing in `.scratch/scan-fixes/` states which
behaviours the slices cleared, so this study can only report that the section was requested
(`SCAN/common.md`) and not what it said. The same holds for the "what you could not check" section each slice was
asked to write.

**Not recorded at all, though in scope of the briefs:**

- Per-slice coverage counts (sessions, files, bytes read) for bilingual, rush, JevDev, MyHUD main, MyHUD pi and
  MyHUD CLI. The tickets name scan job ids but no totals.
- Whether the rush/JevDev slice found anything at all, including in Codex rollouts under the two Codex homes
  (`SCAN/rush-jevdev.md`). No ticket carries a rush or JevDev project.
- Whether the bilingual slice informed `08` from its own counts or from a separate sample; `08` cites the
  bilingual worktree tally (`20/20`) without naming the slice or job.
- The cutoff instant and any partial-window caveat (see §1).
- How many of the scan's findings were rejected as unfixable, harness-side or model-side; only the nine landed
  tickets survived.
- Owner-message complaints (question 7 of the shared brief): no ticket records one, so either none were found or
  none were judged actionable — the record does not distinguish.

**Checked and settled by the tickets themselves:** every ticket lists its checkboxes as ticked and repeats the gate
result (`gate 5/5 passed`), so the fixes were verified at land time; how they performed in later live traffic is
not part of this scan and is covered by `docs/llm/post-change-load-2026-11-22.md` and later studies.

---

## 5. Measures This Scan Relied On

Each measure is tagged **[job]** when it needs HUD job facts (`job.json`, `STATUS.json`, `report.md`, `watch.log`,
`flows/`, gate logs) and **[tok]** when token or session data alone suffices.

| Measure | Tag | What it counted | Ticket it fed |
| --- | --- | --- | --- |
| HUD tool error message and repeated call arguments | [tok] | identical failing `hud_sonic` calls per worker session | `01` |
| Turn-token rejections across a turn handover | [tok] | reports refused, and re-sends by the same worker | `02` |
| Sonic child failure text, `stderr.log` size, session tail (`stopReason`) | [job] | `6` receipt-missing deaths, `27` empty stderr files | `03` |
| Gate and repair-log excerpt composition | [job] | blank or frame-only line share of an `8 KiB`/`40`-line excerpt | `04` |
| `exit_reason` values and recorded pane per job | [job] | `631` job records, `595` with the caller's pane, `6` with raw JSON | `05` |
| Launch failures and whether a retry happened | [job] | `4` `agent_pane_busy` failures in one second | `05` |
| Tool schema bytes | [job] | schema vs description length (`320` vs `160` code points); `≤200 B` growth budget | `06` |
| Notification vs collection pairing | [tok] | `37%` of ready notices redundant with an existing collection | `06` |
| `watch.log` line repetition per job | [job] | unresolved worker-tree snapshot logged once per job, not every minute | `06` |
| Report size vs client tool-result limit | [job] + [tok] | report bytes from `report.md`, spill and second read from the caller session | `07` |
| Worktree keep/remove counts and the paths blocking removal | [job] | `20/20`, `44` kept, `removed=0 kept=36`, ignored leftovers | `08` |
| Visible row titles on Home | neither | rendered frames, not job facts and not tokens; no such measure existed, which is why `09` was found by looking at the screen | `09` |

Reading the table the other way: `8` of the `12` rows are pure job-fact measures and could be recomputed without
transcripts at all, which is why `SCAN/hud-jobs.md` could run with no transcript access; only `3` rows (`01`, `02`,
and the `06` notice pairing) need transcript or session data, `1` row needs both, and `09`'s row was found by
looking at the screen rather than by any recorded measure.

---

## 6. How to Repeat It

`.claude/skills/trace-review/` (commit `783311a2`, "Add project trace-review skill and transcript extractor") is the
tool meant for repeating this scan, and it exists because the scan itself was ad hoc: a set of bespoke read-only
scripts under git-ignored `tmp/tasks/SESSION-SCAN/`, each re-learning four harness layouts (`TRACE/brief.md`). The
skill packages
that knowledge as `SKILL.md` (pick one question and a matched sample, run the extractor, dispatch one worker with
`context_files` = `worker-guide.md` plus the extractor's `metrics.json`, read the report, turn findings into
tickets that name the layer — harness, HUD, model, mod — and the number they should move), `worker-guide.md` (record
locations and layouts per harness, metric definitions, attribution rules, pitfalls, privacy rules) and a
dependency-free `extract.mjs` for `claude|codex|pi|agy` with `--job <id>` resolution, which writes sanitized
`metrics.json` (turns, tool calls with result bytes, exact repeats, file-read ranges and overlap, injected blocks,
compactions, usage) plus a short text summary under a git-ignored run directory. A repeat run should reuse this
study's §3 table as its baseline and record its own sample definition and counts, since that is exactly the
bookkeeping whose absence is listed in §4.

---

**Caveats.** (1) All counts are as stated by the tickets and briefs; none were recomputed for this study, and the
scan's raw outputs are not in the repo. (2) Nine tickets out of an unknown number of findings is a survivor's
sample, biased toward defects that were cheap to fix and had a countable symptom. (3) The four scan job ids quoted
above are the only scan jobs the tickets name; other slices' jobs are not recorded, so a repeat cannot tell which
sessions this scan actually read. (4) Windows differ per slice (last `7` days, since `2026-11-19`, `2026-11-20`,
`2026-11-21`, and `rush-jevdev` unstated), so cross-slice rates are not comparable. (5) This document records
defects and their fixes, not their effect; for effect see the load studies named at the top.
