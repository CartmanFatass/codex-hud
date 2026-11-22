# Home, Progress and Tickets: Diagnosis and Design Proposal

> **Scope:** Re-review Home, progress and tickets from scratch (`docs/spec.md` boundary; no product code changed). Companion interactive-free terminal mockup: [`sample.html`](./sample.html) (40-column grids in `zh` and `en`, synthetic `harbor-api` data only).

---

## 1. Diagnosis (Root Causes with `file:line`)

Every symptom on the live Home screen traces to concrete collector, renderer and MCP mechanics:

### 1.1 Progress and tickets look like "nothing is done" and "everything is stalled"

1. **`homeProgressRows` skips every 100%-done feature and dumps up to 6 open tickets per remaining feature (`src/render/project-view.ts:82-96`, called with `spare = 99` in Split Home at `src/render/split-home.ts:108`).**
   - `ProjectCollector.tickets()` (`src/collectors/project-board.ts:233-236`) keeps *every* feature with an open ticket and caps the returned array at `16` (`let room = 16 - features.filter(open).length`), discarding older finished features even from `Project → Tickets` totals.
   - `homeProgressRows` (`src/render/project-view.ts:82-88`) then filters to `open.length > 0` with **no project-wide ticket completion line**, and ignores `Settings → Panel → Detail: task` (`acceptance: 'task'`, `src/render/project-view.ts:58,82-96`), rendering a separate `工单 · <slug> ── 0/N 完成` block plus raw ticket lines for every freshly drafted feature (`0/4`, `0/1`, …) while 40+ finished features (~160 completed tickets) vanish completely.
2. **Normal sequential `Blocked by` edges are classified and translated as `blocked` / `受阻` (`src/collectors/project-board.ts:228`, `src/render/project-view.ts:91`, `src/render/workboard-i18n.ts:317`).**
   - `if (ticket.state === 'ready' && ticket.blockers.length) ticket.state = 'blocked'` (`src/collectors/project-board.ts:228`) collapses *"planned step 02 after step 01"* and *"genuinely stuck"* into one state (`blocked` → `受阻`). Drafting a 4-slice chain immediately paints 3 rows of `受阻`.
   - **Cross-feature blocker bug (`src/collectors/project-board.ts:218-229`):** Blocker references only search `tickets` within the **same** feature (`tickets.find(...)`). Cross-feature blockers such as `**Blocked by:** primitives/03` (e.g. `.scratch/place-health/issues/01-control-dispatch-today-splits-by-place.md:4`) never match a local ticket number or title, so they remain permanently `blocked` even after `primitives/03` finishes.
3. **Milestone vs. work-stream mismatch breaks the Home Progress row, bar and legend (`src/collectors/project-board.ts:404-405`, `src/render/project-view.ts:61-65,171-178,218-221`, `src/collectors/acceptance-tasks.ts:11-21`).**
   - `STATE.md` sets `Milestone: 0.2.0 · …` (`docs/handoff/STATE.md:3`), while recent `## Slices` rows use **feature/stream tags** (`CODE-HEALTH`, `AGY`, `MCP-ORCH`, `REPORT-SUMMARY`, `SPEC-DOCS`) or `—` in column 2 so `acceptanceTasks` groups `try` slices into manageable batches (`docs/handoff/STATE.md:34-82`).
   - `currentRows(data)` (`src/render/project-view.ts:218-221`) filters `r.milestone === "0.2.0"`, matching only 7 older accepted rows and missing 30+ active `0.2.0`-era feature slices. `homeProgressRows` (`src/render/project-view.ts:62-65`) then pairs that green-only 7-slice bar (`counts.try === 0`) with all-ledger `tryCount` (`5 待试用`), while `pageSummary('progress')` (`src/render/project-view.ts:171,177`) counts every historical milestone and `—` slice via `ledgerTasks(data.ledger)` (`src/collectors/acceptance-tasks.ts:14`) to print `62 个任务` (`62 tasks`).
   - Meanwhile `data.summary` (`src/collectors/project-board.ts:390`) looks for `## Now:`, which `STATE.md` no longer has, and `ProjectCollector.collect` returns early on Home (`src/collectors/project-board.ts:406-424`) before reading `spec.md` ladder IDs (`line 428`) or joining live jobs (`lines 505-561`).

### 1.2 Failed jobs stay pinned at the top of Home long after a retry succeeds

1. **The panel collector never reads `observed_at`, `retry_of`, or superseding jobs/slices (`src/collectors/thin-jobs.ts:34-35,470-517`).**
   - `observed_at` is omitted from `factKeys` (`src/collectors/thin-jobs.ts:34-35`) and ignored by `readThinJobs`; `failureUnobserved` (`src/collectors/thin-jobs.ts:267-274`) is only consulted by MCP `hud_read({})` (`src/mcp/thin-main.ts:871`), `hud watch` catch-up (`src/cli/watch.ts:59`), and orphan pane adoption (`src/collectors/thin-jobs.ts:282`, `src/roles/job-project.ts:55`).
