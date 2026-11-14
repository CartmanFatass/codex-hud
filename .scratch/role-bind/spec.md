# Roles apart from harnesses (0.1.4)

Owner 2026-11-14. Elaborates docs/spec.md §2 (CLI roles); the spec wins on any conflict.

## Why

A role file today fixes both the work (implementer, reviewer, sonic) and where it runs (pi, agy, grok, claude,
codex, model, thinking). Running the implementer elsewhere needs a new role name (`agy-imp`, `grok-imp`, ...), the
control plane lists 14 roles for a handful of jobs, CLI workers always get `implementer.md`, and `hud_create` can
change the model but not the harness.

## What changes

1. **A role is the work.** Role file: `role`, `instructions` (the pi-roles role for pi; `instructions/<name>.md` for
   a CLI), `can_continue`, `idle_grace_s`, and `run: { harness, agent?, model?, thinking? }` as its default place.
   Today's pi role files keep working (their `harness`/`pi_role`/model fields read as the default `run`).
2. **`hud_create` gets `on`** (`pi`, `agy`, `grok`, `claude`, `codex`): runs the role there for one job. Without a
   model, the harness default from a shipped table applies (agy gemini-4-argon-high, grok grok-4.7 high, claude
   opus high, codex gpt-6.1-sol high); `$HUD_HOME/harnesses.json` may override that table. `model`/`thinking`
   overrides work as today.
3. **A role runs on a CLI only if it has CLI instructions.** Shipped: `implementer.md` and a new read-only
   `reviewer.md`. `on` a CLI for a role without one answers `unsupported_harness` naming the missing file.
   `hud_roster` lists per role its default place and the harnesses it can run on.
4. **Deleted (owner approved 2026-11-14):** the role names `grok-imp`, `agy-imp`, `claude-imp`, `codex-imp` and
   their files; the hud-delegate skill, reference and release notes say `imp` with `on` instead.
5. **Control plane** groups rows: roles (one row each with the default place and `on` harnesses), browser tools
   (oracle, argon, gemini, flow, flow-video: unchanged, their provider is intrinsic), and harness availability.
6. `hud setup` unchanged: show/hide by role name; pi role tuning as today.

## Out of scope

Per-project default harness, CLI instructions for sonic or architect, any change to how a CLI or pi job runs once
started, Jev/browser roles.

## Tickets

01 role model, `on`, harness table, CLI instruction choice, reviewer.md, deletions, docs/skill (agy-imp,
gemini-4-hydrogen-high) · 02 control plane groups (frontend-implementer), after 01 and PROJECT-HUB 01.
