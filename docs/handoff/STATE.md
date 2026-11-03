# State of the universal-hud effort (handoff to remote orchestration, 2026-11-03)

From 2026-11-03 development runs remotely: first Claude Code cloud (`docs/cloud/README.md`), then dots
(`docs/cloud/dots.md`). The local machine only does the work listed under "Local only". This file replaces the
local orchestrator's scratch notes. Keep it current: the remote orchestrator updates it whenever a package merges
or a decision is taken.

Read first: `CLAUDE.md`, `docs/delegation.md` (local routing, superseded remotely by the role table below),
`docs/universal-hud-engineering-plan.md` §1 and §4, `docs/universal-hud-concept.md` §15 (decision log),
`docs/handoff/integration-notes.md`.

## Remote roles

| Phase | Implementer | Oracle (architecture, design incl. frontend, review) |
|---|---|---|
| Claude cloud | per `docs/cloud/README.md` (Opus high for core and tests, Sonnet xhigh for rendering) | Opus max |
| dots | Astra high (all packages, frontend included) | Astra max |

Owner decision 2026-11-03: in the remote phases the Oracle also decides frontend design forks (locally that was a
Fable max subagent).

## Merging (changed 2026-11-03)

The remote orchestrator merges accepted packages into `universal-hud` itself; there is no local merge step any more.
Merge only when:
- the package's Oracle verdict is `accept`;
- the orchestrator has verified the report against the branch;
- the full check set in `docs/cloud/README.md` is green on the merged tree, with known flakes rerun alone and both
  runs recorded.

Rules for every merge:
- Use `--no-ff`; never force-push, never rewrite history, never commit to `main`.
- Only one environment merges at a time: whichever phase is active.
- After each merge, update this file and the plan §1 status line (`docs/universal-hud-engineering-plan.md`).

## Status

**Merged on `universal-hud`** (newest first):

- `docs/cloud` run-2 briefs: B10B-s3 and HYG1.
- B10B-s2, the delegation panel: cloud run 1. See `docs/cloud/handoff/b10b-s2.md`.
- B12M, metered recovery reads: cloud run 1, additive. See `docs/cloud/handoff/b12m.md`. B10D adopts it.
- B10b segment 1: the delegation presentation core, bar and statusline line 2.
- B10C:
  - the observation publisher, with production publishing **off**;
  - the native node `{title, kind}`;
  - the owner-approved worker route and split timing gates, recorded in contract 06 「B10C 增补」 and
    `docs/reviews/2026-11-02-astra-b10c-worker.md`.
- B10A: data and tick wiring.
- Earlier: batches 1–5, B13. See plan §1.

**Stopped, not accepted:** B10D, the observation worker. Branch `b10d-worker`, commit `4f2c4ac`, pushed as frozen work
in progress and NOT mergeable. It is based on `6fcf08a`, so merge `universal-hud` (`997c4ab` or later) into it before
any further work. That merge also brings in B10B-s2, which the panel needs to paint delegation content.

The final Oracle verdict is NOT ACCEPTED. Evidence is in `docs/handoff/b10d/`:
- `report.md`, which contains the Handoff section;
- `oracle-1.md`, the design rulings §1–§19;
- `oracle-review-1.md` and `oracle-review-2.md`;
- `performance-summary.json`.

What works:
- Worker isolation. Store stalls of several seconds no longer block paint.
- Legacy output stays byte-identical, with publication only in the worker and zero workers for CLI status/wait.
- 156/156 focused integration tests pass, and the full checks pass.

What fails, measured at n = 1000 per population on 200 nodes and 20,000 headers:

1. **Legacy collection.** The Codex subagent tree and file listing run on the main thread and cost about 85–132 ms
   per tick. This holds on today's synchronous path too: the matched synchronous reference already fails P-06-7 at this
   profile.
   - Bar paint p99 is 93–154 ms; bar operation p99 is 112–282 ms.
   - Simultaneous mixed: bar paint p99 168 ms (max 212 ms), full operation p99 253 ms (bar) and 338 ms (panel).
2. **Storage stalls.** A single `publishPrepared` call took 888 ms, giving an operation max of 1,184 ms. The worker
   keeps paint unaffected, but the operation gate fails.
3. **Liveness.**
   - The 16 reader slots fill with checkpoint-only recoveries, which hold no native reader yet. Full fair traversal plus
     the 15 s lease expiry can rebuild them repeatedly.
   - Large shares of the new-checkpoint and mixed populations fail with `reader_slots_pinned`: 791–920 of 1000.
   - The 30-minute paired soak's no-rescue drain left 166 of 200 targets unsettled after 5,000 operations.
   - §18 also pins accepted history that cannot be proven evictable, such as approval pauses and ended turns.
4. **Retirement recapture.** Progress evidence is still missing.

The Oracle's preferred next design (§19) is a one-use "next normal operation" continuation ticket. It needs the
owner's explicit fairness exception, because a normal round can approach twice the operation opportunities. Admission
and housekeeping tweaks alone are judged insufficient, and discard-and-reload is rejected.

The route question for the next Oracle is `docs/handoff/questions/B10D-route.md`. It covers what to do with legacy
collection, the reader cap against pinning, recapture, and whether and how B10D merges.

**Ready for the next remote run:**

- `docs/cloud/B10B-s3.md`: selection, navigation and control bar. It now bases on `universal-hud`, which contains
  B10B-s2.
- `docs/cloud/HYG1.md`: a clean test baseline on cloud hosts. Cloud `npm test` showed `b45-launch`,
  `hud-link-export` and `run-control` failing on unmodified code on Node 22.23.
- The B10D route ruling, then its follow-up packages.

**Remaining plan, phase B:**

- B10 segment 3 and the Inspector, per design §4.11 and §3.7.
- B14: the production acceptance and capability matrix. Mostly local, see below.
- B15: the phase review (ARCH).
- B3b-C: after B15.
- Phases C–F of the plan follow.

## Open owner decisions

- O1: the implementer-comparison B14 idle-cost runner. None of the three arms met the merge bar.
- Whether to rename the real project names `shenlun` / `atlas-launch-sources` used in some tests.
- Whether to rewrite git history to remove old private paths. Those commits are already public on `main`.
- B10D fairness exception (§19 continuation ticket): approve, or choose another route after the Oracle's ruling on
  `docs/handoff/questions/B10D-route.md`.
- Statusline wiring: nothing calls the statusline renderer yet. Candidates are a `hud statusline` entry, or plan D3.

## Local only (needs the owner's machine)

- Herdr integration tests (`npm run test:herdr`) and anything that creates or reads Herdr panes and tabs.
- Real-harness tests that need logged-in Codex or Claude CLIs: `B13_REAL=1`, the B45 real closures, and B14's
  real capability evidence (visible cc→Codex, resume, wake delivery).
- Jev / shared browser and the Hermes human-interaction tests.
- The final P-06-7 qualification on the supported WSL platform. Remote numbers are evidence for design, labelled with
  their host. They are not the formal qualification.
- Switching the live statusline (`claude-hud` replacement), and anything touching `~/.hud`, `~/.claude`, `~/.codex*` or
  `~/.pi`.

## Rules (unchanged)

These are in `docs/cloud/README.md` "Rules every agent keeps":

- The repo is public: synthetic data only.
- Tests use a temporary `HOME` and `HUD_HOME`.
- Only hud-mcp, hud-run and the reconciler write the ledger.
- Contracts and the design are the spec.
- Performance is acceptance.
- One review per change; at most two fix rounds, then ask the owner.
- Never stage `node_modules/.package-lock.json`.