2. **`dispatchJob({retry_of})` neither records `retry_of` on the new job nor marks the failed job observed (`src/mcp/thin-main.ts:1185-1198,1306-1323`).**
   - Unlike `repair_of` (`src/mcp/thin-main.ts:1316`), `retry_of` is discarded after copying options, and `source.observed_at` is never stamped on retry—only when the orchestrator explicitly calls `hud_read({job})` (`src/mcp/thin-main.ts:1768`) or `hud_close({job})` (`src/mcp/thin-main.ts:1814`). Worse, an unobserved failure from a closed pane is adopted onto the new session's pane (`src/roles/job-project.ts:55`), pulling it back onto Home (`src/collectors/thin-jobs.ts:489`).
3. **Lane sorting and `Recommended` mode pin every failed job above running and succeeded retries for up to 24 hours (`src/render/work-lanes.ts:12-32`, `src/render/split-home.ts:52-53,83-85,119`, `src/collectors/home-recommendation.ts:13,121`, `src/render/work-visibility.ts:5-6,20-25`).**
   - `workerPriority` (`src/render/work-lanes.ts:19`) ranks `failed` (`2`) ahead of `in-progress` (`4`) and `done` (`5`). When a retry runs or succeeds in the same `MCP-SPLIT-04` lane, `laneTop` (`src/render/split-home.ts:52-53`) **still selects the old failed job** as the lane's headline and failure-reason row, and `group(lane) <= 2` (`src/render/split-home.ts:85,119`) floats it to the top of Home.
   - In `Recommended` mode, `protectedCard` (`src/collectors/home-recommendation.ts:13,121`) gives every failed card `homeRank = 100`, and `currentWorker` (`src/render/work-visibility.ts:20-21`) keeps `homeRank === 100` visible until `FAILED_STALE_MS` (**24 hours**), bypassing `cardHideMinutes` (15m) and `FAILED_HIDE_MS` (30m).

### 1.3 `等你处理` and job titles stay in English when `language = zh`, and the AI progress summary goes stale

1. **`TryBriefs` never runs while the owner stays on Home (`src/panel/controller.ts:343-344`).**
   - `models.tryBriefs.update(...)` is gated by `projectShown(state)` (`state.activeTab === 'project'`). On Home, newly landed `try` slices never generate localized `zh` briefs and fall back to raw English ledger prose (`src/render/split-home.ts:98-101`, `src/render/project-view.ts:456`).
2. **`STATE.md` `Waiting for the owner` bullets and open `hud_ask` questions have no localization path (`src/render/project-view.ts:209-214`, `src/render/home-view.ts:48`, `src/collectors/decision-titles.ts:41-58`).**
   - `waitingRows` paints English `STATE.md` prose verbatim; `STATE.md` currently also holds multi-line `Owner 2026-11-22: …` decision logs under `## Waiting for the owner` (`docs/handoff/STATE.md:12-17`), keeping `?2` pinned. `DecisionTitles` only translates *already answered* questions in the Inspector (`src/collectors/decision-titles.ts:40-41`), leaving live `hud_ask` slabs in English.
3. **English brief headings override localized `JobSentences` names, and `"Slice "` truncates distinct lanes into identical `"Slice ASYNC…"` (`src/collectors/thin-jobs.ts:513-515`, `src/render/split-home.ts:62-63`, `src/collectors/job-sentences.ts:295,344`).**
   - `thin-jobs.ts:515` derives `label` from `title.split(':', 1)[0]` (`"Slice ASYNC-WATCH-02"`), and `split-home.ts:63` caps the lane column to `Math.min(14, Math.floor(width / 3))` (12–13 cells), cutting `-WATCH-02` and `-WATCH-03` into identical `"Slice ASYNC…"`.
   - `JobSentences` already asks the model for localized `{"name","sentence"}` (`src/collectors/job-sentences.ts:296`), **but line 344 writes `task: w.briefTitle ?? row?.name ?? w.task`**, so an English markdown `#` heading in `brief.md` always beats the Chinese `row.name` (and summary-translation calls at line 295 omit `name` altogether).
4. **Why the `HomeRecommendation` AI summary still claimed two slices failed after both landed (`src/collectors/home-recommendation.ts:44-46,55-58,101-120`).**
   - `workers(board)` (`line 45`) filters `currentWorker(...) || protectedCard(w)`. After 15 minutes (`cardHideMinutes`), the **succeeded retry cards left `currentWorker`**, while the **old failed cards stayed in `workers(board)` via `protectedCard(w)`** with empty `sentence` (`src/collectors/thin-jobs.ts:642`), feeding `<home>` *only* the dead failures (`"未提供原因或报告"`).
   - Even within 15 minutes, `summarize()` (`line 101`) throttles refreshes for `summaryMs` (5m) and drops cap/HTTP failures, while `apply()` (`line 119`) falls back to `?? this.lastSuccessfulBrief` **even when `briefKey(workers)` no longer matches the board**.

