# `imp` job cost by model — snapshot 2026-11-22 14:32Z

Rough comparison of `pi`-backed implementer (`imp`) jobs by producing model, over the last 5 days
(`2026-11-17` – `2026-11-22`). Sources: `~/.hud/jobs/*/job.json` + `STATUS.json`, each job's
`sessions/` symlinks, and `~/.hud/archive/2026-11.jsonl` for one deleted job (session matched by
`started_at` against the session's first `model_change`). A job is classified by the model that
produced most of its assistant turns; jobs with no session file are skipped.

## Table

| Model | N | Model time mean | Model time med. | s / turn | out tok/s | `$/job` mean | `$/job` med. | `$/turn` | Turns/job | Cont. / retries | Wall mean | Wall med. |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gpt-6.2-astra` | 18 | **`12.0 min`** | `9.9 min` | `14.4` | `23.3` | **`3.40`** | `2.93` | **`0.068`** | 49.9 | `17%` (3/18) | 16.0 min | 13.1 min |
| `gpt-6.2-sol-fast` | 45 | **`8.0 min`** | `7.5 min` | `10.5` | `45.6` | **`0.91`** | `0.73` | **`0.020`** | 45.6 | `13%` (6/45) | 11.6 min | 10.8 min |
| `gpt-6.2-sol` | 15 | **`12.1 min`** | `12.1 min` | `13.4` | `30.5` | **`1.12`** | `1.06` | **`0.021`** | 54.1 | `13%` (2/15) | 17.2 min | 16.4 min |

**Model time** = pure response latency: for every assistant message, the gap from the preceding
`user` / `toolResult` entry timestamp to the assistant entry timestamp, summed over all assistant
turns of all session files of the job (no negative or >1 h gaps occurred). **out tok/s** =
`usage.output` tokens ÷ model time. **Wall** (`created_at` → `report.md` mtime, else `STATUS.ended_at`)
is kept as a secondary column: it also contains tool execution, queue/gate waits, post-report time and
today's parallel test load — model time is `69%` (sol-fast), `70%` (sol) and `75%` (astra) of it.
**Cost** = sum of `usage.cost.total`. **Cont. / retries** covers `repair_of` / `from_jobs` /
`parent_job`, more than one session file, or assistant turns after the `hud_report` call — the
`retry_of` / `continued_as` fields named in the brief do not occur in current `job.json` files.

## Caveats

- **Uneven samples and wide spread:** astra `18`, sol-fast `45`, sol `15`. Astra per-job cost ranges
  `$0.75` – `$7.78` and model time `4.0` – `24.6 min`, so its medians (`2.93`, `9.9 min`) sit below
  its means (`3.40`, `12.0 min`).
- **Astra jobs were harder slices:** they carry the larger HOME-PROGRESS-03/04, FLOWS-01,
  IMP-LEAN-01…06, ORCH-LEAN-02/03 and DOGFOOD-FIXES-03 briefs, while sol-fast runs are mostly small
  single-package slices — the `3.7×` mean / `4.0×` median cost gap mixes unit price and work done.
- **Prices are list rates from `~/.pi/agent/models.json`, not invoices:** every observed turn has
  `cost.totalFromProvider: false`, i.e. cost is computed locally. `models.json` lists astra at
  `$8 / $0.40 / $40` per MTok (`4×` sol) and `sol-fast` at exactly sol's rates (`$2 / $0.10 / $10`);
  no speed-tier multiplier is visible. Sol-fast's lower `$/job` therefore tracks fewer turns of work,
  while its model-time advantage is throughput: `10.5 s`/turn carrying `480` output tokens/turn
  against `13.4 s`/turn at `409` tokens (sol) and `14.4 s`/turn at `337` tokens (astra).
- **The cohorts are also separated in time:** all sol jobs are from `2026-11-21`, all astra jobs from
  `2026-11-22` afternoon (after the model switch), sol-fast from both days — so harness state, role
  prompts and load conditions differ between cohorts as well as the model.
