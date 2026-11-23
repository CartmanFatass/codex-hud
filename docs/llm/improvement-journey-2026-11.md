# How HUD and Its Worker Workflow Improved (2026-11-12 → 2026-11-23)

Distilled history of eleven days of HUD tickets: what changed in how the owner, the main session and the workers
run, which changes reversed earlier ones, and what the tickets do not record. Companion to the dated load and
scan studies listed in §1.

**Citation keys.** `feature/NN` = `.scratch/<feature>/issues/NN-*.md` (a feature with one issue is cited as
`feature/01`). `STUDY/<name>` = `docs/llm/<name>-2026-11-22.md`. `D-YYYY-MM-DD-NN` = an entry in
`docs/decisions-log.md`. Feature dates come from `git log -- .scratch/<feature>`; counts from each issue's
**Status** field.

---

## 1. Scope

| Items | Count | Source |
| --- | ---: | --- |
| Feature directories under `.scratch/` in the window | 78 | `ls .scratch/` |
| Issue files in those directories | 338 | `.scratch/*/issues/*.md` |
| Issue range | `2026-11-12` – `2026-11-23` | `git log --format=%cs -- .scratch/` |

The 78 features were split into five themed extractions, which this document distils:

| Theme | Features | Issues | Example features |
| --- | ---: | ---: | --- |
| Orchestration, MCP, events | 17 | 64 | `mcp-orch`, `claude-mod`, `flows`, `event-waits` |
| Worker harnesses, supervision, setup | 7 | 38 | `cli-workers`, `supervisor`, `worker-close` |
| Roles, models, placement | 12 | 39 | `auto-route`, `sonic-lite`, `imp-lean` |
| Reliability, tests, review, performance | 16 | 95 | `dogfood-fixes`, `test-flakes`, `review-next` |
| Panel, bar, statusline, owner UX | 26 | 102 | `trim`, `home-compact`, `panel-polish` |

Every entry in the extractions is marked KEY under a loose rule, so selection is the editorial work here: §3 keeps
at most fifteen turning points, and everything else appears only in the §2 timeline.

**Count disagreement.** The brief states 79 features; the five extractions sum to 78 and the directory listing is
78. I followed the filesystem and the extractions. The panel extraction gives no header count; its 26 features and
102 issues were counted from the directories.

Base studies linked where they explain a turning point: `STUDY/orch-load`, `STUDY/imp-load`, `STUDY/workers-load`,
`STUDY/imp-model-cost`, `STUDY/post-change-load`, `STUDY/session-scan`.

**Caveats up front.** Numbers are quoted from the ticket or study named beside them and were not recomputed;
feature-level status is not acceptance, since several tickets carry `Status: done` with unticked boxes (§8). Where
two extractions disagreed I opened the issue or the decisions log and say which I followed.

---

## 2. Timeline

| Dates | Theme | Main features | What changed for the owner or main session |
| --- | --- | --- | --- |
| `11-12` | Panel surface, release gate | `decision-labels`, `m4-close`, `native-polish` | Two-reviewer whole-project review before release; forward incremental transcript reads so long subagent trees stop losing their tail (`native-polish/01`). |
| `11-13` – `11-14` | Harnesses, setup, places | `cli-workers`, `hud-setup`, `role-bind`, `supervisor`, `project-hub` | Roles could run on any interactive CLI herdr supports; role split into work plus a place list; one `judge()` replaced per-path supervisor inference; owner installed project `.hud/` roles and skills. |
| `11-17` – `11-18` | Owner tries landed work; worker lifecycle | `bar-notice`, `panel-next`, `panel-redesign`, `panel-tidy`, `panel-try`, `statusline-tps`, `panel-v2`, `worker-close`, `worker-unify`, `supervisor-fix`, `mcp-next`, `mcp-read-compact` | Try marks moved from chat into `tries.jsonl` (`panel-try/01`); worker tabs carry `HUD_JOB_DIR`; MCP absorbed dispatch mechanics, leases and compact reads. |
| `11-19` – `11-21` | Panel/Control UX and the MCP surface | `panel-ux`, `control-tab`, `project-layouts`, `ux-pass`, `model-picker`, `exp`, `hud-mcp-lean`, `pi-async-hud`, `mcp-orch`, `mcp-split`, `async-watch`, `event-waits`, `build-dedup`, `prune-obs`, `primitives`, `job-index`, `test-split`, `monitor-state`, `i18n-check` | Waiting and locking became one primitive each; project scope, standing brief and hint convention; the main session stopped carrying per-harness job text. |
| `11-22`, to ~13:00 | Measuring load, routing chores | load studies, `orch-lean`, `imp-lean`, `agy-lean`, `sonic-lite`, `concurrency-cap`, `auto-route`, `role-overrides`, `place-health`, `settings-advanced` | The main session handed lookups and evidence reading to roles; sonic became a headless query; a soft cap queues instead of failing the caller. |
| `11-22`, ~13:00–18:00 | Land flows, dogfood, review | `flows`, `land-log`, `dogfood-fixes`, `report-summary`, `close-on-delivery`, `resume-guard`, `perf-ts`, `perf-hygiene`, `native-statusline`, `job-archive`, `worktree-overlap`, `hud-doctor`, `spec-docs`, `review-cross`, `scan-fixes`, `open-review-fixes`, `panel-polish` | `hud_land` became the normal landing path with no sonic step; reports gained a one-line summary; a worker closes at its declaration; scans of finished sessions turned into tickets. |
| `11-22` evening – `11-23` | Trims, defaults, seats, mod | `trim`, `home-compact`, `home-progress`, `claude-mod`, `claude-tail-first`, `review-next`, `test-flakes`, `optional-roles`, `flex-seat`, `agy-adapter`, `statusline-workers` | Inbox is the only Project layout; one accept-all record plus flagged items; authorized ticket batches; placement modes and an optional Claude mod band. |