### 1.4 Ticket and `STATE.md` status require error-prone manual edits

1. **`hud_tickets` rejects `claimed`, `done`, and `resolved`, and rejects cross-feature `blocked_by` (`src/roles/tool-definitions.ts:14,136`, `src/mcp/local-tickets.ts:16-23,64`).**
   - `TICKET_STATUSES` only allows `['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix']`. Orchestrators had to raw-edit markdown files to write `Status: claimed` or `Status: resolved`, or misused `ready-for-human` after landing code—leaving **41 tickets** in `.scratch/` on `ready-for-human` (which `asksYou` at `src/render/project-view.ts:547-549` treats as *waiting on a human answer* whenever any checkbox is unchecked, as on `mcp-orch/05`!).
2. **Home never joins live jobs onto tickets (`src/collectors/project-board.ts:406-424`, `src/render/project-view.ts:91`).**
   - Because `collect('home-tasks')` returns at line 423 before `recentJobs()` (`line 505`), `ticket.job` is `undefined` on Home, and `homeProgressRows` (`line 91`) renders `t(ticket.state)` instead of `ticketWorking(ticket)`. Without a manual `Status: claimed` file edit, a ticket with an active `imp` still shows `就绪` (`ready`).
3. **Owner `y`/`n` actions in `$HUD_HOME/tries.jsonl` only paint a row glyph—counts, bars, tickets and `(waits on …)` lag until `STATE.md` is hand-edited (`src/collectors/try-records.ts:57-65`, `src/panel/controller.ts:185-186`, `src/collectors/project-board.ts:392-403`).**
   - Pressing `y` appends to `tries.jsonl`, but `ProjectSnapshot.counts`, `tryCount`, `waitSettled`, and ticket completion ignore `tries.jsonl`, keeping `5 待试用` and `?2` on screen until the main session wakes and edits `STATE.md`.

---

## 2. Recommended Design: Rollup Home + Live-Derived Truth

Keep `STATE.md` and `.scratch/` as plain files (respecting `docs/spec.md` §3: no ledger database, no workflow engine, no panel writes to repo files), unify them at read time into one **`milestone → feature → ticket/slice`** rollup, retire superseded failures automatically, and enforce one display-language contract.

### 2.1 What Home shows to answer "where does my work stand?" at a glance

Home answers three questions in priority order—**1. What needs me?  2. What is moving now?  3. Where does the milestone stand?**—in both **Split** and **Classic**:

- **Split Home list (top pane):**
  1. **Needy & active lanes** (`?` open worker question, `✗` *un-superseded* failure, `◉` running feature/slice lanes, `✓` fresh settled card <15m). Multiple jobs on one feature (`package: "async-watch"` or `ASYNC-WATCH-02`/`03`) share one feature lane (`◉ async-watch  2 工作中  imp 4分`) or show stripped, suffix-preserving IDs (`ASYNC-WATCH-02`), never three identical `Slice ASYNC…` rows.
  2. **`? 等你处理` (`Waiting for you`)**: Right side separates owner decisions from landed tries (`1 待决定 · 2 待试用` / `1 decision · 2 to try`). Preview lists localized pending decisions (with `▸ 原文` fold) above actionable `待试用` tasks/slices (with localized 1-line `TryBrief` and `Space`/`y`/`n` in place).
  3. **`◐ 进度` (`Progress`)**: Right side shows **`<milestone> · N 待试用 · M 工作中`** (e.g. `0.2.0 · 5 待试用 · 2 工作中`; when idle, `0.2.0 · 38/47 已验收`), replacing `62 个任务`.
- **`进度` preview (Split) / bottom Progress block (Classic spare rows):**
  1. **Milestone bar + 4-bucket rollup** (`进度 ── 里程碑 0.2.0`): Stacked cell-exact bar over the unified current milestone (`✓ 已验收` green `█`, `◇ 待试用` violet `▒`, `◐ 工作中` blue `█`, `◆ 受阻` amber `█` *only when >0*, `○ 已规划` muted `░`), plus a single-line count legend (`✓ 14  ◇ 4  ◐ 2  ○ 6`).
  2. **Project ticket meter** (1 row): `工单 ━━━─ 162/184 完成 · 40 功能完结` (`Tickets ━━━─ 162/184 done · 40 features done`). Completed work is always visible first.
  3. **Active & next features** (`Detail = task` default, per `spec.md` §2.2.3): One row per **active or partially completed** feature (`◐ async-watch  ━━── 1/4 · 2 工作中`, `● mcp-split  ━─── 1/4 · 1 就绪`).
  4. **Folded planned queue (`0/N` features)**: Unstarted planned features (`done === 0`, `working === 0`, no `For you` item) **never expand individual tickets on Home**; they collapse into one summary row: `▸ 已规划 6 个功能 · 18 张工单（5 就绪 · 13 待前序）` (Enter opens `Project → Tickets`). Even at `Detail = slice`, Home shows only `For you` / `Working` / `Ready` tickets (capped) and collapses dependency-ordered items into `+N 待前序` (`+N queued`).
  5. **AI progress brief (`Recommended` mode)**: Only shown when `summaries.get(briefKey)` matches the **current** non-superseded board + rollup fingerprint; stale `lastSuccessfulBrief` fallback is removed.

