# R5 decided design (orchestrator, 2026-11-09)

Base: `tmp/tasks/R5/architect-1.md` (architect, astra high) plus the rulings in `qa/q1.answer.md` and
`qa/q2.answer.md`. Everything in architect-1.md applies **except the changes below**. Where this file and
architect-1.md disagree, this file wins.

## Split

R5 runs as two serial work packages, one implementer each, each closed by its own reviewer chain:

- **R5a = architect M1 + M2**: records, external registration, observation, pure composition into
  `SubagentTree`. No panel, render or summary changes. Delivered through tests on the pure composition and the
  collector.
- **R5b = architect M3 + M4**: panel wiring, presentation in existing slots, summaries/dry-run preservation,
  docs. Brief written after R5a merges.

## Changes to architect-1.md (what was cut or changed, and why)

1. **Jev liveness is file-only. No socket reads from the panel.** Cut `job-live-observation.ts`'s Jev wire
   adapter and the `resume:false, waitMs:0` read. Why: any IPC client into the runtime from the panel is a new
   coupling and a startup risk; the runtime already writes `$HUD_HOME/jev-runtime/runtime.json`
   (`{pid, startedAt}`, `src/jev/runtime/executor.ts` `writeRuntimeFile`). Liveness = that file is readable, its
   pid is alive, and `/proc/<pid>/cmdline` identifies the Jev runtime entry. Anything else = runtime not
   corroborated → non-terminal Jev jobs show last-known/stale. Job state comes from the job record files only.
2. **Herdr live sampling is one `herdr agent list` per live tick, not per-agent queries.** At most one call in
   flight, 5 s cadence, 250 ms bound, bounded output. The result is matched only against recorded agent names
   and recorded pane ids from associations / external records; it is never used to discover tasks or parents.
   Why: one bounded call covers every job; the per-agent fan-out (4 starts/refresh, 2 outstanding) is cost
   without benefit. If `herdr` is absent or the call fails: live state is uncorroborated (stale rules apply),
   nothing else changes.
3. **No `job-materials.ts` bridge (R5b).** On an admitted exact-ref dedupe the facade data **enriches the
   existing native node** (adds the optional `job` field) instead of replacing it: the native node keeps its id,
   `rolloutPath`, children and the existing production summary path untouched. Facade nodes with no native node
   keep id `role-job:<job>` and show summaries as unavailable (q2). Accepted cost: if a binding first appears
   mid-life, the display node switches from `role-job:<job>` to the native node once; labels/logs keyed on the
   old id are not migrated. Why: bound refs are rare (the facade writes them only from existing evidence) and the
   existing grants are narrow; a second material path is a contract-sized change for little display gain.
   This supersedes architect-1.md §7 "Summaries" bridge bullets and dedupe rule 3's "replaces the duplicate
   session row".
4. **Native SessionRef metadata from the facade (M1) only where the facade already holds a complete ref**
   (harness + sourceId + sessionId). Pi STATUS `session_id` without its source root is not enough; omit. Do not
   add launch-time work to obtain one.
5. **Bounds**: keep architect §6 constants as stated (128 discovery entries/refresh, 200 projection nodes,
   50 closed jobs / 30 days display-only pruning, per-file caps, 32 files / 1 MiB per slice, helper/QA maxima).
   Performance measurement (architect §9 last paragraph) belongs to R5b, where the panel is wired.
6. `hud panel --root` (architect §7) moves to R5b.

Kept as designed: identities, attachment rules, field ownership table, dedupe rules 1, 2, 4, 5, 6, requests,
results/effective status, freshness model, external `hud observe-herdr` registration and its record format,
`src/index.ts` import ban.

## Follow-ups recorded (not R5)

- Job-scoped material authority (q2).
- A writer-maintained per-root change stamp to make polling cheaper (architect "Optional hardening").
