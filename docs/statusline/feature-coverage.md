# Statusline feature coverage

This is a source-level inventory against repository base
`95dac1bdd40583f6015ed686d4be4feef79cf916`, not a comparison with anyone's installed
`claude-hud` configuration. No real settings were inspected. The official source is
[Claude Code statusline documentation](https://code.claude.com/docs/en/statusline),
accessed 2026-11-06: an **unversioned documentation snapshot**, not a tested Claude
client version. Its example `version: "2.1.90"` is not a compatibility pin.

## Compact/default rendering

The historical inventory and observer labels below retain their original scope.
The opt-in native-details source increment is based on
`a1250f07995465b40e29a284a732978894c3e7ee`; it does not change compact/default bytes.
Its new behavioral tests, build and formatting remain **NOT_RUN** at source delivery.

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

## Opt-in native details (source implementation and integration checks)

The table's **NOT_RUN** entries preserve the original independent source-delivery
status. On 2026-11-07, integrated source/test/MCP builds and a focused 184/184
synthetic regression run passed, including the new native-details tests. See
[native-details integration verification](native-details.md#integration-verification-2026-11-07)
for the preserved initial failure, narrow input-stream repair, exact scope and
remaining live/visual/performance exclusions. The integrated product can append
an explicitly scoped `Native calls:` line; `--details` still affects only line one.

`hud statusline --details [--lang en|zh]` and `hud-statusline --details` add the
following native first-line presentation. English is the explicit-mode default;
Chinese labels affect this first line only. No settings or default is changed.
`hud-statusline-preview` remains compact. See [native details](native-details.md)
for exact field types, omissions, labels, argument grammar and width degradation.

| Feature | Opt-in behavior | Evidence / observation scope |
| --- | --- | --- |
| Native context bar | Ten cells from rounded `context_window.used_percentage`; no token inference | New direct-renderer and actual product CLI tests written; **NOT_RUN** |
| Remaining context | Independently supplied `context_window.remaining_percentage`; never `100-used` | Contradictory/remaining-only synthetic cases written; **NOT_RUN** |
| Directory | `workspace.current_dir`, then `cwd`; bounded sanitized display only | No Git, basename, path resolution or identity authority |
| Context/cache counts | Exact safe integers at the admitted `context_window` keys; positive window capacity | No lifetime totals, model-window default or `prompt_cache` substitution |
| Durations and changed lines | Supplied `cost.total_duration_ms`, `total_api_duration_ms`, `total_lines_added` / `total_lines_removed` | No live clock, output speed or Git lookup; known line-change sides only |
| EN/ZH labels and width | Model first; rightmost optional segments removed, then bar/cost/context/model label before identity truncation | Both languages, 1–500 widths in new tests; **NOT_RUN**, no visual qualification |
| Product composition | Original stdin identity still selects unchanged partial summary; second line is not localized | Age-free synthetic ledger composition tests written; **NOT_RUN** |

The renderer is pure. Product commands retain the existing bounded summary reads
outside rendering; they are not globally filesystem-free. All new-mode unknown
or malformed facts omit their segment, and valid zeros remain facts. These source
changes are not retroactively covered by the historical observer results above.

## Not rendered or not implemented

The official documentation exposes more fields than either renderer uses. These
families remain **not rendered**, rather than claimed as feature parity:

- Repository/worktree identity, Git branch/change lookup and PR metadata.
- Context threshold flags, inferred occupancy and derived token totals.
- Effort, thinking and fast-mode indicators.
- Rate limits, spend limits and `prompt_cache` data (distinct from the admitted
  `context_window.current_usage` cache token counts).
- `session_name`, `prompt_id`, `version`, `output_style`, Vim mode and agent name.
- Tools/todos, output speed, quotas, toktrack tee and full-tree totals.

No missing facts are inferred from model names or provider state. The upstream
**`subagentStatusLine` tasks JSON → JSONL interface is separate** from main
`statusLine` stdin JSON and is **not implemented** by this product. Existing partial
HUD delegation output must not be described as native subagent interface parity.

## What remains unqualified

[Finite opt-in synthetic observation](opt-in-observation.md) provides reproducible
process-level evidence only. Local enabled-feature parity, seven historical D4
workloads, 1000-sample qualification, internal reader timing, live Claude, WSL and
Windows Terminal visuals, at least two weeks of observation, and default-switch
readiness are **NOT_RUN** here. D4/D5 are not declared complete and D6 is not enabled.