### 2.2 Rollup Model: `milestone → feature → ticket/slice` (`done` vs `planned` vs `stalled`)

```text
Milestone (spec.md §5 + STATE.md `Milestone: 0.2.0`)
 ├─ Feature / Stream (`.scratch/<slug>/` joined with STATE `<scope>` / `<SLUG>-<NN>` slices)
 │   ├─ Ticket `01..NN` (`.scratch/<slug>/issues/NN-*.md`)
 │   └─ Ledger slices (`- <state> · <scope> · <ID> · ...`)
 └─ Standalone 1-slice work (`- <state> · 0.2.0 | — · <ID> · ...`, no `.scratch/` folder needed)
```

1. **Milestone attribution:** A ledger row belongs to its explicit release milestone (`M1..M4`, `0.1.x`, `0.2.0`, matching `spec.md` §5 `ladder.ids`). If column 2 is `<milestone>/<feature>` (optional explicit syntax) or a non-ladder feature tag (`CODE-HEALTH`, `AGY`, `MCP-ORCH`, `REPORT-SUMMARY`, `SPEC-DOCS`) sitting in the active post-previous-release block of `STATE.md`, its **Milestone** is `ladder.current` (`0.2.0`) and its **Feature** is that tag (`code-health`, `agy`, …), preserving `Detail = task` grouping while making the `0.2.0` bar accurate.
2. **All-feature ticket totals:** `ProjectCollector.tickets()` scans up to 64 `.scratch/*/issues` directories (512 files max, signature-cached by `dev:ino:size:mtime:ctime`) to compute exact `{doneTickets, totalTickets, doneFeatures, totalFeatures}` across the whole project, while keeping full per-ticket item/comment objects bounded to open features + newest finished up to 16.
3. **Five honest ticket/slice states (replacing `blocked` overload):**
   - **`done` (`已完成`, `✓` green):** `Status: done|closed|complete|resolved`, all checkboxes `[x]` (≥1), or linked slice `accepted` (including via `tries.jsonl`). (`wontfix` / `dropped` → `dropped` `–`, counted as resolved in feature ratios.)
   - **`try` (`待试用`, `◇` violet):** Linked slice is `try` in `STATE.md`, or a commit on `HEAD` names `<FEATURE>-<NN>` / `<feature>/<NN>` while not yet accepted. **Unblocks downstream `Blocked by` tickets** so sequential slices in a milestone don't look blocked waiting for end-of-milestone owner trial.
   - **`working` (`工作中`, `◐` blue):** Linked unsettled HUD job or active managed worktree (plus `Status: claimed` when <2h old).
   - **`planned` (`已规划`):**
     - **`ready` (`就绪` / `可开工`, `●`):** Open, no unresolved `Blocked by` refs (resolving both local `01` and cross-feature `<feature>/<NN>`!).
     - **`queued` (`待前序`, `·` / `→ 01` muted):** Open `ready-for-agent` ticket waiting **only** on `working`, `ready`, `try`, or `queued` predecessors. Never painted amber, never counted as `blocked`/`stalled`.
   - **`stalled` (`受阻`, `◆` amber):** Reserved strictly for **real blockers**: `STATE.md` slice `blocked`; ticket `needs-info` / `needs-triage`; predecessor itself `stalled`; un-superseded failed job; live job `blocked` / `waiting_orchestrator`; or `Status: claimed` with no live job and no worktree (`claimed, no job` drift).

### 2.3 When Failed Jobs Leave Home

A failed or stopped job `J` is marked **`superseded: true`** in `readThinJobs` (`src/collectors/thin-jobs.ts`) as soon as **any** of the following holds:

1. **Direct retry / repair chain:** Any newer job `J2` (`J2.created >= J.created`) has `J2.retry_of === J.job`, `J2.repair_of === J.job`, or `J2.from_jobs?.includes(J.job)` (and `dispatchJob` in `src/mcp/thin-main.ts` now writes `retry_of` into `J2`'s `job.json` and stamps `observed_at` on `J`).
2. **Newer job on the same target:** Any newer job `J2` (`J2.created > J.created`) in the same project has the same `(role, targetKey)`—where `targetKey` is explicit `(package, ticket)` when present, else normalized slice/lane ID (e.g. `MCP-SPLIT-04` or `async-watch/02`). If `J2` is `working` or `done`, `J` is superseded; if `J2` also failed, `J2` supersedes `J` so at most **one** latest failure ever shows per target.
3. **Landed in ledger or tracker:** `J`'s normalized slice ID or `<feature>/<NN>` ticket is already `try`, `accepted`, `done`, or `dropped` in `STATE.md` / `.scratch` / `tries.jsonl`.

**Visibility & ranking rules:**
- **Superseded failures** leave default Home immediately (`currentWorker === false`, `protectedCard === false`, excluded from `HomeRecommendation.workers()`, `hud_read({})` compact list, and orphan adoption). Pressing `a` (`showAll`) reveals them muted in place (`✗ imp  MCP-SPLIT-04  已替代 28分` / `superseded 28m`) so history is never lost.
- **Observed, un-superseded failures** (`job.observed_at` stamped by `hud_read({job})` or `hud_close({job})`, now included in `thin-jobs.ts` `factKeys`): demote from `needs-you` (`priority 2`) to settled history—folding after `cardFoldMinutes` (5m) and hiding into `a` after `cardHideMinutes` (15m).
- **Unobserved, un-superseded failures:** stay at `priority 2` so genuine unhandled crashes surface at once, but cap `Recommended` protection on Home at `Math.max(cardHideMinutes, 30)` minutes instead of 24 hours (`FAILED_STALE_MS`).

### 2.4 Concrete Display-Language Rule (`zh` vs `en`)

Every piece of text on Home and Project belongs to one of three deterministic classes:

| Class | Examples | Rule | Model calls |
|---|---|---|---|
| **1. Identifiers** | `ASYNC-WATCH-02`, `mcp-split`, `0.2.0`, `imp`, `c5032bc1`, `src/panel/*` | **Never translate.** Strip leading boilerplate `^(?:Slice\|Ticket\|Task\|Package)\s+` on ingest (`"Slice ASYNC-WATCH-02: …"` → `ASYNC-WATCH-02`). When fitting narrow columns (`split-home.ts`), middle-truncate (`ASYNC…02`) so numeric suffixes `-02`/`-03` never collide. | **0** |
| **2. Chrome, states & rollups** | `等你处理`, `1 待决定 · 2 待试用`, `待前序`, `已规划 6 个功能`, `已替代` | **Always `t()`** (`src/render/i18n.ts`), enforced by `I18N-CHECK-01`. Folding `0/N` features removes raw English ticket dumps from Home even with `Model text` off. | **0** |
| **3. Surfaced prose** | Job task names & sentences; `待试用` briefs; `Waiting for the owner` bullets; open `hud_ask` slabs; (optional) open ticket titles | **Source rule:** Orchestrator writes `STATE.md` `## Waiting for the owner` in the owner's configured language (`zh` when panel language resolves to `zh`). **Display rule (`Model text` on):** If `wrongLanguage(text, panelLanguage)` is true, show cached `SmallModel` translation in `panelLanguage` (preserving inline IDs and option keys `[1]..[4]`/`d`), with `▸ 原文` (`▸ Original`) folded below. If already in `panelLanguage` or `Model text` off, show original prose with **0 calls**. | **0** when in target language; **1 cached call per unique text hash** when wrong-language |

Concrete fixes under Class 3:
1. **`JobSentences` (`src/collectors/job-sentences.ts:295,344`):** Include `"name"` in summary-translation replies too; when `w.briefTitle` fails `wrongLanguage(w.briefTitle, language)` and `row?.name` is present, format `task` as `<ID> · <row.name>` (e.g. `ASYNC-WATCH-02 · 观察器异步 herdr 调用`)—**zero extra calls**.
2. **`TryBriefs` on Home (`src/panel/controller.ts:344`):** Run `models.tryBriefs.update(...)` whenever Home or Project is shown (newest 12 `try` slices, hash-cached on disk). On `Detail = task` rows, display the newest member's localized `firstSentence(brief)` under/beside the task header.
3. **`WaitingBriefs` (`src/collectors/waiting-briefs.ts`, new ~110 LOC sharing `SmallModel`):** Hash-cached translation (`display/model-cache/waiting-briefs.json`) for ≤8 active `Waiting for the owner` bullets and open `qa/qN.md` worker questions when `wrongLanguage()` is true (plus optional 1-call batch translation of open `.scratch` ticket titles keyed by feature digest).

### 2.5 Which Hand-Maintained States Become Automatic

| State today edited by hand | New source of truth (automatic) | Residual orchestrator action |
|---|---|---|
| **Ticket `Status: claimed` (`工作中`)** | Derived at read time in `ProjectCollector` (both **Home** and **Project** modes) from unsettled HUD jobs + active managed worktrees matching `job.ticket` (`<feature>/<NN>`), `(job.package, NN)`, or `<FEATURE>-<NN>`. Reverts automatically if the job fails/stops. | **None** (pass `package`/`ticket` or `<FEATURE>-<NN>` in `hud_create`). |
| **Ticket `try` / `done` & blocker unblocking** | Derived at read time when matching `<FEATURE>-<NN>` / `<feature>/<NN>` is `try` or `accepted` in `STATE.md`, accepted in `$HUD_HOME/tries.jsonl`, or named in a recent `HEAD` commit subject (`git log -n 64`, cached by resolved `HEAD` SHA—0 spawns when `HEAD` is unchanged). Both `try` and `done` unblock `Blocked by` edges (including `<feature>/<NN>`). | Tick/close via `hud_tickets({op:"update", status:"done"})` only for non-code/dropped items (e.g. `mcp-orch/05`). |
| **`STATE.md` `- working · …` lines** | In-flight slices on Home & Project are synthesized directly from live jobs + managed worktrees + `.scratch` tickets; no need to pre-write `- working · …` before dispatch. | Append `- try · <scope> · <ID> · … (<sha>)` once on integration. |
| **Owner `y` / `n` (`tries.jsonl`) lag** | `TryLog.marks()` overlays `ProjectSnapshot` immediately: `accept` moves slices from `try` → `accepted` in Home/Project counts, bars, ticket completion, and `waitSettled()`; `flag` surfaces `⚑` in `Waiting for you` at once. | Main session still receives `try accepted` / `try flagged` via `hud watch` / MCP `changes` and persists `STATE.md` asynchronously. |
| **`Waiting` answered `Owner YYYY-MM-DD:` logs** | `(waits on …)` resolves against `STATE.md` + `tries.jsonl` + derived ticket states; bullets prefixed `Owner 20\d\d-\d\d-\d\d` (recorded owner decisions) are excluded from pending `?` counts or flagged as settled notes. | Move answered decisions to `decisions-log.md` / slices; never log owner answers as open `Waiting` bullets. |

---

## 3. Per-Change Summary: Effect, Data Source, Refresh Cost & Spec Audit

| # | Change | User-visible effect | Data source | Cost per refresh | Needs `docs/spec.md` change? (exact quote) |
|---|---|---|---|---|---|
| **C1** | **Failed-job supersession & `observed_at` on Home** (`thin-main.ts`, `thin-jobs.ts`, `work-lanes.ts`, `split-home.ts`, `work-visibility.ts`, `home-recommendation.ts`) | Retried, landed or observed failures leave Home immediately (revealable via `a`); retry `◉`/`✓` owns the lane; stale AI failure summaries never persist after board change. | `$HUD_HOME/jobs/*/job.json` (`retry_of`, `repair_of`, `observed_at`), `STATUS.json`, cached `ProjectSnapshot` (`ledger`, `tickets`). | **0 extra syscalls** (reuses existing 200-job signature cache + in-memory map pass <0.1 ms). | **No.** Fits §2.2.3 (`docs/spec.md:182,185`): *"Finished jobs hide after a short time; `a` reveals them in place."* / *"Never hide cards needing the owner."* (Update `docs/reference*.md` only.) |
| **C2** | **Unified `milestone → feature → ticket` rollup & `queued` vs `stalled`** (`project-board.ts`, `project-view.ts`, `split-home.ts`) | `0.2.0` bar includes active feature streams; Home shows `162/184 完成 · 40 功能完结`, 1 row per active feature, and folds `0/N` planned features into 1 line; normal `Blocked by` shows `待前序` (`queued`), never amber `受阻`; cross-feature `primitives/03` unblocks automatically. | `docs/handoff/STATE.md`, `docs/spec.md` §5, `.scratch/*/issues/*.md` (up to 64 features / 512 files, stamp-cached). | **~0 ms steady-state** (`lstat` on `.scratch/<slug>/issues` dir mtimes; file bodies read once on change; 0 subprocesses). | **Yes (1 sentence, §2.2.3 `docs/spec.md:190`):** Quote: *"Spare rows: compact board and open tickets; cards win."* → Change *"open tickets"* to *"compact milestone and ticket rollup (active features and folded planned count, or open tickets at slice detail)"*. |
| **C3** | **Read-time ticket/slice automation + immediate `tries.jsonl` overlay + `hud_tickets` fixes** (`project-board.ts`, `try-records.ts`, `local-tickets.ts`, `tool-definitions.ts`) | Tickets flip to `工作中` on job start and `◇ 待试用` / `✓ 完成` on commit/ledger/`y` without hand-editing markdown; pressing `y` updates counts, bars and `(waits on …)` on the next frame; `hud_tickets` accepts `done`/`claimed` and `<feature>/<NN>` blockers; `hud_create` accepts optional `ticket`/`slice`. | `$HUD_HOME/jobs/` (newest 64, stamp-cached), `$HUD_HOME/tries.jsonl`, `.git/HEAD` + ref stat → `git log -n 64` only when `HEAD` SHA changes. | **~0.2 ms steady-state** (2 `lstat` calls on `.git/HEAD` + branch ref; `git log` runs **0 times** unless `HEAD` moved; job cache already in memory). | **Yes (2 minor edits):** 1) §2.1.7 (`docs/spec.md:141-143`): *"add: feature slug and drafted tickets (title, blocked-by numbers, deliverables, acceptance items) … reject unknown blocker numbers."* → allow `<feature>/<NN>` refs and `done`/`claimed` in `update`. 2) §2.2.4 (`docs/spec.md:202-203,213`): note that display derives ticket `working`/`try`/`done` from jobs, commits and `STATE`/`tries.jsonl` without writing project files. |
| **C4a** | **Zero-call language & ID hygiene + `TryBriefs` on Home** (`thin-jobs.ts`, `job-sentences.ts`, `split-home.ts`, `controller.ts`) | `"Slice ASYNC…"` becomes `ASYNC-WATCH-02 · <中文短名>`; `-02`/`-03` never collide; landed `待试用` tasks on Home get Chinese `TryBrief` summaries without visiting `Project` first. | `brief.md` head, existing `display/model-cache/job-sentences.json` & `try-briefs.json`. | **0 extra CPU/IO per tick**; `TryBriefs` makes 1 cached LLM call per new `try` slice (already budgeted under `60/hr` cap). | **Clarification only (§2.2.8 `docs/spec.md:292`):** *"Small external model: thin-card third line (one sentence on current work)..."* → *"thin-card short name and third line..."* (`TryBriefs` on Home needs **no** spec change; `docs/spec.md:221` does not restrict it to the Project tab). |
| **C4b** | **`WaitingBriefs` localization for wrong-language `Waiting` bullets & live `hud_ask` questions (+ optional open-ticket title batch)** (`waiting-briefs.ts`, `home-view.ts`, `project-view.ts`) | `等你处理` bullets from `STATE.md`, live `hud_ask` question slabs, and (if enabled) open ticket titles appear in Chinese when `language = zh` and `Model text` is on, with `▸ 原文` folded below; 0 calls when already in panel language. | `STATE.md` `## Waiting for the owner` (≤8 bullets, ≤2 KiB each), `jobs/<id>/qa/qN.md` (≤4 KiB), optional open ticket titles (≤25 lines, 1 batch call). | **0 ms steady-state** (renders from `waiting-briefs.json` memory map; 1 LLM call only when a new wrong-language item appears). | **Yes (§2.2.4 `docs/spec.md:221` & §2.2.8 `docs/spec.md:283`):** Quote 1: *"Only to-try briefs use a board model: a short brief explaining what changed in plain words, and steps for trying it, from the ledger line, ticket and commits."* Quote 2: *"Read only job files; write only display text."* → Permit display-language translation of wrong-language `STATE` waiting items and open `qa/qN.md` questions (and optional open ticket titles), keeping original text folded. |

