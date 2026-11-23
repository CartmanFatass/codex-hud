---
name: trace-review
description: Review HUD workflow session records or transcripts, analyze orchestrator or worker sessions, run a trace review, or find workflow optimizations from transcripts. Use for these requests in English or Chinese. This skill is specific to MyHUD.
---

# Trace review

1. Pick one review question and a sample: orchestrator or worker, harness, date range, and which sessions or jobs to include. Match role and workload when comparing samples. Use [the worker guide](worker-guide.md) for source locations and coverage.
2. From the project root, run `node .claude/skills/trace-review/extract.mjs <harness> <paths...> [--job <id>] --out tmp/tasks/<WP>` once per harness. It prints the run directory. Inspect the sanitized `metrics.json` before dispatch; never attach raw records or quotes.
3. Use `hud_create` to dispatch one local worker (`oracle` for an open question, `general` or `imp` for a fixed survey). In the brief give the question, sample bounds, and comparison method; set `context_files` to `.claude/skills/trace-review/worker-guide.md` and the run's `metrics.json` (one per harness if comparing). The worker writes the report; collect it with `hud_read({job})` when notified.
4. Record the sample definition, coverage, and baseline numbers in `tmp/tasks/<WP>/` so a later run can repeat the comparison. Use `hud_tickets` to turn supported findings into tickets. Name the layer that can change each metric (harness, HUD, model, or mod), the measured baseline, and the target; keep unresolved attribution explicit. Put only approved, sanitized aggregates and synthetic examples in tickets or committed docs.
