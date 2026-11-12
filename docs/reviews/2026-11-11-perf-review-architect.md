# PERF-REVIEW — performance evidence and recommendations

**Recommendation:** Keep the current process model; remove unnecessary work from the statusline and MCP read paths, finish the already-assigned scan/material fixes, and measure the standalone panel’s idle collection before adding any further caching.

## 1. Evidence, limits and scope of the measurements

Advice only. No repository/configuration changes, builds, live pane operations, model calls, or reads of the owner’s job/session/credential contents were performed. Only this report was written.

Host: **Jacob**, Linux `6.18.33.2-microsoft-standard-WSL2`, x86-64, Node **v24.22.1**. Measurements were made on **2026-11-12**, approximately 07:21–07:33 UTC. This is an actively used host, not a controlled performance qualification.

The checkout was shared and changing: HEAD moved from `1ef6beec` to `aa47181b`. The following existing build hashes remained unchanged across the measurements (SHA-256 prefixes):

| File | Hash |
|---|---|
| `dist/cli/statusline.js` | `f9a8ae684d5e26bf` |
| `dist/tree-page.js` | `da1352daaea43baa` |
| `dist/collectors/thin-jobs.js` | `9263d0c234628598` |
| `dist/harness/pi/p10k-footer.js` | `18e26b7b61dbc445` |
| `packages/hud-mcp/dist/packages/hud-mcp/src/thin-main.js` | `b564395a47d69834` |
| `packages/hud-mcp/bin/hud-watch.mjs` | `399d7499ca7b25f5` |

Source citations describe the source inspected during this review, not proof that every source change was in those builds. In particular, JOB-SCAN and M3B-FIX were concurrent work. **Do not treat this report as a review of, or replacement for, either repair.**

### Important measurement gap

The architect shell guard rejected the disposable fixture/profile command before execution, despite orchestrator authorization. The orchestrator then explicitly directed me to proceed with read-only measurements and supply the missing experiment list. Therefore:

- **NOT RUN:** 300-job filesystem benchmark, multi-minute synthetic panel CPU/heap profiles, real `hud_read(wait_ms)` against a synthetic job, instrumented per-tick filesystem counts, synthetic watcher termination/reap tests.
- `strace` and `hyperfine` were not installed. Timing used Python `perf_counter` and child `getrusage` instead.
- Read-only child processes used an allowlisted environment with HOME/HUD_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR pointing into `/tmp/hud-perf-readonly-nonexistent/`, and a nonexistent synthetic Herdr socket. That directory was never created. No inherited provider keys or real HUD homes were passed.
- The pi footer experiment used **in-memory synthetic entries**, an injected Git result, and no live pi session.
- Live evidence is restricted to `/proc` counters. No live visibility/activity state was established; those samples must **not** be labelled “idle benchmarks.”

Percentiles below are nearest-rank. Short-process tests have 30 runs, no separately discarded warm-up; imports were filesystem-cache-warm, not cold-disk startup. Footer results are ranges across three batches, not p95/p99 estimates. `/proc` CPU accounting has 10 ms resolution on this host.

## 2. Cost table

Hourly figures are extrapolations, not hour-long measurements. “CPU seconds/hour” is process CPU time, not elapsed latency or battery energy. Live parent-process counters omit Git/Herdr/tmux child CPU. Logical read/write counters include pipes and terminals; they are **not SSD traffic**.