---

## 3. Turning Points (ranked by effect on how the workflow runs)

**1. The main session's cost was its own evidence reading, so chores moved into roles.**
Evidence: `S1` had 72.6% chore turns over 781 turns at a ~`$48.60`/day baseline (`STUDY/orch-load` §1); after, `P4`
ran 8.7 turns and `$0.48` per slice against 21.2 and `$1.38` (`STUDY/post-change-load` §1.1, §1.5).
Decision and lesson: `D-2026-11-22-15` (A/B/C) with `D-2026-11-22-17`/`-18` accepted the studies' recommendations;
the recorded lesson is that the load was a routing problem, not only a mechanics one (`mcp-orch/proposal.md`). Links: `STUDY/orch-load`, `.scratch/orch-lean/issues/01–05`, `D-2026-11-22-15`, `STUDY/post-change-load`.

**2. Integration left the main session and became a HUD flow.**
Evidence: before `hud_land`, 39 of 39 slices needed manual integration; in the final measured phase 9 of 10 lands
were zero-touch, 6 of 6 after `DF-13` (`STUDY/post-change-load` §1.5); `flows/01` records `test:mjs` 1034/1034 on a
second run after two timing asserts at load 18.
Decision and lesson: `hud_land({job})` gates, cherry-picks, fast-forwards, builds, pushes and cleans up, with repairs
back to the source job at most twice (`flows/01–02`, `D-2026-11-22-19`); one land writes about itself, so
self-reference and stale rows are its recurring bugs (`land-log/02`, `/03`). Links: `.scratch/flows/issues/01–05`, `.scratch/land-log/issues/01–03`, `D-2026-11-22-19`, `D-2026-11-22-26`.

**3. A turn ends at the declaration, not at the collection.**
Evidence: the ticket states CLI idle grace 600 s and pi the cache lifetime, and that main now lands without a
`hud_read`; `resume_s` defaults to 1620 s (27 min) under the 30-min cache lifetime (`close-on-delivery/01`).
Decision and lesson: a worker closes when `hud_report` settles the turn, with one exit matrix and a test per row, and
a `hud_send` inside the window resumes the same native session (`close-on-delivery/01`); `auto-route/01` reuses that
helper rather than forking it. Links: `.scratch/close-on-delivery/issues/01`, `.scratch/auto-route/issues/01`, `.scratch/report-summary/issues/01–03`.

**4. Sonic stopped being a herdr worker and became a headless one-shot query.**
Evidence: a census of 157 sonic jobs found 97.5% with no interaction, 0 `hud_ask`, 1 lease use, 1 repair and 7 s
median startup; 81% picked `high`, 38.6 `bash` calls against 0 `grep`; of 25 timed jobs p50 259 s, p90 497 s and 2
over 600 s (677 s, 1,490 s, both done) — `.scratch/sonic-lite/issues/01–03`.
Decision and lesson: headless pi, `none` thinking, checkpoints at 600 s instead of a 10-minute kill, and `retry_of`
resuming the pi session; a fixed kill would have destroyed work that finished (`sonic-lite/01–03`), and
`D-2026-11-22-21` records sonic as a headless role outside the herdr worker rules. Links: `.scratch/sonic-lite/issues/01–03`, `D-2026-11-22-21`, `STUDY/workers-load` §3.1.