---

## 4. Alternative Considered: Single-Ledger Collapse (Retire `STATE.md ## Slices` into `.scratch/`)

Instead of joining `STATE.md ## Slices` and `.scratch/<feature>/issues/*.md` at read time, **retire `## Slices` from `STATE.md` altogether**:
- `STATE.md` shrinks to ~25 lines (`Milestone:`, `## Waiting for the owner`, `## Next`).
- Every unit of work—including a 1-slice bug fix—lives as a `.scratch/<feature>/issues/NN-<slug>.md` file (with a new `**Commit:**` / `**Trial:** try | accepted` header written via extended `hud_tickets` ops `land` and `accept`).
- Home and Project read **one** tracker (`.scratch/`) for all progress bars, `待试用` queues, and history feeds (rendered as Frame `4a` in [`sample.html`](./sample.html)).

**Why we do NOT recommend this alternative now:**
1. **Reverses an explicit owner workflow rule (`docs/delegation.md:20-22`):** *"Several small features one implementer can finish in one session are one slice with one brief and its acceptance list, no tickets (owner, 2026-11-12: '没有拆的必要'). STATE.md's `## Slices` ledger keeps one line per work package either way."* Forcing file creation in `.scratch/` for every small fix adds tool ceremony on the hot path.
2. **Large spec & code blast radius:** Rewrites `docs/spec.md` §2.1.7 and §2.2.4 (*"one stacked bar and legend from `## Slices`"*), migrates 200+ historical slice entries, and rewires `TryLog`, `TryBriefs`, `html-board.ts`, and all three Project layouts (`Timeline`, `Board`, `Inbox`).
3. **Same UX achieved cheaper by the Recommended Design:** Read-time derivation over `<FEATURE>-<NN>` + `HEAD` commits + `tries.jsonl` eliminates manual double-maintenance while keeping 1-slice work weightless.