| Component / experiment | Measured cost | Cadence | Cost per hour / interpretation |
|---|---|---|---|
| Bare Node, `node -e ''`, n=30 | Wall p50 **20.48 ms**, p95 **22.33 ms**, max **22.36 ms**; CPU p50 **20.62 ms** | Reference only | Establishes the process-start floor |
| Claude statusline `--help`, n=30 | Wall p50 **54.98 ms**, p95 **60.07 ms**, max **60.35 ms**; CPU p50 **56.98 ms** | Each invocation | Most minimum-path time exists before useful collection |
| Claude statusline, `{}` input, no parity config/jobs, n=30 | Wall p50 **58.20 ms**, p95 **63.08 ms**, max **63.12 ms**; CPU p50 **60.64 ms**. Import-only process RSS **71.9–72.0 MiB** | Claude controls refresh; not measured live | At 1 Hz: **218 CPU s/h**; at once/5 s: **43.7 CPU s/h**. This is the minimal path, **not** the configured Claude parity workload |
| pi footer, synthetic 1,000 / 10,000 / 100,000 usage-bearing entries | Changed-leaf update: **0.078–0.148 / 0.676–0.740 / 6.974–7.409 ms**. Same-leaf update at 100k: **0.118–0.259 ms**. Render: **0.020–0.043 ms** across sizes | Lifecycle events; work signals additionally every 5 s | At 1,000 changed-leaf events/h: **0.68–0.74 s** update wall work for 10k entries, **6.97–7.41 s** for 100k. Not a live pi CPU/RSS attribution |
| Codex tmux bar A, live, three 20 s windows | RSS **94.4 MiB**, 11 threads; CPU **0.05–0.07 s/20 s**; logical reads **0.98–1.30 MB/20 s** | 1 s timer; positively quiet collection can back off to 5 s | **9–12.6 CPU s/h**; **176–233 MB/h** logical reads if that workload persisted |
| Codex tmux bar B, live, same windows | RSS **111.9 MiB**, 11 threads; CPU **0.07–0.09 s/20 s**; logical reads **0.24–0.31 MB/20 s** | Same | **12.6–16.2 CPU s/h**; **43–56 MB/h** logical reads |
| Panel, live, same windows | RSS **239.4→242.6 MiB**, 11 threads; CPU **0.31–0.40 s/20 s**; logical reads **2.16–2.32 MB/20 s**, **3,698–4,412 read syscalls/20 s**; logical writes **17.8–71.6 KB/20 s** | Default collect 1 s; adaptive rules below; repaint independently scheduled | **55.8–72 CPU s/h** (~1.55–2% of one core); **388–417 MB/h** logical reads. Filesystem `write_bytes` total **139,264 bytes/60 s**, not enough to infer persistent SSD wear |
| Panel module import only, three fresh processes | Import **102.24–103.05 ms**; RSS **91.4–91.9 MiB**; total process CPU **143.8–144.7 ms** | Once on opening | Not startup-to-first-frame. Live minus import RSS is **not** a leak estimate |
| hud-mcp, fresh process through initialize, three runs | Ready in **28.60–32.31 ms**; initial RSS **68.5–68.6 MiB**, 7 threads; after tool batches ~**76.7–76.9 MiB** | Per client connection; pi connects lazily on first tool | Three 10 s idle intervals showed **zero additional CPU ticks, reads, or writes** |
| `hud_roster`, 30 requests in each of 3 servers | p50 **0.679–0.699 ms**, p95 **1.407–2.499 ms**, worst **4.945 ms**; ~**30 ms CPU per 30 calls**; ~**62.6 KB logical reads / 607–608 read syscalls per batch** | On demand, no timer | At 60 calls/h: about **0.06 CPU s/h**. Sources were shipped role files, absent user overrides, restricted executable PATH |
| `hud_read` list with empty jobs home, same batches | p50 **0.135–0.189 ms**, worst **0.325 ms** | On demand | Negligible empty-home cost; **does not measure large history or waiting** |
| Job watcher, live | RSS **82.2 MiB**, 7 threads; **157 inotify watches**; CPU **0–0.01 s/20 s**; logical reads **312–2,392 bytes/20 s** | Filesystem/Herdr events and nearest failed-job retention deadline, not a periodic scan | Observed range **0–1.8 CPU s/h**; retaining its Node process costs RAM while jobs remain open |

The live panel’s RSS increased about **3.2 MiB over the sampled minute**, mostly in one interval. Without a heap profile and repeated steady workloads this is **not evidence of unbounded growth**.

## 3. Findings, ranked by user impact

### 1. CHANGE / DELETE — trim the statusline’s minimum path, especially panel-only model configuration

**Evidence:** `bin/hud-statusline:2` imports `src/cli/statusline.ts`; that file statically imports administrative settings code at `src/cli/statusline.ts:7` and the rendering/collection branches at `:8–13`. `applyBarSettings()` asks for all runtime settings merely to take two fields (`src/settings-runtime.ts:40–43`). Defaults inspect model credentials (`src/settings.ts:141–145`), including when loading saved settings (`:275–300`).

