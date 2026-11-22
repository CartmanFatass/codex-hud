# Performance and Rust migration plan (2026-11-22)

Merged by the main session from three read-only oracle reports on `tmp/tasks/perf-review/brief.md`: neon xhigh (j14d7f53472854507, 19 min), carbon high (jf06002a93096d964, 25 min), astra max (j37342890b780094e, 40 min). The reports live in `~/.hud/jobs/<id>/report.md`. Numbers were measured on a loaded WSL2 host (load 13–63), so read them as workload comparisons.

## Agreed by all three

- **No Rust panel, watcher, MCP, N-API addon or SQLite rewrite.** Paint costs 0.2–3 ms, and the expensive work is algorithmic. TypeScript stays the core.
- **The only native win is the statusline**, which starts a fresh Node process per call: 110–355 ms and about 100 MB RSS each, every 5 s per Claude session. Node itself costs 50–90 ms and 78 MB before any HUD code runs.
- **`NODE_COMPILE_CACHE` is no fix** for the statusline (−6% CPU, 0% RSS).
- **The panel's waiting wrapper process is pure waste** (66 MB RSS, about 42 MB PSS): use an exec handoff.

## Stage 1: TypeScript fixes (tickets perf-ts/01–08), each landable alone with its own before/after number

| # | Change | Source | Expected |
|---|---|---|---|
| 01 | Panel runs as one process (exec handoff in `src/cli/compat.ts` foreground, spawn fallback). A Claude or pi panel no longer runs the Codex `finder.check()` (`src/panel/controller.ts:241-249`; verified), so adaptive poll can back off. | all; neon+carbon | −42 MB PSS; idle CPU 12% → <1% |
| 02 | V8 heap caps for the long-lived processes: panel `--max-old-space-size=128 --max-semi-space-size=4`, watcher and MCP `96/2`. Measure live RSS/PSS and an OOM-free soak first. | neon (measured −73% PrivDirty) | panel RSS 295 → 137 MB synthetic |
| 03 | Hot reload without a memory ratchet. The watcher reloads by `process.execve` (as panel-reload does). `generation.mjs` no longer pins generation 0 on the main thread (`initial`, verified) and terminates retired workers. | carbon, neon; astra measured the growth | watcher PSS stays near the fresh ~22 MB, not 250 MB after 50 reloads |
| 04 | Panel hot loops: memoize `ProjectCollector.collect()` on `.scratch` stamps; skip `thin-jobs` `exportFacts()` + stringify when unchanged; ASCII fast path in `visualWidth` (17×); lazy `Intl.Segmenter`. | neon, carbon | panel tick 40 → <8 ms (400-job fixture) |
| 05 | MCP per-call cost: memoize git root lookups (`src/roles/projects.ts` spawnSync); one jobs scan per call; queue positions computed once per response; no watcher spawn for an empty read (5 reads launched 5 watchers). | neon, carbon, astra | `hud_read` 77 → <15 ms at 400 jobs; queued 96: 690 → 44 ms |
| 06 | Land gate: `tsc --incremental` with the build info outside stage dirs; skip the `after` rebuild when the tested build matches the landed tree exactly. Record per-step timings. No test-concurrency change before an isolated A/B. | all three | about one cold build (13–29 s) saved per land, plus 2 incremental builds |
| 07 | Worktree reap: tracked `node_modules` files get checked out as a real directory, so `dependencyLink()` fails and reap never removes the worktree (16 dirs, ~750 MB). Reap must handle it. | astra (cause), carbon (effect) | stale worktrees → 0 |
| 08 | pi footer caches "EXP disabled" and stops rereading settings on every draw (120 reads per 120 paints). | astra | I/O per paint → 0 |

**Deferred:** rollout parser linear assembly and the linkCache fix (astra, carbon). They matter only for Codex rollouts; Codex is deferred, and 01 stops Claude panels from touching Codex sessions. Revisit if a pi or Claude panel shows the same churn.

**Owner decisions** (see the chat on 2026-11-22):
- Sonic `stdout.jsonl` is 75–125 MB, 97% of `~/.hud/jobs`. Bound it on clean settle (keep head and tail), or keep full diagnostics as documented?
- Prune the 666 MB of extraneous root `node_modules/@anthropic-ai` and the 5.7 GB in `tmp/tasks/`?

## Stage 2: native statusline (tickets native-statusline/01–03), after Stage 1

Decision: a zero-dependency Rust `hud-statusline` that renders the Claude line itself, with Node as the fallback (neon and carbon). Astra's alternative, a thin Rust client relaying to a resident TS renderer in the MCP, was rejected. Its reasons were valid: no duplicate renderer, and fresh stdin is needed anyway. But it needs a co-resident process, discovery, auth and replay-after-stdin rules, and its target (25 ms) is much slower than a native render (1–5 ms).

Astra's correctness constraints are kept:
- Fresh stdin per call. No "last line" file.
- Stdin is buffered before any fallback, and the fallback replays it through a private pipe.
- Forward, admin, details and explicit-source modes always run the TS CLI.
- Email suppression and quota publication are preserved.
- Absent, stale or incompatible inputs mean the TS path, never another session's line.

The work facts come from a small, versioned, private snapshot that the watcher and MCP write (`display/work-summary.v1.json`). If it is missing or stale, the TS path runs. The parity caches (git, transcript, context, quota) keep their existing JSON files. A differential test runs TS and Rust on the same fixtures in the gate, so a TS statusline change that breaks parity fails the land.

| # | Slice |
|---|---|
| 01 | Watcher and MCP publish `work-summary.v1.json` (private, atomic, bounded). The pi footer segment reads it instead of scanning. |
| 02 | Rust crate `native/` (std-only), built by `npm run build` only when `cargo` exists and `native/` changed. Polyglot `bin/hud-statusline` dispatch with TS fallback. Differential parity tests. Linux/WSL x64 first; the release archive carries the binary and `./install` falls back to TS without it. Target p50 <5 ms, <5 MB RSS. |
| 03 | Antigravity uses the same binary, which replaces `bin/hud-statusline-cache.sh` (22 ms per hit), keeping that cache's staleness rules. |

Optional later: a native `hud-sonic-run` supervisor (84 MB → 2 MB per running sonic, neon). Reconsider once headless imps (auto-route) multiply supervisors; slim the TS runner first.
