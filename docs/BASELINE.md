# Baseline: what the HUD did before the layout work

Recorded from `9a1bb93` against the fixed fixture in `tests/fixtures/hud-data.ts`,
so the same command reproduces it at any time:

```bash
npm run build:test
node --test "dist-test/tests/unit/*.test.js"
```

## Status bar, by pane width

The bar is built by concatenating every field and clipping the result to the
pane width, so fields disappear by position rather than by importance.

```
 60  ☀● | Tokens: 84.0K (cache 71%) | Ctx ████░░░░░░ 42% (114.2K…
 80  ☀● | Tokens: 84.0K (cache 71%) | Ctx ████░░░░░░ 42% (114.2K/272.0K) | Plan ████…
100  ☀● | Tokens: 84.0K (cache 71%) | Ctx ████░░░░░░ 42% (114.2K/272.0K) | Plan ██████░░░░ 61% 5h · 23% …
120  ☀● | Tokens: 84.0K (cache 71%) | Ctx ████░░░░░░ 42% (114.2K/272.0K) | Plan ██████░░░░ 61% 5h · 23% 7d | ⏱️ 4653h29m | co…
160  ☀● | Tokens: 84.0K (cache 71%) | Ctx ████░░░░░░ 42% (114.2K/272.0K) | Plan ██████░░░░ 61% 5h · 23% 7d | ⏱️ 4653h29m | codex-hud git:(main * ↑2) | mode: dev · Ap…
```

What this costs the reader:

- Which project and branch the session belongs to is the first thing lost, at
  every width under 120 columns.
- `Plan` is the rate-limit window, not task progress. The task progress the
  parser already collects is not displayed anywhere.
- Nothing signals that a tool failed or that an agent needs attention, so no
  alert can survive the clip either.

## Subagent panel

- Fixed width between 20 and 24 columns (`bin/codex-hud-toggle`).
- Header reads `N run · N done`, where `done` is completed plus failed.
- Keys: up, down, close. No selection, collapse, filter, or detail.
- Agents known only through a parent link are reported as `running`.

## Render cost

Measured by `tests/unit/perf.test.ts` on the fixture at 120 columns:

| Measurement | Value |
|---|---|
| Render, per frame | 0.08 ms |
| Frames measured | 2000 |

The HUD repaints four times a second, so per-frame cost is the number to watch
when adding modules. The test fails above 1 ms.

## Replayable samples

`tests/fixtures/rollouts/` holds the rollout shapes the parser has to survive.
Each one is asserted in `tests/unit/rollout-replay.test.ts`.

| Fixture | What it pins down |
|---|---|
| `basic-session.jsonl` | Model, effort, tool results, plan steps, quota windows |
| `no-rate-limits.jsonl` | Missing quota stays missing instead of reading as zero |
| `truncated-line.jsonl` | A half-written last line does not discard earlier lines |
| `model-switch.jsonl` | A mid-session model change reports the latest model |
| `subagent-lifecycle.jsonl` | A failed agent is not counted as finished work |
| `compaction.jsonl` | Compaction count and timestamp |
| `small-context.jsonl` | An 8K window does not report as full |

The last one was a live bug: `docs/issues/issue-007` was marked fixed in
January with verification skipped, and the fix reserved the entire window on
small models, pinning the display at 100%. The replay test caught it.

---

# After the layout work

Same fixture, same clock. The bar is assembled from modules that each carry a
priority, a group, and shorter forms of themselves, and the fixture includes
one failed tool and one failed agent so the alert has something to report.
These lines are printed rather than written by hand:

```bash
npm run build:test
node dist-test/tests/fixtures/samples.js 60 80 100 120 160
```

```
 60  !2 │ ☀  main* │ 1▸1✗  Ctx 42% │ 2/5  Q61%           30m  F12
 80  ! 1 tool failed │ ☀  main* │ 1▸1✗  Ctx 42% │ 2/5  Q61%                  30m  F12
100  ! 1 tool failed · 1 agent failed │ ☀  main* │ 1▸1✗  Ctx ██▌░░░ 42% │ 2/5  Q61%              30m  F12
120  ! 1 tool failed · 1 agent failed │ ☀● Astra  main* │ 1▸1✗  Ctx ████▎░░░░░ 42% (114.2K/272K) │ 2/5  Q61%         30m  F12
160  ! 1 tool failed · 1 agent failed │ ☀● Astra  codex-hud git:(main * ↑2) │ Agents 1 run · 1 ok · 1 fail  Ctx ████▎░░░░░ 42% (114.2K/272K) │ 2/5  Q61%     30m  F12
```