A static relative-import walk of the measured build found **38 files / 236,461 source bytes** reachable from the statusline entry, including `jev/ask/config`, `jev/decide`, `jev/model`, `jev/questions`, panel card preferences and panel command definitions. This is a static import census, not a syscall trace. The import itself took **32.05–33.85 ms** in three fresh processes. The help path already costs ~55 ms versus ~20 ms for empty Node.

**Cause:** One-shot rendering pays for branches and panel preferences it does not use. The bottom bar does not make model requests and does not need to discover whether a model key enables panel text.

**Smallest fix:**
- Lazy-import administrative `settings`/`import` implementations only for those subcommands.
- Let the bar load/validate its existing `barStyle` and `barFields` without evaluating the credential-dependent panel-model default. Preserve existing settings/error/environment behavior; do not introduce another persistent cache or daemon.
- Do not mistake all 35 ms of extra startup for removable overhead: layout, transcript and ordinary rendering modules are legitimate dependencies.

**Expected gain:** Remove credential/config probes unrelated to rendering and part of the measured import overhead on **every** Claude refresh. Exact milliseconds require an A/B run; **no 35 ms saving is claimed**. Every measured 5 ms improvement would save 18 CPU s/h at 1 Hz if it also reduces CPU by 5 ms.

**Tests:** Subcommands still function; ordinary rendering does not import administrative execution code or read model credentials; saved/default/invalid bar settings and `NO_COLOR` remain identical. Benchmark the actual parity workload after JOB-SCAN, including a fresh process each time.

### 2. DELETE — MCP reads reports and question bodies that its caller throws away

**Evidence:** `packages/hud-mcp/src/thin-main.ts:489–516` builds `observation(job)` by reading STATUS, up to **65,536 bytes** of report, enumerating QA and reading open question bodies. The no-job list returns only identifiers, role, state and creation time, but obtains each state via that full observation (`:623–630`). The wait loop repeats the full observation every **500 ms** (`:636–660`).

**Cause:** A full response constructor doubles as both a list-state reader and a settlement predicate. The list discards reports and questions. A waiting request repeatedly rereads an unchanged report before it is going to return.

**Smallest fix:** Factor the existing state calculation into a small shared helper; list mode reads only receipts and STATUS. For waiting, poll just state and outstanding-question existence, then construct the full observation once on return. Recheck at the return boundary so a state/question race cannot suppress a response. Keep the 500 ms polling behavior initially; switching to filesystem events is not needed to remove the waste.

**Expected gain (source-derived, not benchmarked):** A 20-job list with 64 KiB reports avoids **1.25 MiB of report reads per request**, plus QA body work. A continuously waiting request with an existing 64 KiB report currently can reread about **450 MiB/h** of report text alone (7,200 polls/h). These are logical bytes, not disk misses. It is particularly unnecessary when a continuation leaves the preceding report in place.

**Tests:** List mode must not open reports/questions; unchanged waiting jobs must not reread report bodies; new QA, answer arrival, settlement, failure, disappearance and timeout still return the same public fields. Preserve `read_at` semantics and read-only concurrency with mutations. No new public tool or cache is required.

### 3. CHANGE — standalone non-Codex panels cannot reach the existing quiet backoff

**Evidence:** `src/tree-page.ts:1220–1235` records a successful quiet poll only if `currentHud().health.sessionBound === true`. Collection binds this health bit to the **Codex finder** (`:1246–1290`). `src/utils/collection-observation.ts:5–10` classifies an unbound source as uncertain; `src/collectors/adaptive-poll.ts:57–75` leaves uncertain observations at base cadence. The same main collection function runs from the default 1 s interval (`src/tree-page.ts:1113–1117`).

**Cause:** A thin-job panel can have a perfectly valid explicit job/workspace scope but no bound Codex session. It therefore cannot benefit from the quiet optimization intended for native Codex sessions. Closing an overlay or merely hiding the terminal does not suspend collection.

**Smallest fix, after profiling:** Give the existing adaptive controller an explicit **job-panel observation** when that is the intended mode. Back off only when collection is complete, unchanged, and has no active/pending jobs or unresolved native coverage. Retain immediate input/model-change wakeups and the existing 5 s maximum. Do not call unknown/missing evidence “idle,” and do not globally slow working jobs.

