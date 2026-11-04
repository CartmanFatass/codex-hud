# RUNZ1 implementer report

Status: **WIP / NOT ACCEPTED / NOT MERGEABLE**. Published implementation is reviewable, but the complete README check set is not green in this executor. No acceptance, contract, supported-profile or merge gate is relaxed.

## Branch and scope

- Repository: CartmanFatass/codex-hud; branch: `dots/runz1`.
- Base: `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9` (`universal-hud`).
- Initial WIP commit: `f8887b37a31aa9b03ef02dc795f4f75e66d80171`.
- Final head: `2eb08fbd091a44b77bbaa3761c68ae8b11688778`, remotely verified on `dots/runz1`. Normal descendant of the initial WIP commit; six files, 994 additions and 34 deletions against base.
- Published through GitHub tree/commit/ref APIs with an expected-head lease and `force: false`; the local branch was then fast-forwarded to the same remote commit. No unrelated files were staged.
- Only six files differ from the base: `src/core/run/process.ts`, new direct helper `src/core/run/process-census.ts`, the two expressly authorized paragraphs in `src/core/run/README.md`, new `tests/unit/runz1-process.test.ts`, new `tests/unit/runz1-fixture.py`, and new `tests/int/runz1-perf.mjs`.
- No main changes, merge, force push, history rewrite, local-only work, new observer, polling loop, launch topology change, or scope/schema change. The npm-created `node_modules/.package-lock.json` worktree change is deliberately excluded from publication.

## Implementation and API

`proveGroupGone` retains the existing kernel-ESRCH route and adds the conservatively corroborated own-session route specified by the rulings. It now has an optional fourth test-seam argument, `ZombieProofOptions`, with `access` and bounded `afterSnapshot`; ordinary production callers remain unchanged.

A dedicated common original-subject check validates harness and every launcher, including the required original group leader, before either success route. A matching Z/X TGID must have one remaining task with the same complete identity, terminal state and membership. Task/list/stat ambiguity fails closed. Kernel-confirmed absence and unambiguous replacement remain valid. Original subjects are checked even if they escaped the target PGID/SID. General `processState` semantics remain unchanged.

The alternative requires structural SID = PGID = original group-leader PID; complete same-domain procfs visibility; two strict full PID/start/boot/domain censuses; no new or reused identity anywhere in census 2; and terminal same-session members corroborated from census 1 with whole-thread-group checks. Every enumerated stat failure, including ENOENT/ESRCH, invalidates it. The visibility witness checks the active procfs mount, known nonrestrictive options, domain, and metadata overmounts, and is checked again after both scans. Unknown/restricted visibility declines this route.

Visible scopes sharing the terminal SID stay unknown and hold their slots while zombies hold the target PGID. They may finish by ESRCH without requiring unrelated processes in the terminal session to end. No alternative-proof host census or own-session restriction was added to ESRCH.

The helper exports strict parsing, census/task predicates and visibility validation for direct production use and focused tests/measurements. Successful zombie completion performs the existing group inspection plus two additional strict censuses. Caller-owned permanent submission-channel sealing is unchanged.

## Decisions followed

1. RUNZ1 scope ruling: choice A for shared-session visible scopes; full-census strengthening, whole-session corroboration, thread-group evidence, complete procfs visibility, no new polling.
2. Fresh RUNZ1 ESRCH ruling: common stronger original-harness/launcher termination prerequisite on both success paths; preserve global `processState` and ESRCH route isolation.
3. README scope ruling: exactly the two authorized scope-proof paragraphs corrected; no other README cleanup.
4. WIP-publication ruling: publish ordinary branch commits marked NOT ACCEPTED / NOT MERGEABLE after recording actual check results; executor failures do not waive gates.

## Tests and meaningful failure evidence

New Linux fixtures use only owned synthetic children/threads, temporary HOME/HUD_HOME, bounded transitions and cleanup. Fixtures retain zombies deliberately; no real harness, user session, tmux or Herdr instance is involved.

The 24 new RUNZ1 cases include:
- True zombie-only own-session completion while `kill(-pgid, 0)` still succeeds.
- Fork after first census snapshot; same-session outsider joining a zombie-held PGID.
- Fork after second snapshot followed by setsid, leaving a live original-session grandchild.
- Zombie TGID with a live sibling.
- New/reused full-census identities, including outside-session reuse, read failures, malformed stat, restricted/unknown visibility and remount witness change.
- Escaped original harness and escaped supplied launcher: genuine target-group ESRCH with a Z TGID and live sibling elsewhere remains false; after whole-process termination it becomes true. One escape creates a different SID.
- Missing/malformed/inconsistent task visibility/count/identity; absent/replaced originals; wrong boot/domain.
- Visible zombie-held negative and visible ESRCH positive despite an unrelated living session outsider.
- Production `HeadlessRunControl.reconcile` integration retains uncertain state and held slot on failed proof, then ends and releases the slot after valid evidence. No terminal receipt is fabricated.

The second-boundary regression initially refused safely before reaching scan 2 when unrelated parallel tests caused census churn. The test-only follow-up retries a bounded number of fresh synthetic fixtures, cleans every attempt, and still requires both boundaries and the live escaped grandchild; every attempted proof must remain false. No production retry or relaxed assertion was added.

Mutation checks used generated JS copies, not production source edits:
- Removing the alternative proof fails the true-zombie positive.
- Replacing the full-host identity restriction with session-only filtering fails the real fork/setsid race (`true !== false`), including after the test-harness follow-up.
- Removing whole-thread-group checking fails the live-sibling/subject cases.
- Bypassing visibility evidence fails the visibility case.
- Restoring the former `processState === dead` common precondition fails both escaped harness and launcher `proveGroupGone` regressions (`true !== false`).

