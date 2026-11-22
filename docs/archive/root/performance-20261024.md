# Synthetic performance measurements, 2026-10-24

The large-agent bottleneck was the rich-card cache, not terminal writes.
Moving the shared tree description out of every card's Map key reduced the
measured large-scene key-to-output P95 from 1325 ms to 28.3 ms. Small-scene
P95 stayed about 2.33 ms. Yielding between rollout scans separately reduced
the collector's maximum event-loop delay from 230 ms to 6.79 ms.

These are local synthetic measurements, not a universal latency guarantee.
All data and messages were fabricated under temporary CODEX_HOME directories;
no user sessions, model services, credentials or live tmux servers were used.

## Conditions and measurement boundaries

- Node v24.22.1, WSL2 Linux 6.18.33.2-microsoft-standard-WSL2.
- Small: 4 L1 agents; large: 256 L1 agents, plus the main rollout.
- Each rollout has 256 padding records with 1000-character payloads, about
  270 KB per file. The collector benchmark appends one small event per file
  before each of 30 warm collections. The terminal benchmark appends every
  fifth input. These fixtures do not represent a deeply nested tree.
- Actual POSIX PTY, 100 columns × 40 rows, English, fixed `none` theme,
  model backend off, 250 ms refresh, changes/details/timeline panes closed.
- The terminal probe waits for the first agent to be shown, settles one
  second, then sends 60 `?` keys, alternating opening and closing Help.
  Each sample starts immediately before the PTY write and stops when bytes
  containing the expected changed-screen token (`Help` or `agent_`) arrive.
  It includes input queueing, handler/render work and PTY output delivery;
  it does not measure a terminal emulator's pixels or compositor latency.
  Buffered output is drained before each input. Inputs are 40 ms apart after
  their output completes, so both builds process the same 60 interactions;
  the slower baseline necessarily runs more collection ticks.
- Event-loop histogram resolution: 1 ms. The collector additionally samples
  a 5 ms timer's lateness. CPU is process user + system CPU divided by wall
  time, not total machine utilization; worker threads can put it above 100%.
  PTY CPU includes startup and the whole interaction sequence.
- Existing `CODEX_HUD_PROFILE=1` measures stage wall time. Its ~10 s windows
  include startup; the short optimized run has one shutdown window. Window
  P95s are not mathematically combined into an invented overall P95.

The initial checkout was dirty, based on Git
`1d238ac367eb18c8c0f3504ea0516d899e43ef51`, including frame-diff and other
earlier work. Before editing, all compiled modules were saved to
`/tmp/codex-hud-performance-baseline`. Comparisons used copies of that build:
the card-only experiment replaced only `render/cards.js`; the combined
experiment additionally replaced `collectors/subagent-tree.js` and changed
the panel's existing tree-build call to await the yielding API. Other agents'
parallel edits were excluded. The result JSON records every compiled-module
SHA-256; exactly those three files differ in the combined build.

## Results

Final clean PTY run, identical probe and fixture conditions:

| Metric | 4 agents baseline | 4 agents optimized | 256 agents baseline | 256 agents optimized |
|---|---:|---:|---:|---:|
| Input-to-output P95, ms (60 inputs) | 2.336 | 2.331 | 1325.165 | 28.296 |
| Input-to-output maximum, ms | 3.722 | 3.030 | 1549.093 | 55.544 |
| Process CPU, % | 12.91 | 12.76 | 98.71 | 50.15 |
| Event-loop P95, ms | 1.151 | 1.162 | 3.639 | 1.784 |
| Event-loop maximum, ms | 27.738 | 20.120 | 2485.125 | 68.157 |

The event-loop histogram has many idle/short observations, so its P95 alone
would hide the baseline's stalls. The maximum and external input samples
show them. Large-scene baseline render-window P95s were 680.5–834.4 ms;
the optimized window's render P95 was 19.7 ms. Small-scene render P95 was
1.86 → 1.79 ms. The main collection's startup still costs hundreds of ms in
elapsed wall time: optimized collection P95 was 283.1 ms, including a
197.9 ms initial tree scan, while yielding makes input serviceable during it.

A preliminary **card-only** comparison gave large-scene key P95
829.6 → 34.2 ms, render-window P95 roughly 620–771 → 20.7 ms, and process
CPU 98.5 → 52.2%. Adding yielding did not improve steady-state key P95 in
that experiment (37.2 ms), but reduced the whole-run event-loop maximum
from 278.7 to 60.8 ms. Repeated local runs vary; the evidence supports the
large improvement and its cause, not an exact speedup factor.

Direct collector benchmark, 30 append-and-build warm passes:

| Metric, ms | 4 agents sync | 4 agents yielding | 256 agents sync | 256 agents yielding |
|---|---:|---:|---:|---:|
| Cold tree wall time | 10.218 | 13.123 | 225.288 | 200.405 |
| Warm listing P95 | 0.620 | 0.745 | 4.546 | 4.130 |
| Warm tree P95 | 0.746 | 0.765 | 23.034 | 16.074 |
| 5 ms timer maximum lateness | 5.854 | 1.857 | 226.531 | 5.894 |
| Event-loop maximum | 10.830 | 6.713 | 229.769 | 6.791 |