**Expected gain:** Going from one qualifying collection/second to one/5 seconds removes **80% of collection passes** in that case. This is not a promise to remove 80% of the live panel’s measured CPU; rendering, Git and background work have separate schedules. The live panel cost establishes that the experiment is worthwhile, not that this is its dominant cause.

**Tests:** Empty-but-completely-observed job scope backs off; working jobs, unanswered questions, failed reads and uncertain native coverage do not silently disappear; input wakes collection; force-during-await is retained. Measure question visibility latency and CPU together.

### 4. DELETE in the existing cleanup slice — remove producers with retired views, not just their tabs

**Evidence:** The approved product cleanup explicitly removes Timeline/Activity/diagnostic pages (`docs/spec.md`, M3b old-views paragraph). The inspected live collection still computes `history.timeline(...)` on every collection (`src/tree-page.ts:1344–1347`) and calls `observeActivity()` (`:1380`), with journal work also on the bar (`src/index.ts:242–248`). The panel’s static relative-import graph is **159 files / 1,734,808 bytes**.

**Smallest fix:** In the already-planned deletion, remove unused collection, persistence and imports as well as rendering/input routing. Preserve the retained Inspector, native cards, snapshot publisher and required model-call count. Inventory their consumers before deleting shared data.

**Expected gain:** Removes entire work paths and their allocations/writes; the current measurements do **not** attribute a millisecond/RSS amount to them. Do not launch a competing cleanup or optimize code already authorized for removal.

**Tests:** Retained views and snapshot behavior stay intact; the retired producers perform no reads/writes after removal. Compare CPU profiles before/after the existing slice.

### 5. DELETE small duplicate footer work; otherwise leave the ordinary footer alone

**Evidence:** `src/harness/pi/package-entry.ts:162–180` registers `agent_end` in the generic `segment.refresh(); footer.update()` handler and again in `footer.settled()`, which calls `update()` (`src/harness/pi/p10k-footer.ts:612–616`). `update()` always scans the branch for viz mode (`:534–536`, `readVizMode` at `:377–389`), while usage totals are scanned only after a leaf change (`:175–218`).

The synthetic test confirmed **51 full usage scans and 101 branch scans** for start + 50 changed-leaf + 50 same-leaf updates; **500 renders added no history scans**. At 10k entries, a changed-leaf update took only ~0.7 ms. At 100k it rose to ~7 ms. The synthetic `getBranch()` returned an existing array, so real host array-construction costs are not included.

**Smallest fix:** Make `agent_end` take one appropriate footer update path. No incremental usage database or new timer is justified by the ordinary-sized measurements. If a real long-session profile makes history summation material, then maintain append totals with a full rebuild on session/branch reset; do not implement that speculatively.

**Expected gain:** One redundant lifecycle update per `agent_end`, not a major idle saving. Keep this below statusline and MCP work.

## 4. Where work happens now

### Claude statusline

- Every refresh starts Node. There is no in-process cache across invocations.
- Parity is selected by `$HUD_HOME/config.json` (`src/statusline-parity/settings.ts:83–89`). The full configured parity branch was **not** exercised by the minimal timing test.
- Transcript state is persisted under `display/statusline/`: initial bounded head/tail, incremental append/backfill, and zero transcript body bytes once an unchanged history is caught up (`src/statusline-parity/transcript.ts:255–375`). Reading the cache itself still costs I/O.
- MCP configuration counts use signature-gated persistent caching (`src/statusline-parity/config-counts.ts:13–63`). Auto-compaction settings are still read separately each invocation (`src/statusline-parity/collect.ts:23–29`). Recent agent definition prefixes are bounded to six types (`:52–74`).
- Git is synchronous on this one-shot path, with a **2 s TTL and 120 ms aggregate command budget** (`src/statusline-parity/git.ts:20–25,50–64`). Expired warm refreshes run filter-config inspection and status; discovery adds commands. Preserve defenses against repository-controlled Git commands when changing this path.
- Quota comes from the supplied Claude data, not an extra periodic network request. No reason to add a quota-fetch service.
- Job notices call the same thin-job reader (`src/cli/statusline.ts:136–145`). **JOB-SCAN needs a cold-process statusline check as well as warm-panel tests:** an in-memory file cache cannot survive the next Claude refresh. Also check that bars are not paying to construct answered-decision material they never show. This is a follow-up acceptance case for that work, not a second scan redesign.