**5. Headless became the default shape for continuable roles, and routing picked the tier.**
Evidence: 95 of 185 worker jobs (51%) ran brief-to-report with no question, send or repair while each held a herdr
tab (`auto-route/01`); `auto-route/03` comments record Sol 57/56/55/53 turns at max/xhigh/high/medium against Hydrogen
54/51/41, 10.2 vs 16.9 min/task, about 5× output tokens, and a Hydrogen pilot that landed `perf-ts/08` in 13 min.
Decision and lesson: tiers moved from code into the role file, and an explicit `mode` wins while routing picks only
the tier (`auto-route/03`); 4 of the 8 tickets are live-found residual bugs clustered in process-tree reaping,
session identity and follow-up delivery. Links: `.scratch/auto-route/issues/01–08`, `.scratch/concurrency-cap/issues/01`.

**6. Model and place choices left the orchestrator and went into role files.**
Evidence: `STUDY/imp-model-cost` measured astra at `$3.40` mean / `$2.93` median per job against `sol-fast` at
`$0.91` / `$0.73` (3.7× mean, 4.0× median, with harder slices in the astra cohort); `D-2026-11-22-30` records that on
landed astra tasks sol found the same root causes at about 40% of the cost.
Decision and lesson: role files are the single source of place, only `general` accepts `preset`/`on`/`model`/
`thinking` (`role-overrides/01`), and placement is `fixed`/`even`/`auto` with on→auto, off→fixed migrated on read
(`flex-seat/02`); internal paths must bypass caller fields.
Disagreement: the roles extraction calls `agy` neon the `imp` default, which `STUDY/post-change-load` §1.4 records at
`15:27Z`; `D-2026-11-22-21`, recorded after that study, ends the neon trial and returns `imp` to pi `sol-fast` high
with astra for hard slices. I followed the decisions log and the later `flex-seat` tickets.
Links: `.scratch/role-overrides/issues/01`, `.scratch/flex-seat/issues/01–02`, `D-2026-11-22-20`, `D-2026-11-22-21`,
`D-2026-11-22-29`, `D-2026-11-22-30`, `STUDY/imp-model-cost`.

**7. One judge replaced per-path supervisor inference.**
Evidence: an oracle audit at `f171c595` found one failed `herdr agent get` read as "agent exited", a stalled dispatch
mark, a partial report treated as end-of-job, six writers of terminal states and `notify` covering two events;
`supervisor/08` records ~500 lines of inference in `hud-cli.mjs`, and an at-rest measurement of "0 CPU ticks,
24 reads / 9 writes, no children" over 60 s against 5 CPU ticks for a ~4 min run.
Decision and lesson: explicit `turn.json`, one pure `judge(prev, facts, now)`, facts-only endings and one
`jobRow`/`jobChanges` reader for panel, MCP and `hud watch` (`supervisor/08`); fakes can encode the wrong protocol —
the first live agy run still stayed `working` 10 min because herdr pushes dotted `pane.agent_status_changed` while
the fake used underscores (`supervisor/08` comment).
Links: `.scratch/supervisor/issues/04–09`, `.scratch/worker-close/issues/01–03`,
`.scratch/supervisor-fix/issues/01`.

**8. Orchestration mechanics were accepted whole from one oracle report.**
Evidence: one project day of ~500 turns had 22% HUD calls, 71% its own `bash`/read/edit and only ~3% dispatch
mechanics; report-written to report-read latency had a median of 20 s, so chaining would have saved about 11 of 500
turns; scanning every job directory cost ~3 ms (`mcp-orch/proposal.md`).
Decision and lesson: `D-2026-11-21-11` accepted every recommendation while plan execution, an `after` condition and
a resident server were deferred with their reasons; the recorded lesson is that the main session's cost was a
routing matter and restart recovery is not a mechanics fix (`mcp-orch/05` comment).
Links: `.scratch/mcp-orch/proposal.md`, `.scratch/mcp-orch/issues/01–08`, `D-2026-11-21-11`, `D-2026-11-21-12`,
`.scratch/mcp-split/issues/01–04`, `.scratch/resume-guard/issues/01`.

