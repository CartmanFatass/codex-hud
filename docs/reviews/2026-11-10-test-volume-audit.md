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

The cause is how the tests are specified, not how many features there are. Each feature is small; the test weight
per feature has grown.

1. **The orchestrator's test plans had a floor and no ceiling.** "The implementer may add tests, never drop one."
   Plans grew from about 10 items to about 40.
2. **The 2026-11-02 core-brief rule.** It asks for real-process tests of every failure scenario that reviewers use:
   crashes around commits, races, PID/PGID reuse, leftover processes, duplicate or out-of-order events, and p95 under
   concurrency. Briefs applied it far beyond process-owning code.
3. **Review rounds.** Every finding added a regression test, including edge cases built on purpose. R5UX-P2 ran
   five rounds on display-only work.
4. **Performance and cost tests run in the default suite.** They make up half of its time, and under load they become
   the flakes that later need reruns.
5. **Mutation checks and byte-identical protected tests on display work.** These make each case long.

## Rule adopted (orchestrator, 2026-11-10)

The rule is recorded in `docs/delegation.md` under "测试规范" (testing rules). It applies to every brief written from
today. Packages that are already running keep their plans.

**Plan size**
- A display test plan has at most 8 items.
- A safety test plan has at most 15 items.
- Each item maps to one done criterion.
- A larger plan needs a written reason in the brief.

**Real processes and mutation checks**
- Real-process tests are only for the core process, signal or lifecycle invariants of process-owning code: at most 3
  per package.
- Everything else uses pure functions or in-memory fakes.
- Mutation checks are only for safety work, and only for 1–2 key guards.

**Writing and adding tests**
- Variants of one behaviour go in one table-driven test, not in copied setups.
- Review findings get a regression test only for a defect on a realistic path or a safety path. A minor finding gets
  no test.
- A bug fix gets one reproduction test.
- The implementer may add tests within the same limits. A duplicate test may be removed with the orchestrator's
  approval.

**Size and time targets**
- New test lines should be at most 1.5× the changed source lines. The report explains anything over 2×.
- The default unit suite targets at most 3 minutes of wall time. A new test over 1 s needs a reason.

## Not yet done (needs a package)

- Move cost, performance and scale tests (over 5 s, p95, cold n = 20, 200-node, 5000-row) into an opt-in `perf`
  suite. That suite runs only for packages that touch those paths, and in a quiet window, not in every full run or
  merge gate.
- Remove duplicated cases and turn copied setups into tables in the largest files: `work-card-p2`, `job-materials`,
  `monitor`, `role-facade` and `run-light-leader`.