### pi footer

- Runs inside pi; the ~69 MiB import-only test process is **not** the extension’s marginal resident memory.
- Footer facts are captured on lifecycle events. Drawing/resize does not traverse history or start Git.
- The work segment refreshes every 5 s and on lifecycle events (`src/harness/pi/segment.ts:30–54`; package-entry event list above), so 720/h is the timer count, **not a total upper bound**.
- Git refresh is asynchronous, single-flight, TTL-gated and has a 1.5 s timeout (`src/harness/pi/p10k-footer.ts:245–277`). It does not launch a process per repaint.
- The ordinary pi MCP client is lazy (`src/harness/pi/role-client.ts:70–77`), rather than allocating a server just to register tools.

### Codex bar and panel

- Bar: native chokidar events on Linux, a 1 s fallback tick, 5 s session-finder polling (`src/index.ts:361–378`; `src/collectors/file-watcher.ts:12–18`). Job signals are explicitly limited to once/5 s (`src/index.ts:98–107`).
- Panel: collection is single-flight; default 1 s, adaptive maximum 5 s where positive idle evidence permits. No general terminal-visibility/occlusion suspension was found.
- Native main rollout reads are signature-gated; the panel passes its already-built tree into `HudStatus`, avoiding a second native tree scan (`src/tree-page.ts:1273–1286,1365`; `src/collectors/hud-status.ts:133–137`).
- Artifact and legacy job observation retain bounded read budgets; thin-job collection is a separate synchronous call (`src/tree-page.ts:244–260`). Do not assume the documented artifact slice bounds automatically bound that call.
- Basic Git is requested on the 3 s status cadence but its own cache has a 10 s working-tree freshness bound (`src/collectors/hud-status.ts:120–124`; `src/collectors/git.ts:25–30`). Changes/worktree detail reads are separately visibility-gated. Embedded panel collection also calls `tmux display-message` for main-pane width every pass (`src/tree-page.ts:1094–1110,1385`); standalone skips it. If profiles show spawn cost, refresh width on relevant resize/input instead of every collection, but test external tmux resizing before changing it.
- Legacy job liveness uses one single-flight `herdr agent list --json` at most every 5 s, 250 ms timeout, 256 KiB output bound (`src/collectors/job-live-observation.ts:6–9,12–71`). This is not the new job watcher’s event mechanism.
- Repainting has an independent clock timer, 1 s for second-bearing live displays and up to 60 s otherwise (`src/tree-page.ts:1048–1092`). Frame comparison/row diff suppresses unchanged terminal writes. Terminal bytes and pure render time still need the synthetic profile.
- The model service is single-flight and rate-capped. Its queue holds submitted work; callers coalesce/bound their own handles. Cache and shared-accounting reads happen on submission, not in pure rendering (`src/collectors/small-model.ts:554–610,664–827`). No model/network measurement was performed. Leave the M3B-FIX unchanged-material repair to its implementer.

### hud-mcp and watcher

- The thin MCP imports Node built-ins, not the panel/legacy execution stack. Roster rereads role JSON, convention and applicable pi role frontmatter on demand. Its measured idle behavior is already good.
- `hud_read` waits are **polling**, independent for concurrent read requests; the server does not run a permanent observer timer. The report-read waste is local to those waits/list calls.
- The watcher is already event-driven: recursive `fs.watch`, one Herdr event socket and a timer for the nearest failure-retention deadline (`packages/hud-mcp/bin/hud-watch.mjs:57–95,111–188`). The inspected code uses signature-cached file contents. It scans on relevant events, reaps terminal jobs, and stops when no open job/deadline remains. No periodic Herdr CLI poll is present.
- Reaping uses synchronous `pi-role-reap` with a **135 s timeout** (`hud-watch.mjs:151`). This serializes reaps and blocks watcher JavaScript during a slow reap; it is a worst-case responsiveness issue, **not measured idle CPU**. Do not introduce a supervisor to solve it. Test a slow synthetic reap before deciding whether an asynchronous, still-serial child is needed.

## 5. Growth and writes

