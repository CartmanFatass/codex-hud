# Agent guide (remote orchestration)

> **2026-11-05 cloud-development update:** See [the archived cloud handbook and revised C–F roadmap](docs/archive/cloud-development/README.md). Its development sequencing, simulation guidance and validation scope replace contrary blanket phase-order, local-only and every-package check requirements below. Applicable functional integration checks, security contracts and production capability gates remain in force; the historical record below is preserved.

> **2026-11-06 owner clarification:** [Project repair authorization](docs/archive/cloud-development/cloud-development.md#owner-clarification-project-repair-authorization-2026-11-06) supersedes earlier repair-count limits and count-triggered approval stops, including those repeated in historical briefs and reviews. Continue authorized in-scope repairs with fresh independent re-checks; substantive scope, contract, permission and safety boundaries, model roles and merge/production gates remain unchanged.

This repo is codex-hud, being turned into one HUD for Claude Code, Codex and pi. The product scope is concept §15,
"2026-11-07 Scope convergence: fixed roles, herdr execution, owned Jev": a fixed-role MCP facade, herdr for CLI
execution, an owned Jev runtime for browser jobs, and main-session chaining. **Current state is in `docs/handoff/STATE.md`; the R0–R7 queue it once held is archived in
`docs/handoff/archive/STATE-2026-11-03-to-11-14.md` and is not active (the owner reset the effort on 2026-11-10: `docs/spec.md` is the
boundary, `docs/delegation.md` the workflow).** Work happens on branch `universal-hud`. This file is the 2026-11-03 entry point for
remote agents (dots) and is kept as that history. `CLAUDE.md` holds the same project guide for Claude Code, plus local
routing that does not apply here.

## Read first

1. `docs/handoff/STATE.md`: current status and the owner's open questions (the old package queue, merge rules and local-only list are in the archive next to it).
2. `docs/archive/cloud/dots.md`: historical roles, loop, and prompts for subagents.
3. `docs/archive/cloud/README.md`: historical rules and check set. The Claude-specific tool names there (Agent
   tool, SendMessage) map to dots subagents.
4. `docs/ARCHITECTURE.md`: the two processes (bar `src/index.ts`, panel `src/tree-page.ts`), data collection,
   rendering, recipes, and §8, the rules every change keeps. What users see is in `docs/reference.md`.
5. Historical R0–R7 specs: `docs/archive/contracts/`, `docs/archive/design/hud-information-design.md`, and
   `docs/archive/root/universal-hud-concept.md` §15 (including the 2026-11-07 scope-convergence entry). The current boundary is `docs/spec.md`.

Directory notes live in `CLAUDE.md` files next to the code: `src/`, `src/collectors/`, `src/render/`,
`src/render/lines/` and `bin/`. Read the one for the directory you change.

## The main session only dispatches

The dots main session schedules, records and merges by rule. It makes no judgments. Every task goes to a subagent.

| Work | Who |
|---|---|
| Choose ready packages from STATE.md, start subagents, pass their outputs on, save reports and rulings, run check commands and record their raw output, merge when the rule below holds, update STATE.md | main session |
| Implementation and fixes | implementer subagent: Astra, effort high |
| Verifying a report against the branch, triaging review findings, design and architecture forks (frontend included), the final review, re-checks, the accept verdict | Oracle subagent: Astra, effort max, a fresh one each time |
| Anything that changes a contract, a gate, a supported profile, or a decision the owner reserved | the owner: write the question and the Oracle's recommendation to `docs/handoff/questions/<topic>.md`, then continue with other packages |

Merge rule: merge a package into `universal-hud` (`--no-ff`) only when all of these hold:
- its Oracle verdict is accept;
- the full check set is green on the merged tree, with known flakes rerun alone and both runs recorded.

After merging, push and update STATE.md. Never touch `main`, never force-push, never rewrite history, never stage
`node_modules/.package-lock.json`.

## Remote environment

- **Local-only work is skipped and recorded, never simulated.** That covers:
  - anything that needs Herdr, tmux, logged-in Codex/Claude/pi CLIs, Jev or the shared browser;
  - `npm run test:herdr`, `tests/integration/*real-tmux.sh`, `tests/probes/*.sh` and `B13_REAL=1`;
  - anything touching a real `~/.hud`, `~/.claude`, `~/.codex*` or `~/.pi`.
- `docs/delegation.md`, `tmp/tasks/` and Herdr pane names in older docs describe the former local setup.
- `.codegraph/` is not available. Search with grep.
- **Runtime:** Node >=24.0.0; Node 24 is the tested supported line (watcher behavior on Node 22 is not qualified). Run `npm ci` if `tsc` or `prettier` is missing.
- **Tests:** they use a temporary `HOME` and `HUD_HOME`. Performance numbers name the host and report the range over
  at least three runs; they are design evidence, not the formal WSL qualification.
- **Public repo:** fixtures, docs and logs use synthetic data only.
