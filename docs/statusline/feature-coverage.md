# Statusline feature coverage

## The statusline now: one line in the shared bar grammar (BAR-UNIFY, BAR-UNIFY-2)

With the `statusline` section in `$HUD_HOME/config.json` the statusline draws **one line**, at every width, built by the
same function as pi's footer and the Codex bar (`src/render/layout/bar-fields.ts`; see `docs/reference.md`, The bottom
bars). The parity collectors below still gather the facts; the 0.8.0 multi-line layout (its header, usage, skills,
agent and todo rows) is replaced by:

| Field, in order | Claude facts |
| --- | --- |
| model | stdin `model.display_name` / `model.id`, `effort` (or the transcript's ultracode/`/effort`); provider mark from the model id and environment |
| context | stdin `context_window.used_percentage` and size, with the bounded context cache and the compact-boundary guard; the window is Claude's `autoCompactWindow` (the model's, else the top-level one, from `settings.json` in `$CLAUDE_CONFIG_DIR` or `~/.claude`, read only, unless `autoCompactEnabled` is `false`, and only when below `context_window_size`) |
| project | stdin `cwd` basename and the local Git branch with dirty marker and ahead/behind (`statusline-parity/git.ts`) |
| quota (off by default) | stdin `rate_limits`: the tightest window and its reset; no OAuth or usage call |
| notice zone | events only, each for three minutes, one per subject: a subagent started/finished/failed (transcript Task/Agent calls and results), a HUD job started/finished/failed, a skill loaded (the time of its latest transcript `Skill` call; conversation records only, never a request echo); what needs the owner is pinned while open. Two items at once where there is room. Empty when idle |
| loaded | `MCP n` (settings and `.mcp.json`, from the MCP count while `showConfigCounts` is on) and `skills n` (transcript Skill calls) |

Gone from the line: tasks/todos, tool activity, turn-done notices, CLAUDE.md, rules and hook counts (no longer
collected), the usage bar's multi-line form, the turn clock and session duration, and the separate `Work:` row (job counts are events of the notice zone now). Two keys
choose the look: `barStyle` (`line` or `p10k`) and `barFields` (which fields show); both are read by the statusline
process from `hud-settings.json`. The old table below is the 0.8.0 reference the collectors were checked against.

## Historical: owner-config parity with claude-hud 0.8.0 (STATUSLINE-PARITY)

An explicit `$HUD_HOME/config.json` **statusline** section opts into the owner's compact
layout; without that section the original compact output remains byte-identical (B02).
The installed 0.8.0 build and its `v0.8.0` source were the reference, not current upstream.
Eight synthetic installed-build goldens are under `tests/fixtures/claude-hud-parity/`;
B16 owns their exact ANSI-stripped comparison. No real session or credentials enter them.

| Line / segment, in display order | Reference source | HUD implementation |
| --- | --- | --- |
| Header: `[model effort]`, automatic provider suffix | stdin `model.display_name` / `model.id`, string or object `effort`; transcript ultracode attachment or `/effort` command; provider environment/model ID | `statusline-parity/render.ts`, terminal-safe labels; same cyan model role |
| Header: context bar and percent; high-context input/cache breakdown | stdin `context_window.used_percentage`; current request tokens + autocompact buffer fallback; session context cache | Green <70, yellow 70–84, red ≥85; compact token units; bounded HUD context cache with compact-boundary guard |
| Header: project basename | stdin `cwd` | Sanitized path basename, including Windows separators |
| Header: `git:(branch* ↑N ↓N)` | local Git HEAD, index/worktree and upstream | `statusline-parity/git.ts`; HEAD/index/ref/config invalidation, 2-second dirty-worktree TTL, 120 ms total command allowance; no lazy fetch/transports, repository fsmonitor/filter commands or hooks; trusted global/system filters preserved. Owner-approved 0.15 safety exception: submodule worktree-only changes are ignored (`--ignore-submodules=dirty`), unlike 0.8.0 |
| Header: positive `N CLAUDE.md`, `N rules`, `N MCPs`, `N hooks` | User/project CLAUDE.md and CLAUDE.local.md; recursive rules; settings.json/settings.local.json; user `.claude.json` (redirected config-dir sibling `.json`); project `.mcp.json`; disabled MCP lists | Cached upstream scope and deduplication rules, hook event-key counts, recursive/cycle-safe linked rules; bounded config reads |
| Header: Usage bar; optional Weekly ≥80%; model-scoped windows; reset countdown or limit warning | stdin `rate_limits` only | Same thresholds, labels, symbols and blue/magenta/red quota roles; **no OAuth or usage call** (upstream removed polling in 0.0.12) |
| Header: `⏱️  duration` | First timestamped transcript entry plus wall clock | Persistent incremental transcript state; same minute/hour format |
| Activity: `✓ Skills (N): name, …, +N more` | Transcript Skill calls, unique names in invocation order | First four names plus remaining count |
| Activity: up to three `◐ type [model]: description (elapsed)` / recent `✓` agents | Transcript Task/Agent calls, results/resolvedModel and queued background completion notices | Running first, last-ten-agent reference history, up to two completed entries retained 60 seconds |
| Activity: `▸ current todo (done/total)` / `✓ All todos complete (N/N)` | Transcript TodoWrite / TaskCreate / TaskUpdate | Incremental task IDs, latest snapshots, updates and duplicate-content identity |
| Known minor follow-up: over-limit agent/todo labels | 0.8.0 truncates with `...` | Current pre-width truncation uses `…`, preserving two extra characters; review-1 accepted this as a minor follow-up, not exact text parity for those long-label cases |
| Width wrapper | Raw terminal columns −4; raw fallback 120 | `widthMargin` (default 4), valid COLUMNS/TTY/fallback; effective fallback **116**; explicit `--width` is already effective width |
| tee wrapper | Exact stdin → absolute toktrack executable, `quota record-claude` | Optional explicit `forward` argv; detached process-group worker, bounded 64 KiB delivery and 1.5-second lifetime, discarded output; never awaited by the renderer |
| HUD extra lines | Not in claude-hud | Existing delegation summary, native-calls and Work lines remain after parity lines; intentionally additive, not combined with native agent/todo counts |