The direct collector run includes synthetic append I/O in CPU totals.
Its large-scene CPU was 885.7 → 915.0 ms, wall time 867.9 → 853.6 ms;
yielding is primarily a scheduling improvement, not a claim of lower CPU.

An early cold-input probe could match old output. That metric was discarded
and removed from the final script. No cold input-to-output number is claimed.
Terminal bytes are retained in raw results only; a byte reduction is not used
as evidence of responsiveness.

## Changes and correctness

`src/render/cards.ts` now compares the shared cache context once, clears its
bounded 500-entry cache when that context changes, and uses only each card's
original local dependencies as its Map key. No dependency was omitted. A CPU
profile of the baseline had 12,107 self samples in `richRows`; line samples
were dominated by `Map.get`, `Map.set`, and eviction with the large shared
prefix. This explains why caching itself consumed more time than drawing.
Switching back to an earlier context now rebuilds its cache rather than
retaining older contexts. This can add misses when configurations alternate,
but keeps output and the memory bound intact.

`src/collectors/subagent-tree.ts` exposes `buildSubagentTreeYielding` while
preserving `buildSubagentTree`. Both consume the same generator. Metadata and
reachable rollout histories are processed in file-sized steps, parents before
children, then the tree is constructed. The asynchronous consumer yields with
`setImmediate` after a 4 ms work slice. A single rollout scan, final node
construction, and scan-store flush remain synchronous, so 4 ms is not a hard
latency bound. Records, offsets and persisted fields did not change;
`SCAN_VERSION` is unchanged. Session-list cache semantics were left intact.

The panel awaits the yielding API and profiles listing separately as
`tree.list`. The existing profiling API remains compatible; the external
benchmark preload adds process CPU and event-loop measurement without adding
runtime timers to normal HUD use.

Validation against the saved baseline:

- Differential collector checks: nesting, unrelated root/disconnected cycle,
  completion append, partial JSON followed by completion, rewrite/relink,
  inode replacement, removal, and an explicit empty list all match.
- 192 rendered frames match exactly, including ANSI lines, controls/click
  coordinates, pane rows and scroll/selection state: 4/256 agents,
  16/32/100 columns, 8/40 rows, EN/ZH, `none`/`mocha`, clock ticks, selection,
  scrolling, node/status/peer changes, and link visibility.
- Latest source compiles. `cards`, `cards-l1`, `tree-scan-store`, `tree-order`,
  `agent-stages`, and `visual-baselines` suites: **299/299 pass**, with
  `env -u NO_COLOR`. Under the inherited `NO_COLOR=1`, two existing card-meter
  expectations fail equally in baseline and optimized builds; the benchmark
  deliberately fixes the theme to `none` and does not treat that as a product
  regression. Visual goldens were read unchanged.

## Reproduction and evidence

Raw values, stage windows, environment and compiled-module hashes:
[`tests/performance/results-20261024.json`](../tests/performance/results-20261024.json).
No timing threshold is asserted in CI.

Build into an independent output directory to avoid concurrent `dist` writes:

```sh
node node_modules/typescript/bin/tsc --outDir /tmp/hud-perf-build \
  --declaration false --declarationMap false --sourceMap false
printf '{"type":"module"}\n' > /tmp/hud-perf-build/package.json
ln -s "$PWD/node_modules" /tmp/hud-perf-build/node_modules
node tests/performance/collect.mjs /tmp/hud-perf-build 4 256
node tests/performance/collect.mjs /tmp/hud-perf-build 256 256
python3 tests/performance/terminal.py /tmp/hud-perf-build 4 256
python3 tests/performance/terminal.py /tmp/hud-perf-build 256 256
```

The differential runner needs both builds:

```sh
node tests/performance/correctness.mjs \
  /tmp/codex-hud-performance-baseline /tmp/codex-hud-performance-build
```

The baseline paths are local measurement artifacts, not durable repository
fixtures. Preserve both builds separately if a later rerun must reproduce the
original dirty checkout. For a CPU profile, set `HUD_PERF_CPU_PROFILE_DIR` to
an existing private output directory when running `terminal.py`.

Unit validation used `tsc -p tsconfig.test.json --outDir
/tmp/codex-hud-performance-test --sourceMap false`, then `env -u NO_COLOR node
--test` for the six suites named above. The isolated compiled fixture's
`REPO_ROOT` was redirected to the real repository so tests could read the
unchanged visual goldens. This redirection affected the temporary test build
only.

Not covered: real model/network latency, a live Codex conversation, physical
terminal/font rendering, mouse interaction through tmux, Windows-native CPU,
slow/network filesystems, very large individual rollout files, thousands of
agents, deeply nested trees, and all panes simultaneously. Remaining long
single-file work and other synchronous stages can still delay input.