| Store/resource | Existing bound / remaining issue |
|---|---|
| Snapshot files | `SnapshotWriter` ignores refresh timestamps in its change signature and writes atomically only on semantic change (`src/snapshot.ts:296–317`). **Do not “fix” nonexistent unconditional every-tick writes.** Ownership-aware exit removal is already present |
| Native scan cache | Only larger scans are worth saving; dirty flush at most once/minute; old unused files pruned on construction after 7 days (`src/collectors/tree-scan-store.ts:25–30,69–75,121–137`) |
| Agent logs | 30 entries/agent, 200 agents/session, 600 characters/entry; 30-day file pruning (`src/collectors/agent-log.ts:56–61,295–326`). Pruning enumerates the log directory after a dirty flush; profile before adding another scheduler |
| Model display caches / telemetry | Existing bounded record counts; telemetry 24 h / 1,000 records (`src/collectors/model-telemetry.ts:13–14`). No evidence justifies replacing these with a database |
| Optional profile log | 4 MiB rotation with one previous file; disabled path has no timer/I/O (`src/utils/profile.ts:4–11,18–22,112–137`) |
| Claude parity cache directory | Each file is limited to 1 MiB, but names are hashed per transcript/cwd and the storage module has **no directory-wide retention bound** (`src/statusline-parity/storage.ts:50–73`). Long-term file count can grow; its actual size was not read from the owner’s home |
| Watcher log / closed-tab set | Log is trimmed to 200 lines **at startup**, then appended during the lifetime; closed-tab IDs accumulate during that lifetime (`hud-watch.mjs:42–55,86–88`). Continuous overlapping jobs can keep that lifetime long. Current measured cost is small |
| Job reports, transcripts and QA | Persistent user work, not expendable display caches. No history retention limit was established. **Do not automatically delete them to improve scans.** Keep collection proportional to the relevant live view |
| Activity files | Content is bounded per root, but retirement of the Activity feature should remove its producer in the existing cleanup, rather than add a new cache-GC subsystem |

These are source-level growth observations. They do not prove a current large cache, memory leak, or SSD problem.

## 6. What is already fine

1. **MCP architecture:** ~30 ms initialize, no measured idle reads/ticks, no resident coordinator. Do not replace per-client MCPs with a shared daemon to save ~69 MiB each.
2. **Watcher cadence:** already event-driven and quiet; preserve on-demand start/exit and pi-role-reap ownership.
3. **Normal pi footer rendering:** tens of microseconds in the synthetic fixture, independent of history length; no need for a renderer cache.
4. **Incremental transcript/native reads, single-flight collection/Git and pure rendering:** preserve their reset/truncation/failure semantics.
5. **Changed-row terminal painting, semantic snapshot writes, dirty scan-cache flushes and existing record bounds:** already address the obvious I/O amplification risks.
6. **No model calls when disabled/no key:** preserve this gate. Do not trade it for speculative precomputation.

## 7. Exact follow-up measurements for the orchestrator

These settle the gaps; none was run here. Use `tmp/tasks/BAR-UNIFY/env.sh` for each run, then an **allowlisted** child environment (the helper itself leaves other inherited variables intact). Retain only PATH, its temporary HOME/HUD_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR/PI_CODING_AGENT_DIR, synthetic HERDR_SOCKET_PATH, TZ and the explicit HUD test settings. Run from a scratch project inside that temporary home; never from a project containing real task artifacts. Do not rebuild `dist/`.

### Fixture

Generate **300** `j` + 16-hex job directories: 20 working, 280 closed, all synthetic and in the scratch cwd; each has `job.json`, `brief.md`, `STATUS.json`, a **64 KiB report**, and **10 answered QA pairs**. Give timestamps deterministic ordering. Add a **6 MiB Claude JSONL transcript** with valid public assistant messages. Use `$HUD_HOME/config.json` with a parity statusline section and `$HUD_HOME/hud-settings.json` with `modelEnabled:false, refreshMs:1000`. A second variant adds one valid synthetic Codex rollout under today’s dated sessions directory, with session metadata matching the scratch cwd. No SESSION.txt tab IDs are needed for display tests.

### A. Actual statusline latency and reads

Run, in the isolated environment, 3 batches of 30 fresh processes:

```sh
node /home/fires/projects/MyHUD/bin/hud-statusline < "$T/input.json"
```

