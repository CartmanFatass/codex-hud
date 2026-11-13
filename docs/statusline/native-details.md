# Opt-in native statusline details

This independent D3 presentation slice is based on
`a1250f07995465b40e29a284a732978894c3e7ee`. It adds source implementation and
synthetic tests, not D3 completion, live-client qualification or a default switch.
The [official main statusLine documentation](https://code.claude.com/docs/en/statusline#available-data)
was read on 2026-11-06. This is an **unversioned documentation snapshot**, not a
tested client pin. The separate `subagentStatusLine` tasks JSON/JSONL interface is
not implemented here.

## Commands and API

```sh
hud statusline --details [--lang en|zh] [--width COLUMNS] [--source ABSOLUTE_CLAUDE_ROOT]
hud-statusline --details [--lang en|zh] [--width COLUMNS] [--source ABSOLUTE_CLAUDE_ROOT]
```

`--details` is a once-only, valueless switch. `--lang` is once-only, case-sensitive
`en` or `zh`, requires `--details`, and defaults to `en`. Flags can appear in any
order; a valued flag consumes its immediate next token. There are no equals
forms, abbreviations, locale aliases, automatic locale selection or persistent
presentation settings. JSON input cannot select the presentation mode.

Invalid arguments, including duplicates, missing values, unsupported language,
`--lang` without details, extra positionals and mixing new options with `--help`,
return exit 2, empty stdout and exactly `invalid_arguments` on stderr. Validation
precedes stdin consumption. A complete `--width` pair is passed unchanged to the
existing width protocol; another flag cannot be peeled out of its value.

Without either new option, existing argument/source behavior and preview-help
handoff are retained. Sole `--help` describes the new mode. `settings ...` still
routes to the existing explicit settings command first; presentation flags are
not settings options and do not apply or restore settings. This slice does not
install or change an existing statusLine command. `hud-statusline-preview` remains
compact and rejects `--details`.

The additive renderer API is:

```ts
renderStatuslineSession(input, width = 80, options = {})
// options: { details?: boolean; language?: 'en' | 'zh' }
```

Only `details === true` selects the new renderer. Language alone, `{}`, or
`{ details: false }` preserves compact bytes. The pure lower-level function is
`renderStatuslineDetails(input, width, language)`. Invalid API widths throw
`invalid_statusline_width`; CLI width syntax errors keep the existing
`invalid_arguments` diagnostic.

## Admitted facts and absence

Nested containers must be non-null, non-array objects. Numbers are never coerced.
Missing, null or malformed facts omit their segment; explicit valid zero survives.
Model identifiers and directory values are not translated. Labels are:

| Fact | Exact native source | EN / ZH | Acceptance and display |
| --- | --- | --- | --- |
| Model | `model.display_name`, then `model.id`, then `Claude` | model / 模型 | Nonempty sanitized string |
| Context used | `context_window.used_percentage` | ctx / 上下文 | Finite 0–100, rounded integer percent, native bar |
| Session cost | `cost.total_cost_usd` | cost / 费用 | Finite nonnegative USD; tiny positive below .01 uses two significant digits, otherwise two decimal places |
| Directory | `workspace.current_dir`, then `cwd` | cwd / 目录 | Nonempty sanitized display string; no resolution or basename extraction |
| Context remaining | `context_window.remaining_percentage` | left / 剩余 | Independently finite 0–100, rounded integer percent |
| Input tokens | `context_window.total_input_tokens` | in / 输入 | Nonnegative safe integer |
| Output tokens | `context_window.total_output_tokens` | out / 输出 | Nonnegative safe integer |
| Window size | `context_window.context_window_size` | window / 容量 | Positive safe integer; zero capacity is invalid |
| Cache read | `context_window.current_usage.cache_read_input_tokens` | cache read / 缓存读 | Nonnegative safe integer |
| Cache write | `context_window.current_usage.cache_creation_input_tokens` | cache write / 缓存写 | Nonnegative safe integer |
| Session duration | `cost.total_duration_ms` | session / 会话时长 | Nonnegative safe integer followed by ` ms` |
| API duration | `cost.total_api_duration_ms` | api / API时长 | Nonnegative safe integer followed by ` ms` |
| Changed lines | `cost.total_lines_added`, `cost.total_lines_removed` | lines / 改动 | Independently nonnegative safe integers; known sides only |

Token counts use exact base-10 integers followed by ` tokens` or ` 词元`. These are
the supplied context/response/cache counts, not lifetime totals. Duration values
are the supplied milliseconds, not a running clock or speed calculation. Cost is
the client's estimated session USD, not an invoice, balance or quota. Changed
lines may be `lines +156 -23`, `lines +0` or `lines -0`; an absent side never becomes
zero. Negative numeric zero displays as ordinary zero, with the direction sign
retained for line changes.

`current_usage: null` omits both cache facts. Siblings remain independent. NaN,
infinities, boxed values, numeric strings and unsafe/fractional counts are omitted.
Remaining context is never computed as `100-used`, used is never derived from
tokens, and contradictory supplied percentages are not reconciled. There is no
model-based window default, alternate-key lookup, `prompt_cache` substitution,
rate calculation or summation.

All other fields are ignored: effort/thinking/fast mode, quotas and limits, tools,
todos, Git/PR/worktree metadata, titles and provider enrichment are outside this
slice. Directory text is never source/session authority. The existing
repository-specific `agent_id` selector still belongs only to summary identity,
not to the official native fact list.

## Text and width policy

Each segment is `label + space + value`, separated by ` · `. Output is plain text,
without ANSI, padding or terminal state. This pure renderer returns only the
first line; the integrated product command can append the summary and native-call
lines described below. New-mode model/directory
text is bounded to 512 UTF-16 units without a trailing split high surrogate, then
passes through `monitorText` once. U+2028/U+2029 become spaces. U+061C/U+200E/U+200F
are visibly escaped, as are the helper's C0/C1 and directional controls. Empty
sanitized strings are absent. Legacy compact sanitization is unchanged.

For the rounded displayed percentage `p`, the context bar has ten ASCII cells:
`floor(p / 10)` filled `#` cells and the rest `-`. Thus zero is `[----------] 0%`,
42 is `[####------] 42%`, and 100 is `[##########] 100%`. The bar represents the
supplied percentage only; a remaining-only input cannot produce it.

Priority and order are the table order above. While too wide, remove optional
segments from the right through directory. If model/context/cost still do not
fit, remove the bar (retain percent), then cost, then context, then the model
label, then truncate only the sanitized model identity using `truncateAnsi`.
Stop at the first fitting state without backfill or reordering. A long model can
force every other fact off. Every candidate is measured using `visualLength`,
including CJK cells, labels and separators. Widths 1–500 produce a nonempty line
within the width. The repository's existing cell convention is used, not a new
Unicode-width library.

Synthetic examples with model Claude, used 42, cost .12 and no optional facts:

```text
compact: Claude · ctx 42% · $0.12
EN/80:   model Claude · ctx [####------] 42% · cost $0.12
ZH/80:   模型 Claude · 上下文 [####------] 42% · 费用 $0.12
EN/48:   model Claude · ctx [####------] 42% · cost $0.12
EN/32:   model Claude · ctx 42%
EN/10:   Claude
EN/1:    …
```

These are specified expected strings, not captured execution output.

## Existing input and second line

Both product entrypoints still parse exactly one UTF-8 JSON object, with the
existing 64 KiB maximum and one-second input guard. Width precedence remains
explicit `--width`, valid `COLUMNS`, valid TTY columns, then 80. The guard is not a
latency qualification. Input errors retain exit 3 and generic reason strings;
output rejection retains exit 1 and `statusline_output_failure`.

Only the native first line is localized. The original input object, source and
environment still go to the existing bounded summary reader. No normalized copy
substitutes for its identity input, and summary facts never replace native
model/context/cost. Summary wording, `partial`, ordering, expiry, lineage,
nullable totals and budget are unchanged. Missing/unavailable summary leaves a
nonempty native line. See [summary boundaries](delegation-summary.md).

The renderer does no filesystem, network, subprocess, provider, Git, transcript,
clock or environment reads. **The entire product command is not I/O-free:** it
retains its existing summary reads and direct-call observation outside rendering.
With an explicit source and matching parent identity, the integrated command may
append a bounded `Native calls:` line after the unchanged summary. If no summary
is available, that native-call line is the second line rather than a placeholder
third line. Native session labels and Jev snapshot facts are observations, not
HUD task verdicts. Missing host state is displayed as unavailable; rendering does
not start a host. `--details` and `--lang` change only the first line.

No real homes, providers, installed client, tmux or settings are used in this package's validation plan.

## Integration verification (2026-11-07)

The selected source candidate is `e862d75914b6ab36f36161fe19b346dac34681e4`.
Its opt-in renderer and CLI grammar were applied to the native-call display work
without replacing the existing compact first line or legacy summary. The
independent source-delivery history below remains preserved.

On Linux with Node 24.22.1, the integrated source, test and MCP TypeScript builds
passed. A focused 13-suite emitted regression run passed **184/184**, including
native details, preview, existing statusline/summary/settings, product routing,
HUD environment/settings, digest readers and native-call display. The added
composition case verifies compact, EN and ZH first lines alongside the unchanged
legacy summary and direct-call line, explicit source isolation, no host startup
and unchanged persistent fixture bytes.

The initial focused run passed 113/114 and exposed an existing oversized-open-
stdin defect: both product entrypoints emitted `statusline_input_too_large` but
did not exit while the producer stayed open. An isolated rerun reproduced it.
The input reader now closes only its rejected one-shot input stream after listener
cleanup. The 64 KiB limit, one-second guard, diagnostics and stdout/backend
lifetimes are unchanged. Final tests include the original failure case, helper
cleanup assertions, and compact product/standalone-preview open-pipe regressions.
The original failed results are retained separately from the passing rerun.

Scoped formatting, fixture hygiene and whitespace checks passed. These are
synthetic and process-level cloud checks, not live Claude/Pi/Codex/Jev, native
notification/recovery, real tmux/Herdr, visual or performance qualification. Those
remain **NOT_RUN**, and this note does not declare a production/default switch.

## Validation status and local checklist

The new `tests/unit/statusline-native-details.test.ts` contains direct-renderer
assertions and actual `bin/hud-statusline` / `bin/hud statusline` subprocess tests.
It covers compact golden bytes, admitted/invalid/zero facts, deterministic EN/ZH
widths 1–500, terminal safety, argument rejection before input, input guards,
preview compatibility, output failure and age-free synthetic ledger composition.
Fixture snapshots include directory/file lists and persistent byte hashes;
existing SQLite SHM locking bytes alone are excluded from content comparisons.

At the original independent source delivery, compatible TypeScript/formatter/runtime
dependencies were unavailable. The following historical status describes that
delivery only, not the integrated checkout checks recorded above. Builds, emitted
behavioral tests, formatting, live Claude, visual and performance validation were
**NOT_RUN**. Hash/patch checks do not establish
compilation or functionality. Existing historical observer evidence does not
cover this new mode.

On a complete checkout with supported Node 24+ and the proper existing
dependencies, run:

```sh
npm run build
npm run build:test
node --test --test-concurrency=1 dist-test/tests/unit/statusline-preview.test.js dist-test/tests/unit/statusline.test.js dist-test/tests/unit/statusline-summary.test.js dist-test/tests/unit/statusline-settings.test.js dist-test/tests/unit/product-cli-routing.test.js dist-test/tests/unit/statusline-native-details.test.js
node node_modules/prettier/bin/prettier.cjs --check src/cli/statusline.ts src/render/statusline-session.ts src/render/statusline-details.ts src/render/statusline-labels.ts tests/unit/statusline-native-details.test.ts
npm run check:fixtures
git diff --check
```

Inspect synthetic EN/ZH output at 1, 10, 32, 48, 80 and 500 columns. Compare the
same controlled summary fixture against compact output. Keep results separate
from full-suite/observer evidence. The new test is included by normal
`build:test` / `test:unit`, but the existing cloud runner's explicit list does not
automatically add it; run the listed emitted suite explicitly without changing CI.
Any later real-client check requires a manually selected existing setting and
remains separate from this slice. D4 workloads, D5 observation and D6 default
switch are not performed or certified here.