**9. Waiting and locking became one primitive each.**
Evidence: a slow reap froze settlement and checks for up to 135 s; during a 5 s reap another settle took 96 ms and
checks 228 ms; create 4362→466 ms, send 2060→64 ms, ping during `hud_ask` 1996→2 ms (`async-watch/01–03`);
release→grant 17.3 ms and SIGKILL→grant 753.7 ms against a previous 250–2000 ms (`event-waits/01–03`).
Decision and lesson: one `fs-wait` used by `hud_read`/`hud_wait`/`hud_sonic`/`hud_ask` and one `abstract-lock`, with
`event-waits/03` superseding `async-watch`'s deferred lease slice; killing processes needed its own review slice —
`async-watch/04` found 5 blocking issues and added 7 red/green tests. Links: `.scratch/async-watch/issues/01–04`, `.scratch/event-waits/issues/01–04`.

**10. The standing brief and the worker read list changed what a worker starts with.**
Evidence: across 63 `pi` `imp` jobs `STATE.md` was read by 55, `spec.md` by 48, `ARCHITECTURE.md` by 54 and archived
cloud docs by 42, about 21.9% of prompt tokens (`STUDY/imp-load` §3.2); after `IMP-LEAN-01`, `STATE.md` fell to 1/29
(3%) and archived docs to 0/29, while `ARCHITECTURE.md` stayed 29/29 because §8 is required
(`STUDY/post-change-load` §3.2 #9); Turn-0 fell 5,890→4,085 tokens (`post-change-load` §3.2 #11).
Decision and lesson: a worker-safe `AGENTS.md`, §8 inlined in `.hud/brief.md`, no MCP adapter without a configured
server (`D-2026-11-22-17`); shared role text is the cheapest way to change every harness, which `agy-lean/01–04`
reused for agy's ~10.9 KB of MCP schema files.
Links: `.scratch/imp-lean/issues/01–06`, `.scratch/agy-lean/issues/01–04`, `.scratch/mcp-orch/issues/03`,
`D-2026-11-22-17`, `STUDY/imp-load`.

**11. Post-change load turned out to be a schema and first-message problem.**
Evidence: batch `jobs[]` and `brief_file` had 0/15 adoption because Claude Code still held 15:05Z cached schemas
(`STUDY/post-change-load` §3.1 #6, `orch-lean-2/01`); the earlier `hud-mcp-lean` measured 19,235→4,926 B for a cold
working set and 3 calls cold / 2 warm with zero polls (`hud-mcp-lean/01` comments).
Decision and lesson: emit `tools/list_changed` on reload, put role text and project brief in the CLI first message,
claim a ticket without a commit (`orch-lean-2/01–04`); a shorter schema clients never load changes nothing, and
`mcp-read-compact/01` measured the same bytes (327 B / 5 rows compact against 4,475 B / 20 rows, 92.69% saved).
Links: `.scratch/orch-lean-2/issues/01–04`, `.scratch/hud-mcp-lean/issues/01`,
`.scratch/mcp-read-compact/issues/01`, `D-2026-11-22-21`.

**12. The owner's answer path moved into records, then into one accept-all.**
Evidence: `trim/07` records that a `.scratch`-only commit naming `TEST-FLAKES-08` made it `try`, so Accept all
accepted it although it was in progress and marked `Owner try: no`; `home-compact/02` measured 14 jobs at ~38 rows
against a target of ~16 at 80 columns; `claude-mod/07` replayed ~30 old events on the first wake and 36 `changes`
lines on the next create.
Decision and lesson: `y`/`n` marks on panel rows replaced chat relays (`panel-try/01`), then accept-all plus the main
session's flagged items replaced per-slice try (`trim/02`), with one data rule in front of Accept all
(`trim/07`); `D-2026-11-22-28` makes attention the constraint, and each removal reversed an earlier feature.
Links: `.scratch/panel-try/issues/01`, `.scratch/trim/issues/02`,`07`, `.scratch/home-compact/issues/02`,
`.scratch/claude-mod/issues/01–09`, `D-2026-11-22-27`, `D-2026-11-22-28`.

**13. Test suites stopped racing fixed deadlines and started waiting on the asserted event.**
Evidence: `test-flakes/08` records ~20 flakes fixed across 01–07, nearly every one a 5–10 s deadline or a 200–350 ms
sleep, and `test-flakes/04` an install failing on 0640 vs 0600 file mode under the umask; `test-split/01` counted 158
top-level `test()` and 162 fixture uses in one file, and `04` cut decision-labels 6.5→1.2 s and
home-recommendation 6.7→0.8 s while the suite stayed ~70 s.
Decision and lesson: each case waits on the asserted event or state through `tests/helpers/until.mjs` with helper
defaults following the test signal (`test-flakes/08`); per-gate tickets lost ground until 08 fixed the class, and the
one-rerun rule kept the pattern hidden, while `auto-route/07` and `optional-roles` hit load flakes again.
Links: `.scratch/test-flakes/issues/01–08`, `.scratch/test-split/issues/01–04`,
`.scratch/auto-route/issues/07`, `.scratch/optional-roles/issues/01`.

**14. Role became work plus an ordered list of places.**
Evidence: `role-bind/spec.md` records 14 roles for a handful of kinds of work and its `04` comments cycling ~170 pi
models as unusable; `cli-workers` needed one live run per kind — grok 20 s, agy 20 s, claude 12 s, codex 31 s
(`cli-workers/01`,`04`–`06`) — and `09` records an agy job quit after 18 minutes of work in progress.
Decision and lesson: role = work plus an ordered `run` list with fallbacks and one-hour exhaustion marks, `hud trust`
separate from setup, and the `*-imp` CLI roles deleted (`role-bind/01–05`); each CLI kind needed a live run, and
older MCP clients read new bundled role files as invalid until they restart (`cli-workers/01` comments).
Links: `.scratch/role-bind/issues/01–05`, `.scratch/cli-workers/issues/01–10`,
`.scratch/hud-setup/issues/01–06`.

**15. Review shape changed three times and each shape caught a different class of defect.**
Evidence: `m4-close/05` records round 10 with both reviewers accepting and the suite green; `perf-ts/09` fixed
behaviour bugs the performance work leaked (worker zone, zai colour, EXP cache watch); `open-review-fixes/01` records
~51% of job dirs being sonic children that took 52–59% of card sentences, `review-next/02` that 31 of 46 land repairs
were cherry-pick conflicts mostly in three single-line docs, and `open-review-fixes/04` 33 of 116 lands replayed.
Decision and lesson: `review-cross/01`, a mechanical "implementer and reviewer from different providers" rule, was
dropped the same day because milestone reviews already span mixed implementers; the three independent reviews
converged on the same evidence gaps.
Links: `.scratch/m4-close/issues/05`, `.scratch/perf-ts/issues/09`, `.scratch/open-review-fixes/issues/01–06`,
`.scratch/review-next/issues/01–08`, `.scratch/review-cross/issues/01`.

---

## 4. Recurring Problems Across Themes

Rows merge duplicates that appeared in more than one extraction. "Design attempts" counts separate tickets that
reworked the same problem, not commits.

| Problem | Features where it appeared | Design attempts | Status now |
| --- | --- | ---: | --- |
| Completion inferred from screen or process instead of declared | `cli-workers/09`, `supervisor/04–08`, `worker-close/01`,`03`, `supervisor-fix/01` | 3+ ("what counts as work" reached a third design) | Improved; `supervisor-fix/1` is the latest, and `worker-close` left a partial-reap gap |
| Stale or pre-existing state presented as live | `orch-lean-2/01`, `land-log/03`, `claude-mod/07–09`, `mcp-read-compact/01`, `monitor-state/01` | 3 | Mostly solved by cursor-at-switch, fresh-window listing and turn-scoped reads; `claude-mod/08` records a second instance with no closing fix line |
| Fixed sleeps, deadlines and fixed-interval polling | `async-watch/01–03`, `event-waits/01–04`, `test-flakes/01–08`, `perf-hygiene/06`, `imp-lean/03` | 4 | Solved (sleep→event wait, poll→push, 30 s tick→socket, 5–10 s test waits→signals) |
| Context the caller pays for that the HUD could carry | `hud-mcp-lean/01`, `mcp-orch/03`, `orch-lean/01–05`, `mcp-read-compact/01`, `imp-lean/01–06`, `agy-lean/01–04` | 6 slices | Solved per slice, measured in bytes; agy's own reminder and duplicate transcripts remain facts only (`agy-lean/03`) |
| Land fragility (flakes, conflicts, retries, docs) | `dogfood-fixes/09`,`13`,`14`,`17`,`21`, `flows/01–05`, `land-log/01–03`, `review-next/02` | 4+ | Mostly solved; 31 of 46 repairs were conflicts in three single-line docs (`review-next/02`), and flakes recurred through 11-23 |
| Lifecycle and cleanup paths disagree | `supervisor/04–07`, `worker-close/03`, `supervisor-fix/A`,`B`, `land-log/03` | 3 | Partly; a partial reap failure can still leave a tab (`worker-close/03`) |
| Child jobs crowd shared windows, budgets or notices | `open-review-fixes/01`, `perf-hygiene/02`, `scan-fixes/06`, `home-compact/01` | 3 | Solved: children skipped in text/windows, paged `hud_read`, one running count for sonic |
| Panel truth, width and language | `project-hub`, `panel-tidy/01`,`02`, `panel-ux/01`,`02`, `panel-polish/01–04`, `home-compact/02`, `i18n-check/01` | 4 acceptance passes | Guarded by golden frames and a dictionary test (19 overridden duplicate keys removed); `panel-polish` was itself another acceptance pass |
| The owner's try records | `panel-next/01`, `panel-redesign/04`, `panel-try/01`, `panel-ux/01`, `trim/02`,`07` | 4 | One accept-all record plus a flagged list, with a landing rule in front of it |
| Placement precedence and who may choose a model | `role-overrides/01`, `concurrency-cap/01`, `auto-route/03`,`05`, `flex-seat/01`,`02` | 3 | Explicit rules: role file owns place, only `general` overrides, overflow keeps the chain, create-time place wins |
| Unactionable failure evidence; owner-HOME install fragility | `scan-fixes/03`,`04`,`05`, `dogfood-fixes/09`, `agy-adapter/01`, `agy-lean/04`, `hud-setup/05` | 2 each | Failure evidence solved (assertions first, bounded excerpt, pane and `exit_reason`); install now backs up and is idempotent, agy `eager` untested |

---

## 5. Lessons for Running an Orchestrator with Workers

1. **Delegate evidence, keep judgement.** `orch-lean/01–05` moved lookups and gates to roles while the main session
   kept accept/repair; `mcp-orch/proposal.md` shows why (3% mechanics, most cost was reading); `imp-lean/01` cut the
   same doc tax on worker entry.
2. **Completion must be a declaration, not an observation.** `cli-workers/09` (a `/quit` after 18 minutes),
   `supervisor/08` (facts-only endings), `worker-close/01` (herdr showed `idle` for 5–10 s with a child alive) and
   `close-on-delivery/01` (close at `hud_report`) are four stages of the same rule.
3. **A cleanup path needs the same review as a lifecycle path.** `worker-close/03` found a partial reap could drop
   the retry and leave the tab; `supervisor-fix/A`,`B` had to re-order tab-close and keep a failed reap pending;
   `land-log/03` shows a repair judging its own pre-turn state.
4. **One primitive for waiting and one for locking.** `event-waits/03` replaced sleep polling and `flock` with
   `fs-wait` and `abstract-lock`; `async-watch/01` had already shown a 135 s freeze from a blocking reap;
   `imp-lean/03` removed the last poll (`timeout_s: 0`) in favour of a push.
5. **A new cursor replays history until it is cut at the switch point.** `claude-mod/07` (~30 old events on first
   wake), `land-log/03` (pre-turn status) and `monitor-state/01` (reload dropped filter input, `g` and drafts) are
   the same defect in delivery, landing and panel state.
6. **Policy belongs where the owner can edit it.** `auto-route/03` moved tier presets from `src/` into the role
   file's `routing` block; `role-overrides/01` made role files the only place; `flex-seat/02` turned an on/off
   setting into `fixed`/`even`/`auto`; `mcp-orch/03` dropped `convention_version` because the server remembers what
   it sent.
7. **Measure the bytes the model pays, before and after.** `mcp-read-compact/01` (327 B vs 4,475 B),
   `hud-mcp-lean/01` (19,235→4,926 B), `native-statusline/01–04` (pi segment 22 ms→<1 ms; Rust p50 <5 ms; agy
   22 ms→<5 ms) and `agy-lean/01` (12 MCP schema files ~10.9 KB) each judged a change by a counted before/after.
8. **A removal needs a landing rule.** `trim/07` gates Accept all on a commit outside `.scratch/`; `flows/02–04`
   carry `Status: done` with unticked acceptance boxes, so landed-but-unverified rows exist; `home-compact/04` was
   won'tfixed rather than half-built.
9. **Tests should wait on the asserted event.** `test-flakes/08` shows the class (5–10 s deadlines, 200–350 ms
   sleeps) that `auto-route/07` and `optional-roles` then hit again under load; `test-split/04` shows the remaining
   suite cost is subprocess-heavy MCP lifecycle tests, not the split files.
10. **A shorter reply that forces a second call is not lean.** `hud-mcp-lean/01` and `mcp-read-compact/01` name that
    failure mode and keep ids, states, questions and hints; `open-review-fixes/07` records a 57 KB `hud_read` full
    report spilled out of the client, needing a second read.

---

## 6. Reversed or Wontfix Decisions Worth Remembering

- `review-cross/01` (wontfix): a mechanical cross-provider reviewer rule bought nothing because milestone reviews
  already span mixed implementers; reviewer defaults to astra max with a neon fallback.
- `supervisor/06` and `supervisor/07` (wontfix): supervisor death is not job death, and one announcer — both
  superseded by the one-judge rewrite in `08`.
- `cli-workers/01`,`09` reversed: a `done` without a report used to fail and `/quit`; now it stays open and the HUD
  does not nudge (owner: do not interfere).
- `role-bind/04`,`05`: cycling ~170 pi models in a picker was rejected (a filtered provider→model picker moved to a
  later phase), and oracle stopped being a browser task for a local-advisor role while `pro` took the browser places.
- `optional-roles/01` reversed a spec line: `pro` and `flow` left the default roster and became opt-in.
- `flex-seat/02` reversed itself: imp routing on/off became `fixed`/`even`/`auto`, on→auto and off→fixed migrated on
  read.
- `role-overrides/01` reversed per-job model choice for non-`general` roles on owner instruction.
- `mcp-orch/05` and `proposal.md`: restarts stay manual (herdr proves session identity but not the worker protocol);
  no plan execution and no resident server (~3 ms scan).
- `report-summary/02`: self-grading in `hud_report` (outcome/verdict) dropped by the owner.
- `trim/04`,`02`,`06`: the job `kind` label, Home's Recommended ranking, per-slice try machinery and the `STATE.md`
  slice ledger removed (outcome, question category, review severity and routing kept); tickets are the only ledger.
- `home-compact/04` (wontfix): attention-first display; diff size, test counts and context fill are detail for an
  opened job (`D-2026-11-22-28`).
- `trim/01` with `project-layouts/01` and `panel-redesign/03`: Project kept Timeline, Board and Inbox, then Inbox only
  — layout churn ended by removal, not by a setting.
- `statusline-workers/01–03`: census → live-only → one glyph and count per role, reversed twice in one day.
- `panel-ux/01` reversed `panel-v2/01`: the owner answers with `1`–`4`/`d` directly instead of `r` first.
- `review-next/06`,`08`: "checks never settle" and "main decides each step" are reversed for authorized batches only
  (`D-2026-11-22-26`), with spec lines changed when those tickets are dispatched.
- `primitives/04` and `perf-ts/09`: no `$HUD_HOME/models.json` (built-in catalog only), and only the ARM64 assertion
  split was taken from the perf review; the other optional items were left.
- `agy-adapter/03`: idle event delivery can lag ~30 s; accepted, not fixed.

---

## 7. Measures That Exposed Problems

Tag `[job]` when the measure needs HUD job facts (role, ticket, outcome, dispatcher), `[tok]` when token or session
data suffices, `[screen]` when only looking at the rendered panel shows it.

| Measure | What it caught | Features | Tag |
| --- | --- | --- | :---: |
| Bytes the model pays per reply and per tool list | 327 B / 5 rows compact against 4,475 B / 20 rows `recent` (92.69% saved); 19,235→4,926 B working set; batch forms 0/15 adoption because schemas were cached | `mcp-read-compact/01`, `hud-mcp-lean/01`, `orch-lean-2/01` | [tok] |
| Turn classification by activity bucket | 72.6% of 781 turns mechanical; 8.7 turns and `$0.48` per slice after | `orch-lean/01–05` (`STUDY/orch-load`) | [tok] |
| Report-written to report-read latency; job-dir scan cost | median 20 s and ~3 ms, which argued for mechanics and against a resident server | `mcp-orch/proposal.md` | [job] |
| Census of finished worker sessions | 97.5% of 157 sonic jobs never interacted; 95 of 185 jobs (51%) brief-to-report; ~51% of job dirs are sonic children | `sonic-lite/01`, `auto-route/01`, `open-review-fixes/01` | [job] |
| Cost per job by model | astra `$3.40` mean / `$2.93` median against `sol-fast` `$0.91` / `$0.73` | `STUDY/imp-model-cost` | [tok] |
| Zero-poll turns in parent sessions | 89 polls and 746 s of parent LLM time before the push, 4 after | `imp-lean/03` (`STUDY/post-change-load` §2) | [tok] |
| Land outcome and replay counts | 33 of 116 lands replayed; 9 of 10 zero-touch after `DF-11` | `open-review-fixes/04`, `STUDY/post-change-load` §1.5 | [job] |
| Gate failure composition | an 8 KiB excerpt with 83 of ~100 lines blank; 31 of 46 repairs were doc-line conflicts | `scan-fixes/04`, `review-next/02` | [job] |
| Launch and worktree records | 595 of 631 jobs recorded the caller's pane; 6 raw-JSON `exit_reason`; 4 `agent_pane_busy` in one second; 44 kept worktrees, one sweep `removed=0 kept=36` | `scan-fixes/05`,`08` | [job] |
| Rendered frames at fixed widths | a 42-column Home title cut to 9 cells; 14 jobs took ~38 rows at 80 columns | `panel-polish/01`, `home-compact/02` | [screen] |
| Statusline timing | pi segment 22 ms→<1 ms; agy statusline p50 ~88 ms→~17 ms | `native-statusline/01–04`, `agy-adapter/04` | [job] |
| Own-day dogfood counts | 5,451 temp dirs ~1.5 GB; a gate hung 45 min with five lands queued; 8 surviving watcher processes | `dogfood-fixes/22`,`14`,`02` | [job] |

---

## 8. Gaps

- **No before-number for most panel and UX changes.** The extractions record "none recorded" for evidence on
  `bar-notice`, `panel-next`, `panel-redesign`, `panel-v2`, `ux-pass`, `control-tab`, `project-layouts`,
  `home-progress` and others; the load studies measured entry, not the panel.
- **Done with unticked boxes, and status fields disagree.** `flows/02–04` and `supervisor-fix/01` carry
  `Status: done` with unchecked acceptance items, so a count of "done" is not a count of verified behaviour.
- **Open after the change.** `hud-mcp-lean` records the live TUI try as pending; `hud-setup/06` the owner's own
  `/hud-setup` run; `agy-adapter/02` `eager` untested; `STUDY/post-change-load` §2.3 records `reviewer`, `oracle`,
  `scout` and `from_jobs` at no post-change runs, and the parent `imp` re-reading a `sonic`-cited file rose from
  63.8% to 80.8% (verdict `worse`) with no ticket closing it.
- **No per-job `agy` cost.** `STUDY/post-change-load` §1.4 records per-job USD as unavailable, so the `agy`
  comparison rests on turns, wall time and machine-wide daily totals.
- **Rejected findings and owner complaints are not recorded.** `STUDY/session-scan` §4 states that per-slice
  coverage counts, the "things that look fine" sections and the findings that never became tickets do not survive;
  no ticket records an owner complaint, so the owner's words exist only where a ticket paraphrases a decision.
- **Doc and Help drift.** `panel-polish/01` found Help promises the panel did not meet (≥16-cell title, Hide-after 15 vs 5), and `spec-docs/03` records a restructure after which Help changed again in `trim`.
- **Accept-all has one recorded false positive** (`trim/07`) and no recorded check that the rule generalises.

**Caveats.** (1) This is a synthesis of five extractions, not a re-read of 338 issue bodies; a claim rests on the
extraction plus, where marked, the issue file or decisions log I opened, and counts were not recomputed. (2) Where
the studies and the decisions log differ — the `imp` default model is the clear case — §3.6 states which I followed.
(3) The window ends `2026-11-23`; later work, including the land train and `hud_tickets run` items from
`review-next`, is visible only as ticket status.

**Not checked:** issue bodies beyond titles, Status, "What to build" and Comments; `docs/reviews/*`; `docs/design/*`;
`docs/spec.md` and `docs/handoff/STATE.md`; commit diffs behind the landings; the `session-scan` slice runner copies
under `tmp/` (not committed).