---

## 5. Vertical Implementation Slices (One Implementer Each)

| Slice | What it delivers end to end | Primary files | Spec change? | Size budget |
|---|---|---|---|---|
| **1. `HOME-SUPERSEDE`** *(Blocked by: none)* | Persist `retry_of` in `job.json` and stamp `source.observed_at` on retry; compute `superseded` & `failureObserved` in `readThinJobs` (from `retry_of`/`repair_of`/`from_jobs`, newer same-target job, or landed slice/ticket); hide superseded failures from default Home, `laneTop`, `orderedLanes`, `hud_read({})`, and `HomeRecommendation.workers()` (revealable muted via `a`); drop stale `lastSuccessfulBrief` when `briefKey` changes; cap unobserved failure protection to 30m. | `src/mcp/thin-main.ts`, `src/collectors/thin-jobs.ts`, `src/render/work-lanes.ts`, `src/render/split-home.ts`, `src/render/work-visibility.ts`, `src/collectors/home-recommendation.ts`, `docs/reference*.md` | None | ~160 LOC, 5 tests |
| **2. `ROLLUP-TRUTH`** *(Blocked by: none; parallel with 1)* | Join active jobs & `spec.md` ladder in Home collector mode; count all `.scratch/` features (≤64 dirs, cached) for exact `done/total`; roll active feature tags into `Milestone:`; resolve cross-feature `Blocked by: <feature>/<NN>`; split `queued` (`待前序`) from real `stalled` (`受阻`); derive ticket `working`/`try`/`done` from live jobs, `STATE.md`, `HEAD` commit subjects (cached by `HEAD` SHA), and `$HUD_HOME/tries.jsonl` immediate count/bar/`waitSettled` overlay; allow `done`/`claimed` & `<feature>/<NN>` in `hud_tickets` and optional `ticket`/`slice` in `hud_create`. | `src/collectors/project-board.ts`, `src/collectors/try-records.ts`, `src/mcp/local-tickets.ts`, `src/roles/tool-definitions.ts`, `src/panel/controller.ts` | §2.1.7 (`141-143`), §2.2.4 (`202-203`) | ~240 LOC, 6 tests |
| **3. `HOME-ROLLUP-UI`** *(Blocked by: 1, 2)* | Redesign `homeProgressRows`, `split-home.ts` (`Progress` & `Waiting` rows/previews), and `Project → Tickets`: `0.2.0 · N 待试用 · M 工作中` on Home row; unified milestone bar + 4-state legend + `工单 done/total · K 功能完结` meter + 1-row active features + folded `▸ 已规划` queue on Home; separate `可开工` / `待前序` (folded) / `受阻` lanes on `Tickets`; EN/ZH strings + golden frame updates. | `src/render/project-view.ts`, `src/render/split-home.ts`, `src/render/workboard-i18n.ts`, `src/render/split-i18n.ts`, `docs/reference*.md` | §2.2.3 (`190`) | ~220 LOC, 5 tests |
| **4. `PANEL-LOCALE`** *(Blocked by: 3)* | Strip `"Slice "`/`"Ticket "` prefixes and middle-preserve `-02`/`-03` suffixes; pair `<ID> · <localized name>` from `JobSentences` (including summary-translation calls, 0 extra calls); run `TryBriefs.update()` while Home is open and show 1-line localized brief on `Detail = task` rows; add cached `WaitingBriefs` (`waiting-briefs.json`) for wrong-language `STATE` waiting bullets & open `qa/qN.md` questions (plus optional 1-call open-ticket title batch) with `▸ 原文` fold; update convention so orchestrator writes `Waiting` in owner's language. | `src/collectors/job-sentences.ts`, `src/collectors/waiting-briefs.ts`, `src/panel/controller.ts`, `src/panel/model-services.ts`, `src/render/home-view.ts`, `src/render/project-view.ts`, `docs/ARCHITECTURE.md`, `docs/reference*.md` | §2.2.4 (`221`), §2.2.8 (`283, 292`) | ~230 LOC, 5 tests |

