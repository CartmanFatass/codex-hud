Verdict: changes-required

# M3B-REVIEW — milestone review of M3b AI-THIN and the owner's panel changes

Diff: `git diff 4bbb56a1^..b3fdd830` (10 commits, 60 files, +1896 / −10331). Read-only; no tests or builds run.

## Axis 1 — spec

**What the spec asks, and whether it is there.**

- M3b "Where": thin-job card sentence (`src/collectors/job-sentences.ts`, drawn by `renderWorkCard`), decision titles
  ≤ 8 words from question + answer (`src/collectors/decision-titles.ts`), and a finished job's one line (JOB-SENTENCE's
  final sentence, no second line). All three exist and are wired into the live panel (`tree-page.ts:996`,
  `decisionTitles.apply(jobSentences.apply(...))`).
- M3b "keywords": `jobSentenceLine` (`src/render/work-card.ts:70`) colours 1–3 `«…»` spans and strips the marks on
  malformed input; the tests cover both.
- M3b "When": one call per job per 2 minutes shared across languages (`job-sentences.ts:178`), one final sentence per
  settlement with a ≥ 2 min retry after a failed final call (`:188`, `:196`), keyed by a material fingerprint, cached on
  disk; off/no key → the factual line (`renderWorkCard`'s `generated ? [] : [workCardDetail(...)]`).
- M3b "Settings": `SETTING_ROWS` LLM group is exactly `modelEnabled`, `model`, `modelCallsPerHour` (asserted in
  `tests/unit/model-jobs.test.ts`); `modelEnabled` defaults on only when the credential reader finds a key; old keys are
  ignored, not migrated (`mergeValidated` copies validated keys only).
- M3b "Deleted": `src/core/materials/**`, AGY, recap, session title, approval words, change summary, facade job
  progress and `job-progress.ts` are gone; no dangling imports. Native card text (labels, progress, digest, cause) is
  kept, as the spec asks.
- §2.1 `hud_create`: `lens mcp tps ui_ext skills split` + `pi_args` (≤ 128 strings, each ≤ 4096 chars) are accepted only
  for pi roles, appended after `--` without a shell, recorded in `job.json` and returned by `hud_read`, and a repeated
  `request_key` returns the first job unchanged even with different options (`packages/hud-mcp/src/thin-main.ts:531-585`,
  `:358-368`; `src/harness/pi/role-client.ts` mirrors the schema). `split` correctly falls back to the role file.
- §2.2 panel: Home is the summary (question card ≤ 6 rows, one row per decision), Work the whole thing; a lane row ends
  in one glyph per job; a settled thin job is `done`; a running job's verb follows its role (`runningVerb`); the quota
  shows the single tightest window (`bar-fields.ts:227`).

**Scope creep:** none found. Every change maps to a design-intent line; the `+N` elision, `requestLines`, `stemLines`'
`max` and `decisionBlock` are the minimum needed for the requested behaviour.

**Spec-adjacent gap (details in Axis 2, findings 1–2):** the master switch's panel affordance and the `S` view are
documented in `docs/reference.md` (edited in this milestone) but no longer render.

## Axis 2 — simplicity and quality

### 1. blocker — the Pause / Resume models button is never drawn

`src/tree-page.ts:995` (call) + `src/render/control-bar.ts:299`.

`renderMonitor` is no longer given `brief`, and the bar draws the pause/resume models button only when `input.brief` is
set. With model text on, the owner opens the panel and the `ǁ` / `▶` button that `docs/reference.md:383` and the help's
"Buttons, top row" page (`src/render/monitor.ts:622`) both still advertise is simply absent — the only ways left are
`b` and Settings. The whole `brief` render input (`MonitorData.brief`, `briefRuleRow`, `briefRule`, the recap branches of
`briefFields`) is now unreachable, so this looks like an unfinished deletion rather than a decision.

Smallest fix: one line in the `renderMonitor` call — `brief: { paused: !settings.modelEnabled }` — or delete the
control-bar branch plus the two doc/help lines.

### 2. blocker — `S` opens an empty Inspector

`src/render/work-view.ts:37` + `src/render/cards.ts:219,231`.

`boardInspectorRows` answers `boardInspect === 'summary'` with `briefFields(input, width)`, and that is now always `[]`:
no `notes` and no `brief` are passed any more, so only `briefSaid` could contribute and it also keys off `input.brief`.
The owner presses `S` (or `Ctrl+\ S`) and gets a blank body, while `docs/reference.md:269` says "Main-session details in
the Inspector (factual, not a generated summary)" and `:345` says it "receives factual session data".

Smallest fix: render the factual session rows there (the same state/evidence the status card uses), or drop the `S`
binding, the `summary` branch and the two doc lines.

### 3. minor — the help legend is stale for the keys this milestone changed

`src/render/monitor.ts:654-655,668` (and `:622`).

The Legend page still reads "1 Cards 2 Timeline", "3 Changes 4 Inspector" and "Brief: ! needs ◎ goal ▸ now ✓ done
⚑ approve". After ENTER-TOGGLE 1/2 are Home/Work and 3 is inert; after AI-THIN there is no brief. The owner opens help,
presses 3 and nothing happens. Fix: replace those three lines (and the `{pause}/{resume}` button line if finding 1 is
fixed by deletion).

### 4. minor — the expanded question loses the default-option emphasis

`src/render/home-view.ts:47,60` vs `src/render/work-card.ts:93`.

Collapsed Home writes `default: a)` and the regex at `:60` emphasises the letter; `requestLines` writes `default a)`
(space, no colon), so expanding the card with Enter — and the Work tab, which never applies the regex — shows the
default letter plain and with different punctuation. Fix: emit `${t('default')}: ` in `requestLines` and keep one
regex.

### 5. minor — a symlinked `$HUD_HOME`/`$HOME` silently empties the job material

`src/collectors/job-sentences.ts:16,23` (+ `src/collectors/decision-titles.ts:52`).

`read()` refuses any path whose `realpathSync` differs from the path it was given, so if any component of `HUD_HOME`
(or `HOME`) is a symlink every job file reads as empty; the prompt is then `<job>{"goal":""…}</job>` and the model's
content-free sentence replaces the factual card line. `thin-jobs.ts` reads the same files fine (it uses `lstat` +
`O_NOFOLLOW`), so the panel shows the job but describes it wrongly. Fix: resolve the job directory once
(`realpathSync(dir)` at construction) and compare `join(realDir, name)` with the resolved path.

### 6. minor — the 200-record cache evicts the active job's row first

`src/collectors/job-sentences.ts:153` (+ `src/collectors/decision-titles.ts:76`).

Eviction drops the oldest *inserted* key, and `rows.set(key, row)` on an existing key keeps its position, so a
long-running job that was inserted early is evicted before stale rows; its sentence is computed, paid for and then
never shown (it is re-requested on the next tick). Fix: `this.rows.delete(key); this.rows.set(key, row);`, as
`SmallModel.remember` already does.

### 7. minor (speed) — unchanged material is re-read on every collect tick

`src/collectors/job-sentences.ts:178-188`.

Once a running job's 2-minute window has elapsed, the gate passes on every tick; the fingerprint check then skips the
call but `material()` has already re-read `STATUS.json`, `brief.md`, `report.md`, the newest review, the `sessions`
listing and a 32 KB session tail (parsed line by line) — every ~1 s per running thin job, because `row.at` is only
refreshed when a call is submitted. Spec §4 asks the panel to stay at least as fast as what it replaces. Fix: set
`row.at = now` (and `save()`) on the unchanged path, or compare a cheap stamp before reading.

## Optional (does not change the verdict)

- Dead code this milestone left behind: `Brief`/`BriefItem`/`Recap` (`src/collectors/briefing.ts`, `recap.ts` are now
  type-only shells), `briefRuleRow`/`briefRule` (`monitor-panes.ts:489,589`), `recapFields`/`recapIds`/`BRIEF_KEEP`
  (`cards.ts:186,196,237`), `sentenceTargets`/`sentenceWorkers` (`work-view.ts:156`, `monitor.ts:206,277`,
  `work-lanes.ts:119`), `jobInspectorTargets` (`work-visibility.ts:15`), `ProgressSummaryInput.rootRolloutPath`
  (`progress-summary.ts:68`), `MonitorState.labelAsName` hard-coded `true` (`monitor.ts:157,416`), `HudData.sessionTitle`
  (`types.ts:632`), and `src/core/export.ts` (510 lines, no importer left after `src/core/materials` went).
- Dead strings: `workboard-i18n.ts:127-128` ("Display only · Enter opens Work…", "1 Home · 2 Work · 3 Changes…"),
  `i18n.ts:353` ("~ No model backend…"), `t('⏎ read')`.
- `codex-hud --help` still advertises `brief --dry-run [FILE]` as printing the brief; the command now exits 1 with a
  removal notice, and `DryRunOptions` keeps six fields the stub ignores.
- Model-calls page: decision titles are counted under "Session titles" (`render/model-telemetry.ts:13`) and job
  sentences under "Other model features"; labels for approval/recap/brief/changes remain.
- Cards → Summary off hides native model lines but not thin-job sentences; job sentences and decision titles are
  generated while the help overlay or the settings page is open (the old code gated on both).
- Settings → Model has one value, so a hand-edited model ID reverts to `deepseek-v4-1-flash-1017` when the row is
  stepped, although the help says to edit the JSON.
- `laneStrip` can name the role of a job whose glyph was elided into `+N`.
- `3` still opens the Changes pane when the workboard is not drawn (focus on Timeline/Changes).
- A settled thin job now disappears after the 10-minute linger (intended by "结束就是 done"), so a report the owner has
  not read is only reachable with `a`; `doneToday` still counts it.

## Verified

- Read the full diff (`git diff 4bbb56a1^..b3fdd830`), all 10 commit messages, `docs/spec.md` §2/§4/§5 M3b,
  `docs/delegation.md` step 5, and the touched modules plus their tests.
- Traced the live wiring in `src/tree-page.ts`: `configureModel()` → `modelOn` → `SmallModel.configure`,
  `jobSentences.configure`, `decisionTitles.configure`; `collect()` → `decisionTitles.update(...)` then
  `jobSentences.update(...)`; `render()` → `decisionTitles.apply(jobSentences.apply(workboard))`. `visibleDecisions` is
  built from the previous frame's pane rows and the workboard pane always sets `visible: room`, so the "visible first"
  ordering works.
- Checked the new tests execute the real paths: `job-sentences.test.mjs` drives a real `SmallModel` with a `fetch` that
  records and inspects the prompt (asserts the activity text, the report text, the zh system prompt, and that
  `PRIVATE-REASONING` never leaves); `thin-panel-jobs.test.mjs` renders real frames and drives the real
  `WorkbenchInputDecoder` + `handleMonitorInput` for Enter/1/2/3/arrows; `thin-mcp.test.mjs` runs the real MCP server
  against a fake `pi-role`/`herdr` and asserts the actual argv, `job.json` and `hud_read`; `model-jobs.test.ts` asserts
  the LLM settings rows and the native card text. No fake ignores its input.
- Confirmed `git status --short` shows only `node_modules/.package-lock.json` (not staged by me; I made no changes).
- No tests or builds were run, per the brief ("no builds and no test runs"); the implementer's reported 29 unit + 48 mjs
  at b3fdd830 is taken as given — there is no log in the checkout to verify it against.

Delivered as `/home/fires/.hud/jobs/j0cd9b0ae55fd397e/report.md`; 2 blockers, 5 minor, plus the optional list.
