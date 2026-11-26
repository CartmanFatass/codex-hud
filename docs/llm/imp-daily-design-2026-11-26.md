# Per-model daily imp performance: design (2026-11-26)

Source: oracle job j4a570e7da6899cf2 with two code scouts; condensed by the main session. Owner decisions: daily
buckets (top models change fast), shown in toktrack only, no automatic toktrack→HUD alert, quality from automatic
signals only. Tickets: MyHUD `imp-daily-facts/01-02`, toktrack `imp-daily/01-03` (absorbs `workflow-diag/07`).

## Metrics (per imp model per day)

Cohort key `(role, model, effort)`; a job counts on its original creation date, with repairs, retries and child sonics
folded into that day.

| Lane | Meaning |
|---|---|
| First pass | land gate passed without an own-code repair |
| Lead accept | round-0 queue acceptance with no pre-land rejection and no repair ticket naming the slice |
| Findings/slice | milestone review blocker+major per reviewed slice, split across slices by added lines |
| All-in $/slice | own + repair + retry + child sonic cost per landed slice |
| Wall time | median task wall time |

- `n == 0` is a gap; `1 <= n < 5` is dimmed/hollow; the daily `n` strip is always shown. No rolling smoothing.
- 14-day durability (`fix_hit`) stays in the cohort table and drill-down (its window leaves recent days pending).
- Change points drawn as vertical marks across all lanes: `P` preset switch (quota failovers excluded), `M` served
  model id/snapshot change, `H` harness or thinking change.

Dropped on purpose: "acceptance items ticked but unmet" (workers never tick; `hud_land` ticks mechanically),
assumption counts (would punish honesty; rejected assumptions already lower lead accept), owner try records (rare,
late).

## What HUD must record (automatic, no manual step)

- Already recorded: job lineage and timestamps, role/model/thinking/harness, preset and `even` placement and
  failover flags, metered cost via sessions, land outcome and repairs, reviewer `findings` + `reviewed` range
  (archived).
- New (MyHUD `imp-daily-facts/01`): the provider's served model id(s) in `usage.json` at settlement, and the land
  commit span (`base_sha`, `source_sha`), both projected onto `archive/YYYY-MM.jsonl`.
- New (MyHUD `imp-daily-facts/02`): terminal `flows/q*.json` are deleted after a day with no archive, which would
  erase lead acceptance and review history. Before unlinking, append one prose-free `kind: "ticket_queue"` line to
  `$HUD_HOME/events/YYYY-MM.jsonl` (fenced with a `.archived` marker). Repair tickets gain `repairs: ["<feature>/<NN>"]`
  so a repair is attributed to the slice it fixes; reviews record a resolved `{base, head}`.

toktrack backfills now: tasks, wall time, first pass, even pairing and `P`/`H` from the archive; cost and historical
`M` from its own file cache (raw model ids incl. date suffixes); findings from archived reviewer rows; lead accept
from retained run records, ticket `accepted` fields and legacy Markdown lead comments (unattributable multi-slice
repairs stay unknown).

## Charts (toktrack Models page, one Daily section per role)

1. **Daily small multiples**: shared date axis, daily `n` strip, the five lanes above for up to three cohorts (the
   active even pair plus the selected row), `P/M/H` marks cutting through every lane with a one-line key. Answers "is
   model X getting worse?", "what changed when the served model changed?" and "cost per landed slice per day".
2. **Matched even days**: only days where both even-pool presets ran at least 5 round-robin jobs; per-day values on
   7d, matched-day delta and win ticks on 30d. Answers "neon vs sol on the same days" without mixing in solo or
   override days.

Both keep the Value frontier visible at 120x40 and 200x55 when the drill-down is closed.
