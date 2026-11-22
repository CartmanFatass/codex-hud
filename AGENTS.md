# MyHUD worker guide

MyHUD is one HUD for Claude Code, Codex and pi. The integration branch is
`universal-hud`; work in the worktree assigned by your brief.

## What to read

Repository guides (AGENTS.md, CLAUDE.md and the like) give you the project's rules; reading lists or workflows they address to the main session or orchestrator don't apply to you. The brief is your scope; read other docs only when the brief names them or the change needs them.

- Start with the brief and the files it names.
- Before changing code, read `docs/ARCHITECTURE.md` §8, “Rules every change keeps”.
- Follow the coding rules in the `CLAUDE.md` for the directory you change, if present.
- The main session owns planning and delegation. Skip `docs/handoff/STATE.md`,
  `docs/delegation.md`, the full `docs/spec.md` and archived docs unless the brief
  names them. Consult the relevant spec section for a product-boundary question.

## Working in this repo

- Use Node >=24.0.0; Node 24 is the tested line.
- Run tests with a temporary `HOME` and `HUD_HOME`, never against your real home.
  When the brief names `tmp/env.sh`, run commands through that wrapper from the worktree.
- Use synthetic data only in tests, fixtures, docs and logs. This repo is public.
- Preserve owner configuration and unrelated changes. Leave integration and
  pushes to the main session.
