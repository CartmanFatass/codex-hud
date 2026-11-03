# Design fork for the Oracle: what blocks B10D, and what to do about it

You are a fresh Oracle (design consultation, not a review). Read-only: write nothing; return
your answer as text (the orchestrator saves it to `docs/cloud/rulings/b10d-route.md`). Spawn no agents.

## Inputs

- B10D report `docs/handoff/b10d/report.md` (NOT ACCEPTED), its final review
  `oracle-review-2.md`, design rulings `oracle-1.md` and the §13–§18 follow-ups, and the measurements
  `performance-delivery.json` (all in `docs/handoff/b10d/`).
- The approved route: `docs/reviews/2026-11-02-astra-b10c-worker.md`; contract 06 「增量 tick 验收」 with the
  「B10C 增补」 (three gates, resource limits); design §6.
- Code: branch `b10d-worker` (uncommitted diff against `6fcf08a`).
  Legacy collection lives in `src/index.ts` / `src/tree-page.ts` / `HudStatus.build` and `src/collectors/subagent-tree.ts`.

## Facts

1. Legacy collection is pre-existing. On the same 200-node / 20,000-header profile, the matched synchronous reference
   (today's production path, no worker) measures, per 1,000-sample population (bar), in ms:

   | Population | Legacy collection p50 / p99 | Full operation p99 | Full operation max |
   |---|---|---|---|
   | no-change | 85 / 116 | 121 | 143 |
   | summary-only | 89 / 122 | 174 | 240 |
   | new-checkpoint | 92 / 123 | 152 | 172 |
   | mixed | 95 / 132 | 208 | 245 |

   So today's HUD already fails P-06-7 at this profile, before any worker. The worker version keeps legacy
   collection on the main thread, with today's accounting and byte-identical output (owner constraint, parity tests
   pass). It fails paint p99 (89–127 ms) and operation p99 (128–152 ms) mainly because of that collection.
2. The 16-reader cap against a correctness pin: after §18, readers of sessions that are not provably evictable
   (approval pauses, ended turns with a reusable turn timestamp, accepted partial tails) stay pinned. Legal trees with
   many such sessions can pin all 16 slots and starve the rest. The earlier 30-minute run ended with 16 pinned and 199
   waiting.
3. Recapture of evicted-owed retirement work: the review lacks evidence that it progresses without churn.

## Owner priorities (binding)

Lightweight and fast HUD, with performance as first-class as correctness. Everything bounded. Legacy output must not
change. Gates are not widened silently: any change to a gate or a supported profile is an explicit, recorded decision
for the owner.

## Decide

1. **Legacy collection.** Choose one, with the cost and ownership of each:
   - move it into the worker;
   - make it incremental (a watcher or cache, so a no-change tick does not rescan 20k headers);
   - classify the 20k-header legacy profile separately;
   - something else.

   Is it B10D's job, or a separate package (which files, who owns them)? Does B10D merge before it, behind a flag
   (publishing on or off), or not at all?
2. **Reader cap against pinning.** Choose one:
   - raise the cap (within which memory budget);
   - make pinned readers cheap (keep a compact checkpoint and drop the native reader);
   - prove more states evictable;
   - accept a declared limit.

   Give the acceptance test that shows no starvation for legal populations.
3. **Retirement recapture.** What evidence closes it, and is it a B10D fix or a follow-up?
4. **Merge decision for B10D now.** Choose one:
   - merge the worker with publishing on;
   - merge it with publishing off (worker unused in production);
   - keep it unmerged.

   Say what must be true for each, and what the next package list and order are (including B10B-s2's panel content,
   which is being built in parallel).

Give a decision, not a survey. Mark every change to contract 06, design §6 or a supported profile so the orchestrator
can put it to the owner.
