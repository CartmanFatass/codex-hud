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

**In progress, not accepted:** B10D, the observation worker, on branch `b10d-worker` (pushed as work in progress, NOT
mergeable). Its implementer ran out of design latitude. The final review verdict is NOT ACCEPTED, for these reasons:

1. **Legacy collection.** The 20,000-header legacy collection, meaning the Codex subagent tree and file listing on the
   main thread, costs about 85–132 ms per tick even on today's synchronous path. So the paint and operation gates
   fail at that profile with or without the worker. The matched synchronous reference is in the B10D report.
2. **Reader pinning.** Readers that cannot be proven evictable stay pinned, so legal trees can exhaust the 16-reader
   cap and starve the rest.
3. **Retirement recapture.** There is no evidence yet that owed retirement work recaptured after eviction makes
   progress.
4. **Panel content.** Panel delegation content still needs B10B-s2 merged into the B10D branch.

The design question for the next Oracle is `docs/handoff/questions/B10D-route.md`. The B10D report, rulings and
reviews are under `docs/handoff/b10d/`.

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
