# Test volume audit (2026-11-10)

The owner asked why the tests are larger than the source, when each approved feature is small, and whether the
orchestrator works to any limit on testing. This page records the measurements and the rule adopted in response.

## Measurements

**Size.** Source and tests in `src/`, `packages/` and `tests/`:

| Date | Source lines | Test lines |
|---|---|---|
| 2026-10-01 | 12.9k | 8.4k |
| 2026-11-10 | 123k | 173k (382 files) |

Tests are now 1.4× the source.

**Per merge.** Lines added in the last 16 merges:

| Package | Source + | Tests + | Tests / source | New cases |
|---|---|---|---|---|
| FIX-RLL-HANG | 11 | 833 | 76× | 12 |
| R5UX-P2 (display only) | 1436 | 7375 | 5.1× | 45 |
| R6A-A67 | 372 | 1071 | 2.9× | 15 |
| R6A-A2 | 280 | 735 | 2.6× | 14 |
| R6A-A0 | 969 | 2265 | 2.3× | 50 |
| R6A-A4 | 785 | 1401 | 1.8× | 17 |
| PIROLE PR3 | 1098 | 1302 | 1.2× | 34 |
| R5UX-P1 | 2617 | 2805 | 1.1× | 31 |
| R5UX-P3A | 2193 | 2123 | 1.0× | 46 |
| PIROLE PR1 (October) | 911 | 595 | 0.7× | 15 |

A new case averages 60–160 lines. Most of that is per-test setup: temporary homes, a fake herdr, a fake pi, and real
child processes.

**Test plans.** These are the numbered items in the orchestrator's briefs:
- R5A, R5B-CORE and PIROLE-PR1 (October): 8–10 items.
- R6A-A3: 25. PIROLE-PR4: 28. R6A-A5: 33. PIROLE-PR3: 41. R6A-A4 and R6A-A67: 43 each.

**Suite time.** From the gate log for the merge at 78a3f74:
- The unit suite has 4493 tests and takes 350 s of wall time, out of 1332 s of summed test time.
- 180 tests (4 %) take 1001 s (75 %) of that time.
- 52 tests over 5 s take 718 s (54 %). Almost all of them are cost, performance and scale tests: 200-node p95 renders,
  cold launches at n = 20, 5000 associations, and real timer and subreaper processes.

## Causes

Each feature is small. The test weight comes from how the tests were planned, not from the number of features.

1. **Every test plan started from one package's narrow scope.** Each brief had the package prove its own slice from
   scratch, with its own fixtures, instead of extending tests that already cover the behaviour. The same behaviour
   is therefore tested again by each package that touches it, and each package builds its own stand-ins:
   - three fake herdrs: `tests/fakes/herdr.mjs` (R2 role facade), `panel-herdr.mjs` (A3) and `pi-owned-herdr.mjs` (PR2);
   - four fake pis: `pi-role.mjs`, `pi-dispatch.mjs`, `pi-owned-worker.mjs` and `pi-package.mjs`;
   - 193 of the 370 unit files build their own temporary home with `mkdtemp`.
   This is the owner's diagnosis (2026-11-10), and the data supports it.
2. **The test plans had a floor and no ceiling** ("may add, never drop"). They grew from about 10 items to about 40.
3. **The 2026-11-02 core-brief rule.** It asks for real-process tests of every failure scenario that reviewers use,
   and briefs applied it far beyond process-owning code.
4. **Review rounds.** Every finding added its own regression test, often in a new place.
5. **Performance and cost tests run in the default suite.** They make up half of its time, and under load they
   become the flakes that later need reruns.

## Rule adopted (2026-11-10)

The rule is recorded in `docs/delegation.md`, "测试按项目范围设计" (design tests at project scope).

- **One project test map.** It lists the product behaviours, which test at which layer owns each one, and the shared
  stand-ins and fixtures. The layers are:
  - pure-logic unit tests;
  - contract tests at module boundaries;
  - a few real-process tests, only for process, signal and lifecycle code;
  - a few end-to-end product scenarios;
  - visual baselines;
  - WP0.
- **A brief's test plan extends the map.** It names the existing tests the package extends or updates. A new test
  exists only for a behaviour that has no owner yet, and it is entered in the map at the same time.
- **One shared set of stand-ins and fixtures.** When one lacks a capability, it is extended, not copied.
- **Review findings** add their regression test to the test that already owns the behaviour.
- **Numbers are signals, not caps.** Plan size, test lines per source line, slow tests and suite time are checked at
  acceptance for their cause.

## TEST-SLIM (approved by the owner, 2026-11-10)

The owner's assessment: the current tests are so redundant that they have lost their value. TEST-SLIM builds the
project test map, consolidates the stand-ins and fixtures, folds duplicated tests into their owning tests, and
moves the slow cost, performance and scale tests into an opt-in suite.

- Move cost, performance and scale tests (over 5 s, p95, cold n = 20, 200-node, 5000-row) into an opt-in `perf`
  suite. That suite runs only for packages that touch those paths, and in a quiet window, not in every full run or
  merge gate.
- Remove duplicated cases and turn copied setups into tables in the largest files: `work-card-p2`, `job-materials`,
  `monitor`, `role-facade` and `run-light-leader`.

## TEST-SLIM-0 result and the owner's decision (2026-11-10)

**What stage 0 delivered.** The project test map `docs/testing.md` (draft, 190 behaviours), a 400-file inventory and
a consolidation proposal (`docs/reviews/2026-11-10-test-slim-0-proposal.md`). The review ended after two rounds; the
routing corrections made after round 2 were not re-reviewed, so the map is a draft that each slice corrects.

**Baseline.** Default suites 801 s wall, about 1.2 GB peak RSS, with 1 known timing failure.

**Why the proposal is so small.** It estimates only about 2% fewer lines. The brief forbade removing any assertion or
coverage line that only one test held, and almost every narrow test pins some internal detail.

**Owner decision: cut by behaviour.**
- **Keep:**
  - each behaviour's owning test (named in the map);
  - module-boundary contract tests;
  - one test per critical guard: authorization, consent, process/lifecycle and data integrity.
- **Delete:**
  - tests that only pin internal details;
  - tests that re-prove what an owning test proves;
  - per-variant copies, which become table rows;
  - review-round display edge cases.
- **Coverage.** Losing direct coverage of some branches is acceptable. Lost lines in critical modules are listed and
  justified per slice.
- **Unchanged.** WP0 and the visual baselines stay frozen.
- **Process.** Area by area, each slice reviewed. Target roughly 30–50% fewer lines per area.

**Order.**
1. TS1a: opt-in perf suite. TS1b: shared stand-ins and the HUD home fixture. These two run in parallel.
2. Area slices, two at a time: materials; roles and roster; owned execution; panel and Work; release and package;
   Jev, ledger and MCP; the rest.
