# Statusline feature coverage

This is a source-level inventory against repository base
`95dac1bdd40583f6015ed686d4be4feef79cf916`, not a comparison with anyone's installed
`claude-hud` configuration. No real settings were inspected. The official source is
[Claude Code statusline documentation](https://code.claude.com/docs/en/statusline),
accessed 2026-11-06: an **unversioned documentation snapshot**, not a tested Claude
client version. Its example `version: "2.1.90"` is not a compatibility pin.

## Shipped rendering

| Feature | Current behavior | Evidence / observation scope |
| --- | --- | --- |
| Model | `model.display_name`, then `model.id`, then `Claude`; terminal-safe text | `src/render/statusline-session.ts`; observer normal and sparse controls |
| Context occupancy | Only native `context_window.used_percentage`, rounded to integer percent; zero retained | No token-to-context guesses and no context bar; zero control |
| Cost | `cost.total_cost_usd`, estimated session USD, not an invoice | Normal/zero controls; no currency/account lookup |
| Width | 1–500 terminal cells; explicit `--width`, valid `COLUMNS`, TTY columns, then 80 | Cost then context omitted before model truncation; observer covers width 10 and 80; detailed tests cover precedence/CJK |
| Input | One UTF-8 JSON object, at most 64 KiB, one-second input guard; unknown fields tolerated | `src/statusline-preview.ts`; malformed, sparse and zero/unknown controls; guard is not a latency promise |
| Stdin priority | Supplied model/context/cost remain the first line when summary exists | Actual `bin/hud-statusline` fresh-summary observation |

## Shipped conditional or partial capability

| Feature | Conditions and limitations | Exercised by this observer? |
| --- | --- | --- |
| Committed summary | Explicit source plus exact parent identity, private v1 summary and existing ledger identity; bounded direct children, always `partial`, no full-tree totals | Fresh and expired synthetic summary; regenerated before each sample |
| Missing summary / fallback | Explicit registered source and parent may use the existing bounded read-only direct-parent index fallback; absent evidence preserves line one | Empty synthetic ledger fallback only; populated fallback, conflicts, source/thread mismatch, child expiry, budgets and limits remain existing regression-test scope |
| Identity | `session_id` selects identity, not a displayed metric; source must be explicit; `transcript_path` is never followed | Synthetic session/source only. Repository `agent_id` thread selector is repository-specific/assumed, not documented in the current official main `statusLine` field list |
| Settings | Existing Linux `settings preview`, `settings apply --plan`, `settings restore --backup` | **Not run by the observer.** See [settings safety and recovery](product-settings.md); there are no new `--install`/`--restore` flags |

The shared summary reader and fallback have their own
[identity, freshness, privacy and cooperative-budget boundaries](delegation-summary.md).
A fresh display is not lifecycle/control authority. This tool does not time the
internal reader separately or establish its 20 ms qualification.

## Not rendered or not implemented

The official documentation exposes more fields than this first-line renderer uses.
These families are **not rendered**, rather than silently claimed as feature parity:

- Workspace, cwd, repository/worktree and PR metadata.
- Additional context token, cache, remaining and threshold fields.
- Additional cost durations and change counts.
- Effort, thinking and fast-mode indicators.
- Rate limits, spend limits and prompt-cache data.
- `session_name`, `prompt_id`, `version`, `output_style`, Vim mode and agent name.

There is no current tools/todo/git-change/output-speed/session-duration/quota
statusline display, localized statusline labels, toktrack tee or full-tree totals.
Those fields are not inferred from model names or missing input. The current
upstream **`subagentStatusLine` tasks JSON → JSONL interface is separate** from main
`statusLine` stdin JSON and is **not implemented** by this product. Existing partial
HUD delegation output must not be described as native subagent interface parity.

## What remains unqualified

[Finite opt-in synthetic observation](opt-in-observation.md) provides reproducible
process-level evidence only. Local enabled-feature parity, seven historical D4
workloads, 1000-sample qualification, internal reader timing, live Claude, WSL and
Windows Terminal visuals, at least two weeks of observation, and default-switch
readiness are **NOT_RUN** here. D4/D5 are not declared complete and D6 is not enabled.