Tools, MCP activity, cost, speed, auth/account, prompt-cache, session-name/version, memory,
session tokens, date/last-response, advisor and compactions are disabled under the owner
configuration; expanded-only added dirs/git-file rows are not emitted by 0.8.0 compact.
These are not silently claimed as ported features. Unsupported **non-default** import
values are refused with their key; explicit upstream defaults outside the subset are
reported. In particular tools and file-stat opt-ins are not supported.

### Explicit import and activation

```sh
hud statusline import --from /absolute/claude-hud/config.json
# Optional wrapper migration, never shell evaluation or automatic discovery:
hud statusline import --from /absolute/claude-hud/config.json --settings /absolute/claude/settings.json
# Inspect the preview, then repeat the selected command with --apply.
```

Only the HUD `statusline` section is replaced; other HUD configuration is retained. The
optional `--settings` admits only the audited width/newest-plugin/tee grammar, replaces
plugin discovery with the owned renderer, expands the forward executable to an absolute
path, and refuses any additional shell jobs. Without it the preview explicitly reports
that wrapper jobs were not imported. Locally authored `widthMargin` and `forward` are
preserved by subsequent display-only imports. Forward executables must be absolute;
there is no PATH lookup or shell expansion at render time.

The parity inventory draft (`scripts/claude-parity.mjs`) reports supported fields and
wrapper jobs. Activation still requires matching imported display settings and exact
wrapper argv/margin; unknown fields or wrapper work remain blocked. `settings preview`
(and `hud setup preview`) accept `--shim-dir ABS`, defaulting to `HOME/.local/bin`. The
plan writes only the quoted absolute **public** `hud-statusline` shim, with no node
prefix or shell wrapper, so upgrades/rollback follow `current`. Preview reports
`shimExists`; apply refuses a missing/unsafe/non-executable shim. Re-preview after the
shim is published. This public-shim plan is selected by an imported HUD `statusline`
section or an explicit `--shim-dir`. With neither, the pre-parity settings path keeps
its existing Node/entry command form and backup/restore behavior (owner clarification
q8); parity activation never uses that compatibility path.

`--details` explicitly overrides parity's first-line layout (and retains the original
native-detail semantics), not the configured forwarding or effective width. No settings
are read from an installed plugin during ordinary rendering, and no provider/network
collection is added.

### Bounded differences and measurements

A cold/reset transcript reads a 16 KiB head and 1 MiB tail first, then backfills older
blocks newest-to-oldest while processing live appends under one 1 MiB/render allowance.
Absolute byte positions prevent older history from overwriting the newest todos or
reviving completed agents. Partial UTF-8/JSONL is retained; malformed and >256 KiB records
are skipped. Historical skills/agents may be temporarily absent during catch-up; known
facts are shown without inventing missing ones. This bounded initial difference is
intentional and owner-approved. Retained state caps: 200 agents/tasks/skills and 1000
completion tombstones; config files/cache documents ≤1 MiB, rule traversal ≤10000 entries
and 1000 directories. Unsafe/unavailable sources are omitted, not fetched or executed.
All caches live under `$HUD_HOME/display/statusline/`, directories 0700 / files 0600.

The opt-in `tests/perf/statusline-parity.test.ts` measures settings load, actual collectors
and rendering against 20 MiB / 3000 files, with three 100-sample runs, ten warmups and
nearest-rank percentiles. Every sample forces a five-second dirty-worktree refresh. The
30 ms p95 budget is **in-process**, excluding Node startup and the unchanged delegation
readers. With explicit `CLAUDE_HUD_PARITY_REFERENCE=/absolute/0.8.0/dist/index.js`, it also
alternates real product/reference processes (three runs, 30 samples each, five warmups),
measuring spawn-to-exit and requiring HUD p95 ≤ reference p95. No installed reference is
discovered automatically. These synthetic host measurements do not qualify WSL/live UI.

## Historical default/native-detail inventory (without the parity section)

The remainder records the pre-parity scope and its original evidence labels. Statements
such as “transcript_path is never followed” and “not implemented” refer to that scope only.

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

## Panel-scoped role-work summary (R6A-A67)

The product can append a separate `Work:` segment for the exact source-qualified
Claude main-session root. It reads one private, at-most-16-KiB document under
`$HUD_HOME/display/role-summary/<root-sha256>.json`. The panel publishes the same
workboard's P2 work-state projection after collection, not during paint. Only
non-zero needs-you, stalled, awaiting-acceptance and in-progress counts appear;
done is stored but not displayed. Partial coverage is explicitly labelled; an
incomplete snapshot with no workers is unavailable, not an empty total. A failed
or unbound collection clears the producer's own document immediately. This is
separate from, and never summed with, historical/native delegation summaries.

The reader shares the existing 20 ms cooperative allowance with the legacy
summary read. A missing, malformed, symlinked, wrong-root, future, dead-producer or
60-second-old cache is unavailable, never zero, and adds no output bytes. It does
no discovery, process launch or network work. With the panel off nothing starts
a producer; finish removes only the panel's own published document. Pi's A5
segment can call the same reader and pure width-bounded renderer. Synthetic
codec, process/PTY, statusline and cost evidence is recorded by R6A-A67; this does
not qualify live client activation, enabled-feature parity or WSL visuals.

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