---

## 6. Open Questions for the Owner

1. **Dual-source rollup (Recommended) vs. Single-ledger collapse (Alternative §4):** Keep `STATE.md ## Slices` for 1-slice work and auto-join `.scratch/` features at read time (Recommended), or retire `STATE.md ## Slices` and track every slice in `.scratch/` via `hud_tickets` (Frame `4a` in `sample.html`)?
2. **Scope of `SmallModel` translation (`docs/spec.md` §2.2.4 & §2.2.8):** Approve extending display-model translation beyond `TryBriefs` and job files to **(a)** wrong-language `STATE.md` `Waiting for the owner` bullets + live `qa/qN.md` worker questions (`WaitingBriefs`, with `▸ 原文` fold), and **(b)** a 1-call cached batch for open `.scratch/` ticket titles when `Detail = slice` / `Tickets` is viewed in `zh`?
3. **Auto-completing tickets in display vs. on disk:** When a slice lands (`try`) or is accepted (`accepted` / `y` in `tries.jsonl`), is **read-time display derivation** enough (zero repo-file writes by HUD; `hud_tickets` still available when closing non-code tickets), or should `hud_tickets` also gain an explicit `op: "land"` helper for the orchestrator at merge time?
4. **Recommended mode's AI progress paragraph on Home:** Once the factual rollup block (`0.2.0` bar + `162/184` ticket meter + active features + folded planned count) is in place, keep the 1–2 sentence AI `homeBrief` above it (strictly invalidated on `briefKey` change), or drop `homeBrief` so `Recommended` only ranks/folds cards?
5. **Unobserved un-superseded failure timeout on Home:** Is **30 minutes** (matching Default mode, then moving into `a` `全部` while `hud_read({})` still flags it to the orchestrator) the right ceiling on Home, instead of today's 24 hours in `Recommended` mode?