Measure wall time and child CPU as in §2; first with 0 jobs, then 300; first transcript encounter, incremental catch-up, fully warm transcript cache, and a small append. Record p50/p95/p99/max, file opens/body bytes and Git subprocess count. When `strace` is available:

```sh
strace -c -f node /home/fires/projects/MyHUD/bin/hud-statusline < "$T/input.json"
```

This is the acceptance check missing for both startup pruning and the cold-process side of JOB-SCAN. Compare against the replaced statusline only if its executable is actually available; **no baseline parity claim is established by this review**.

### B. Panel CPU/heap, frames and idle behavior

For three sequential 180 s runs, use the 300-job fixture and the bound/unbound variants. Keep stdin open, then send SIGTERM to the specific test PID so profiles flush:

```sh
CODEX_HUD_STANDALONE_PANEL=1 CODEX_HUD_PANEL_ALL_DELEGATIONS=1 \
CODEX_HUD_CWD="$T/project" CODEX_HUD_PROFILE=1 \
node --cpu-prof --heap-prof --cpu-prof-dir="$T" --heap-prof-dir="$T" \
  /home/fires/projects/MyHUD/dist/tree-page.js
```

Capture stdout/stderr into `$T`, sample `/proc/$PID/{stat,status,io}` every second, and record display/profile.log stage counts. Compare 20-working vs all-settled, Home vs modal, and initial vs warm collection. Count render invocations and actual frame bytes separately. Use a synthetic private PTY for the frame-size test; a pipe is acceptable for collection but is not a real terminal paint benchmark. Do not infer hidden-pane savings from redirected output. Only a supported synthetic visibility signal can test that case.

### C. MCP read amplification

Start the existing MCP with the same 300-job home:

```sh
node /home/fires/projects/MyHUD/packages/hud-mcp/bin/hud-mcp.mjs
```

Send newline-delimited initialize, then 30 `hud_roster`, 30 no-job `hud_read`, 30 direct `hud_read` calls. For one working job with a retained 64 KiB report and no open question, send `hud_read` with `wait_ms:120000`; instrument reads and CPU. Repeat three times, then repeat with a question created at 5 s and with settlement at 5 s. Verify the answer latency, report bytes, and `read_at` side effect. The existing protocol supports concurrent read requests; also test two waits to expose multiplied read cost.

### D. Watcher lifetime and event costs

Against a fixture-only Herdr event socket and PATH containing a synthetic `pi-role-reap` stub:

```sh
node /home/fires/projects/MyHUD/packages/hud-mcp/bin/hud-watch.mjs
```

Measure startup with 300 jobs, 60 s no-change idle, 100 STATUS renames, closure of the final working job, and a shortened synthetic failed-retention deadline. Verify process exit, count inotify watches, and check one reap attempt per intended event. A separate stub that sleeps tests serialization and event responsiveness. Never aim this at the owner’s socket or use real tab IDs.

### E. Realistic pi history cost

Repeat the in-memory footer fixture at 1k/10k/100k entries using a host-faithful `getEntries()`/`getBranch()` implementation (including copying/traversal if the real host does that), plus branch switching/compaction. Measure CPU/heap allocations, not whole pi RSS. The successful test here used 50 changed-leaf updates, 50 unchanged-leaf updates and 500 renders per size, repeated three times, with an injected immediate Git result.

## Optional hardening

- **Display-only cache retention**, if a synthetic long-history census shows meaningful growth: prune old parity cache files outside the refresh hot path and bound watcher-log growth during a long-lived watcher run. Cost: retention policy, deletion tests and extra maintenance I/O. Never include reports/QA/native transcripts.
- **Async but serial watcher reap**, only if the slow-stub test demonstrates unacceptable delay. Cost: pending-reap state, event coalescing and shutdown/retry tests; no new service.
- **Incremental pi usage totals**, only if real long-session profiling shows the measured 100k-entry behavior matters. Cost: correct fork/compaction/session-reset handling. Ordinary 10k-entry measurements do not currently justify it.

**Scope:** **inside task** — read-only review and implementation advice. Actual edits must be dispatched separately. JOB-SCAN, M3B-FIX and the approved old-view cleanup keep their existing ownership. Any changed freshness contract, new retention policy affecting user data, or new process/service would need the orchestrator/owner; none is recommended here.