## Verification commands and environment

Host `d14215e6cbaa`, Linux 6.18.57 x86_64, Node v24.22.1. Tests used a fresh temporary HOME/HUD_HOME. `TMPDIR` was an executor-owned overlayfs directory: the default `/tmp` is tmpfs and does not meet the existing B12D native-disk test prerequisite. No assertions or product behavior were changed to accommodate this.

Commands run:

```
npm run build && npm run build:test && npm run build:hud-mcp
node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js
env -u NO_COLOR -u FORCE_COLOR HOME="$TEST_HOME" HUD_HOME="$TEST_HOME/hud" npm test
npm run test:core
npm run test:visual
npm run test:hud-mcp
npm run format:check
npm run check:fixtures
npm run test:mjs
git diff --check
```

Final-source check results (all output retained):

| Check | Actual result |
|---|---|
| All three builds | PASS, rc 0 |
| RUNZ1 + run-control + run-process | 54/54 pass, zero skipped/fail/cancelled |
| Full `npm test` unit stage | FAIL, 2369 total: 2341 pass, 12 fail, 16 skipped, zero cancelled; unit-stage failure prevents automatic mjs stage |
| `test:core` | PASS, 210 total: 209 pass, 1 skipped |
| `test:visual` | PASS, 319/319 |
| `test:hud-mcp`, initial final-source run | FAIL, 84 total: 80 pass, 3 ledger_busy failures, 1 skipped |
| hud-mcp isolated failing suites | PASS: b20-advice 9/9; delegation 8/8 |
| `test:hud-mcp`, complete rerun | PASS, 84 total: 83 pass, 1 skipped |
| `format:check`, `check:fixtures`, `git diff --check` | PASS, rc 0 each |
| Explicit `test:mjs` | FAIL, 47 total: 32 pass, 15 fail, zero skipped/cancelled; synthetic Unix-socket failures |

The final 12 unit failures comprise four B19 AF_UNIX cases, three B3H missing proc-children cases, three ptrace audit cases and two helper-discovery assertions. All RUNZ1 and run-control cases also passed in the final parallel full-suite run. No ledger_busy or existing KILL timing failure recurred in that full unit run.

All previous output, including intermediate failures, is retained for review. Before the test-only follow-up, the focused set passed 54/54 (24 RUNZ1, 20 run-control, 10 run-process). A full run reported 2369 tests, 2339 pass, 14 fail, 16 skipped; two ledger_busy failures passed in isolated reruns (B11 CLI 20/20, B21 capacity 5/5). The exact initial-commit repeat reported 2337 pass, 16 fail, 16 skipped: the same failures plus the RUNZ1 boundary-coverage flake fixed above and an existing KILL timing assertion. That KILL case passed isolated (1/1); both outputs remain available.

Captured executor evidence establishes AF_UNIX `listen EPERM` for B19/socket-dependent synthetic mjs cases, ptrace TRACEME `EPERM` for three lightweight-leader cases, and missing `/proc/<pid>/task/<pid>/children` for B3H/helper-discovery cases. A requested escalated capability probe still failed creating AF_UNIX; no bypass was attempted. The two waiter/forwarder discovery assertions report missing targets, consistent with the absent children interface, but are not misreported as independently proven ptrace failures.

Required real tmux/Herdr/logged-in CLI and installation/user-home operations were skipped as local-only, never simulated. Synthetic fake-Herdr mjs tests were run and their socket failures are recorded. No CI workflow run or commit status exists for the final published SHA (both totals 0); publication is not CI acceptance. The remote comparison confirms two ordinary commits ahead of base, zero behind, and exactly the six listed files.

## Performance evidence

Command: `node tests/int/runz1-perf.mjs`, after `npm run build`, repeated three times with temporary HOME/HUD_HOME. Same host/runtime above. Each population has n = 1000 measured samples after 100 warmups; wall-clock `performance.now`, nearest-rank percentiles, sequential populations, no explicit GC. Full proof includes common termination checks for three supplied subject stamps (two unique processes), existing inspection, and, for the zombie alternative, both strict censuses plus visibility/task checks. Quiet census size was 6; independent owned fork churn increased observed census size to 8. Conservative refusals are counted, not removed from timing populations.

Milliseconds (p50 / p99):

| Population | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| Full zombie alternative | 0.943839 / 9.541911 | 0.954883 / 7.478136 | 0.974898 / 5.680556 |
| One additional complete census | 0.077315 / 0.440493 | 0.074430 / 0.294155 | 0.079358 / 0.161189 |
| Full ESRCH route | 0.162651 / 3.260825 | 0.144655 / 0.721161 | 0.143052 / 1.299358 |
| Full alternative under unrelated churn | 0.988234 / 6.114980 | 0.973756 / 6.726850 | 1.026830 / 4.732156 |

Quiet alternative and ESRCH refusals: 0/1000 in every run. Churn refusals: 67/1000, 77/1000, 96/1000. Raw JSON also records p95, maxima and the existing-inspection comparison. These are cloud design evidence, not formal WSL qualification or a relaxed performance gate.

## Open acceptance items

- Fresh independent Oracle verification/review against the final published branch and recorded rulings/output.
- Green full README check set in an authorized executor supporting required AF_UNIX, ptrace and proc children behavior; retain all failing evidence and isolated reruns.
- Dispatcher records this report and all rulings in the authorized documentation paths. Do not merge or mark accepted while these requirements remain unmet.
