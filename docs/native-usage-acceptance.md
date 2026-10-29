# Native usage and Quiet overview acceptance

Date: 2026-10-29. Development branch: `codex/dev-native-usage-ui`.
Base: `a142353`. Runtime: Ubuntu 24.04 WSL, Node 24.22.1, private tmux sockets.

## Delivered scope

- Native local usage for today, 7 days and 30 days, with daily trends.
- All-local and current-task scopes; task self/descendant totals; model, effort
  and role grouping with coverage and provenance.
- Asynchronous private index, repeated-record/archive-copy deduplication,
  conservative fork attribution and explicit unknown/partial states.
- Optional Quiet overview presentation, English/Chinese labels, Usage navigation,
  saved-setting safety and no-color selection markers.
- [Activation and limits](./native-usage.md) and
  [architecture/task plan](./native-usage-ui-plan.md).

## Checks completed

| Check | Result |
|---|---|
| Before edits: `npm test` | 1,028 unit tests + 47 JavaScript tests passed |
| Final integrated `npm test` | 1,173 unit tests + 47 JavaScript tests passed |
| `NO_COLOR=1 npm run test:unit` | 1,169 passed after isolating a pre-existing color-specific test's palette |
| Analytics targeted tests | 33 passed, including a roughly 5 MB append/yield fixture and conflicting-dimension tests |
| UI focused and visual checks | 408 passed after review fixes |
| Visual golden coverage | 344 synthetic frames; the original 240 frames remain unchanged |
| `npm run test:integration` | Runner reports 27 passed, 0 failed, 1 skipped; native Windows test also self-skips with exit 0 |
| New private tmux acceptance | English 48 columns and Chinese 32 columns, color/no-color, exact accounting and navigation passed |
| `git diff --check` | Passed |

## Bounded performance probe

Run `npm run build` then `node tests/benchmarks/native-usage.mjs` in WSL. The
optional probe creates a temporary synthetic home and reports its location;
it does not read real session history. At 100 files, 100,000 usage events and
39.30 MiB, the recorded run measured:

| Operation | Elapsed | Largest observed 10 ms timer gap in that phase |
|---|---:|---:|
| Cold refresh | 1,420.8 ms | 20.7 ms |
| First snapshot | 25.454 ms | 25.5 ms |
| Unchanged warm refresh | 392.7 ms | 19.9 ms |
| 100 current-time cached snapshots | 7.8 ms total, 0.078 ms average | 10.4 ms |

The final-code snapshot was ready with 100,000 events/100 threads and zero reported coverage
errors. Focused tests were running concurrently. Measurements are machine-specific and do not establish a hard latency
guarantee. A preliminary probe mixed historical-range queries into one timer
window; its maximum gap was discarded as evidence about refresh latency.

The integration skips are explicit: real Herdr completion notification requires
`CODEX_HUD_TEST_REAL_HERDR=1`; native Windows pipe-pane behavior requires native
Windows Git Bash. Neither is claimed as executed. Existing narrow-panel
integration covers EN/ZH at 32/40/48/56 columns in both color modes.

The new `tests/integration/test-native-usage-real-tmux.sh` exercises:

- Clean Settings → Usage by actual mouse input, not just direct commands.
- All-local total 2,090 with a duplicated archived source; task total 1,320,
  split into self 1,100 and descendants 220.
- Model navigation and 7-day scope.
- Appended event refresh to task total 1,430 without losing scope.
- Reopen in Chinese/no-color at 32 columns with all-local total 2,200.
- No Usage keys in the mock Codex pane; normal input resumes after returning.

All values and session identities are synthetic. Optional captures can be
generated with `CODEX_HUD_USAGE_EVIDENCE_DIR=/chosen/output/path`; they are actual
tmux text/ANSI captures, not pixel/font screenshots. The four captured session
and Usage screens were inspected during acceptance. No live user pane was driven
or restarted, and no real credentials or conversations entered fixtures.

## Review and limitations

Independent UI review identified and the implementation corrected:

1. Clean settings navigation lost the Usage/Activity/Evidence destination.
2. Active Usage tab was indicated only by color.
3. Unavailable/partial empty arrays were described as confirmed no usage.

Independent data review found one additional issue: copied records with
conflicting role/model/effort labels could select a label by file order. The fix
reconciles each duplicated numeric observation once, keeps conflicting dimensions
unknown, and marks coverage partial. Four additional adversarial tests cover
ordering, matching later copies and unchanged totals; independent verification
found no remaining gap in that fix.

The final full run also exposed a fixed-delay race in an existing model-job test.
That test now waits for the actual digest completion signal, bounded by its test
timeout. The final analytics and model-job suites were additionally run under
`NO_COLOR=1` after these last data/test changes; product UI code was unchanged.

The index is not an archive after source deletion. Changed growing files stream
the previous prefix for integrity checking and parse only appended/torn-tail
JSON; they do not perform byte-tail-only I/O. Snapshot aggregates are memoized
between recorded event boundaries. Synthetic fork fixtures do not certify every
upstream fork schema: ambiguous ownership stays partial instead of being guessed.
Large real-history performance and native Windows rendering are not certified by
these checks. There is no pricing, account billing or model-quality claim.