What changed for the reader:

- The project and branch survive down to 40 columns, as the branch alone.
- The alert is pinned, so it is the last thing standing rather than the first
  thing clipped. `tests/unit/bar-layout.test.ts` asserts this at every width
  from 6 columns up.
- `Plan` is gone. The rate-limit window is `Quota`, task progress is `Tasks`,
  and they use opposite meter colours: a full quota is a warning, a full task
  list is a success.
- Fields with no data are absent rather than zero. A session with no quota
  snapshot shows no quota field.
- Related fields sit two spaces apart and unrelated ones are divided by a
  dimmed `│`, so the bar reads as who / load / usage rather than as a list.
- The session timer and the `F12` hint are pushed to the last column, which
  keeps the left edge stable while the middle of the bar changes.
- Meters fill by eighths of a column, so a six-column `Ctx` bar moves eight
  times more often than it used to.

## Render cost, after

| Measurement | Before | Layout work | With grouping and eighth-cell meters |
|---|---|---|---|
| Render, per frame | 0.08 ms | 0.26 ms | 0.33 ms |

Measured by `node --test dist-test/tests/unit/perf.test.js`, which prints the
number it asserts on; repeated runs landed between 0.31 and 0.35 ms. Four times
the original work for one frame, against a budget of 1 ms and a repaint rate of
four frames a second. The cost buys the fitting pass, which renders each
field's variants before choosing between them, and now also measures the
grouped and right-aligned joins.

## Test counts

| Suite | Count |
|---|---|
| Unit (`npm test`) | 63 |
| Integration (`npm run test:integration`) | 12 suites |

---

# Collection cost

Rendering was never the expensive part. The HUD's idle cost was the work
behind each frame: subprocesses, polling stats, and re-reading a file that had
not changed. What follows is what a tick does now.

## Per 1s collection tick

| Work | Before | Now |
|---|---|---|
| `git` subprocesses | 5 every 3s (`rev-parse` ×2, `rev-list`, `status` ×2), synchronous, up to 5s of blocked event loop each | 1 `status --porcelain=v2 --branch`, async, at most once per 10s while the repo is still |
| Rollout parse | every tick, plus once per watcher event | one `stat`; the file is opened only when size, mtime or inode moved |
| Rollout / sessions / snapshot watches | chokidar polling at 1s on three paths | native fs events (polling kept for `win32` only) |
| `tmux display-message` | every 2s, `execFileSync` with a 300ms timeout | once at startup, async, and only when stdout is not a TTY |
| Fallback session scan (no session yet) | 30-day directory walk every 2s, two file reads per rollout | today and yesterday every 2s; the 30-day walk only when those are empty, at most every 30s; each rollout's first line and each shell snapshot read once per path |
| Repaints | 4 per second, always | 1 per second, rising to 4 only while a subagent exchange is live in a pane taller than one row |

Measured against this repository with a shim counting invocations: a 12-second
idle run spawns `git` **once**, where the previous build spawned it twenty
times. The compact pane repaints once a second instead of four times.

## What a reader can notice

The git cache is invalidated by the mtimes of `index`, `HEAD`, the branch ref,
`packed-refs`, `FETCH_HEAD` and the upstream ref, so staging, committing,
checking out, fetching and merging all show up on the next tick. An edit that
only touches the working tree leaves no trace in the git directory, so the
dirty marker and the file counts can lag it by up to the 10s cache bound. That
is the one deliberate trade: it is what removes the steady-state subprocess.

Counts themselves are unchanged. The porcelain v2 reader classifies each entry
exactly as the v1 reader did — a rename counts as a modification, an
unresolved conflict counts as none of the four kinds — and
`tests/unit/git-status.test.ts` pins that with fixtures covering a clean
tracked branch with ahead/behind, a dirty tree with staged, unstaged, renamed,
conflicted and untracked entries, a detached HEAD, and a branch with no
upstream.
