# Agent guide (remote orchestration)

> **2026-11-05 cloud-development update:** See [the current cloud handbook and revised C–F roadmap](docs/cloud-development/README.md). Its development sequencing, simulation guidance and validation scope replace contrary blanket phase-order, local-only and every-package check requirements below. Applicable functional integration checks, security contracts and production capability gates remain in force; the historical record below is preserved.

This repo is codex-hud, being turned into one HUD for Claude Code, Codex and pi, with a delegation MCP (`hud-mcp`) and
a run supervisor (`hud-run`). Work happens on branch `universal-hud`. From 2026-11-03 it is developed remotely; this
file is the entry point for remote agents (dots). `CLAUDE.md` holds the same project guide for Claude Code, plus local
routing that does not apply here.

## Read first

1. `docs/handoff/STATE.md`: current status, the package queue, merge rules, owner questions, local-only work.
2. `docs/cloud/dots.md`: roles, the loop, and the prompts for subagents.
3. `docs/cloud/README.md`: rules every agent keeps and the check set. The Claude-specific tool names there (Agent
   tool, SendMessage) map to dots subagents.
4. `docs/ARCHITECTURE.md`: the two processes (bar `src/index.ts`, panel `src/tree-page.ts`), data collection,
   rendering, recipes, and §8, the rules every change keeps. What users see is in `docs/reference.md`.
5. The binding specs: `docs/contracts/01–07`, `docs/design/hud-information-design.md`, and
   `docs/universal-hud-concept.md` §15 (the decision log).

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
  - `install.sh` and `uninstall.sh`;
  - anything touching a real `~/.hud`, `~/.claude`, `~/.codex*` or `~/.pi`.
- `docs/delegation.md`, `tmp/tasks/` and Herdr pane names in older docs describe the former local setup.
- `.codegraph/` is not available. Search with grep.
- **Runtime:** Node 22 ≥ 22.13 or Node 24 (`node:sqlite`). Run `npm ci` if `tsc` or `prettier` is missing.
- **Tests:** they use a temporary `HOME` and `HUD_HOME`. Performance numbers name the host and report the range over
  at least three runs; they are design evidence, not the formal WSL qualification.
- **Public repo:** fixtures, docs and logs use synthetic data only.
